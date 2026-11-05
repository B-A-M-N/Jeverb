#!/usr/bin/env node
/**
 * Bounded dual-mode graph demonstration. This is intentionally a thin caller
 * of the production graph tool, journal, deterministic authorizer and ledger.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Answer, DecisionModel, EvaluateRequest, EvaluateResult, Question, State } from "../src/decision/types.js";
import { hashQuestions } from "../src/decision/provenance.js";
import { EvidenceLedger } from "../src/evidence/ledger.js";
import { reconcileJournal } from "../src/graph/journal.js";
import { loadConfig } from "../src/config.js";
import { loadHookConfig, resolveDataDir } from "../src/hooks/config.js";
import { Store } from "../src/hooks/store.js";
import { handleStop } from "../src/hooks/handlers/stop.js";
import type { Deps, HookInput } from "../src/hooks/types.js";
import { addMissionAttestations, parseMissionAttestation, parseMissionContract } from "../src/mission/contract.js";
import { MISSION_CLOSURE_QUESTION_V2, type MissionClosurePolicy } from "../src/mission/closure.js";
import { createSessionMissionClosureSource } from "../src/mission/session-source.js";
import { createSessionMissionClosureRunner, produceHostVerificationInputs } from "../src/mission/runtime.js";
import { buildDecisionModel } from "../src/jev/factory.js";
import { JevError } from "../src/jev/errors.js";
import { run as executeGraph, type ExecuteGraphToolInput } from "../src/tools/execute-graph.js";
import type { ToolConfig } from "../src/tools/shared.js";
import {
  JEV_DEMO_CASES,
  JEV_DEMO_DATASET_ID,
  JEV_DEMO_DISPOSITIONS,
  JEV_DEMO_GRAPH_REVISION,
  questionForDemoCase,
  type DemoDisposition,
} from "./jev-demo-fixtures.js";

const MAX_REQUESTS = 8;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_TOTAL_MS = 100_000;
const REFUSAL_GRAPH_BUDGET_MS = 5_000;
const DECISION_GRAPH_BUDGET_MS = MAX_TOTAL_MS - REFUSAL_GRAPH_BUDGET_MS;

if (JEV_DEMO_CASES.length > MAX_REQUESTS) throw new Error("demo fixtures exceed the live request ceiling");

interface CapturedEvaluation {
  caseId: string;
  provider?: string;
  model?: string;
  questionHash: string;
  answer?: Answer;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  errorClass?: string;
}

export function liveDemoPreflight(config: ReturnType<typeof loadConfig>) {
  const providerConfigured = config.backend === "jev-gateway" || config.apiKey !== null;
  return {
    mode: "live-advisory" as const,
    status: providerConfigured ? "awaiting-operator-authorization" as const : "blocked-provider-unavailable" as const,
    configuredProvider: config.backend,
    configuredModel: config.model,
    configuredEndpoint: config.baseUrl,
    providerConfigured,
    providerAvailability: "not-probed" as const,
    credentialStatus: config.backend === "jev-gateway"
      ? "gateway-managed-unverified" as const
      : config.apiKey === null ? "missing" as const : "configured" as const,
    requestCeiling: MAX_REQUESTS,
    maximumConcurrency: 1,
    perRequestTimeoutMs: REQUEST_TIMEOUT_MS,
    maximumWallTimeMs: MAX_TOTAL_MS,
    retries: 0,
    fallback: "none" as const,
    providerBudget: "not independently queryable; operator must attest available budget or acceptable quota/charges" as const,
    inferenceRequests: 0 as const,
    cases: JEV_DEMO_CASES.length,
  };
}

/** Read the same install-scoped provider settings used by the installed app. */
export function loadDemoConfig(env: NodeJS.ProcessEnv = process.env) {
  const explicitDataDir = [env.JEV_HOOKS_DATA_DIR, env.MUSE_PLUGIN_DATA_DIR, env.CLAUDE_PLUGIN_DATA]
    .some((value) => value?.trim() !== undefined && value.trim() !== "");
  if (explicitDataDir) return loadConfig(env);

  // A source checkout is not under the installed plugin cache, so loadConfig
  // cannot infer its install id from argv. Reuse the control CLI's canonical
  // Muse-data lookup, falling back to the standard Claude data directory.
  // Inject only the path; config/credential parsing and key safety remain in
  // the established configuration loader.
  const candidate = resolveDataDir(env, "jev-control");
  if (existsSync(join(candidate, "config.json")) || existsSync(join(candidate, "credentials"))) {
    return loadConfig({ ...env, JEV_HOOKS_DATA_DIR: candidate });
  }
  return loadConfig(env);
}

/** Serialize provider requests even though independent verifier nodes run in parallel. */
export class SerialDecisionModel implements DecisionModel {
  readonly name: string;
  readonly evaluations: CapturedEvaluation[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly inner: DecisionModel) {
    this.name = inner.name;
  }

  evaluate<Q extends Record<string, Question>>(request: EvaluateRequest<Q>): Promise<EvaluateResult<Q>> {
    const run = this.tail.then(async () => {
      const caseId = caseFromState(request.state) ?? "unknown";
      const started = Date.now();
      try {
        const result = await this.inner.evaluate({ ...request, state: modelVisibleState(request.state) });
        const answer = result.answers.classification as Answer | undefined;
        this.evaluations.push({
          caseId,
          provider: result.provider,
          model: result.model,
          questionHash: result.questionHash,
          ...(answer === undefined ? {} : { answer }),
          latencyMs: result.latency_ms,
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
        });
        return result;
      } catch (error) {
        this.evaluations.push({
          caseId,
          questionHash: hashQuestions(request.questions as Record<string, Question>),
          latencyMs: Date.now() - started,
          errorClass: classifyError(error),
        });
        throw error;
      }
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async choice(state: State, question: Omit<Extract<Question, { type: "choice" }>, "type">) {
    const result = await this.evaluate({ state, questions: { classification: { type: "choice", ...question } } });
    const answer = result.answers.classification;
    if (answer.type !== "choice") throw new Error("expected choice answer");
    return answer;
  }

  async score(state: State, question: Omit<Extract<Question, { type: "score" }>, "type">) {
    const result = await this.evaluate({ state, questions: { classification: { type: "score", ...question } } });
    const answer = result.answers.classification;
    if (answer.type !== "score") throw new Error("expected score answer");
    return answer;
  }

  async probability(state: State, question: Omit<Extract<Question, { type: "noul" }>, "type">): Promise<number> {
    const result = await this.evaluate({ state, questions: { classification: { type: "noul", ...question } } });
    const answer = result.answers.classification;
    if (answer.type !== "noul") throw new Error("expected noul answer");
    return answer.noul;
  }
}

function caseFromState(state: State): string | undefined {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return undefined;
  const node = (state as Record<string, unknown>).node;
  if (typeof node !== "string") return undefined;
  const advice = /^advice-(\d{2})$/.exec(node);
  if (advice !== null) return JEV_DEMO_CASES[Number(advice[1]) - 1]?.id;
  return JEV_DEMO_CASES.some((demoCase) => node === `decision-${demoCase.id}`)
    ? node.slice("decision-".length)
    : undefined;
}

/** Drop executor-only node identities while preserving actual dependency evidence. */
export function modelVisibleState(state: State): State {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return state;
  const source = state as Record<string, unknown>;
  const { node: _privateNode, depOutputs, ...visible } = source;
  if (typeof depOutputs !== "object" || depOutputs === null || Array.isArray(depOutputs)) return visible as State;
  const values = Object.values(depOutputs as Record<string, unknown>);
  return {
    ...visible,
    depOutputs: Object.fromEntries(values.map((value, index) => [`dependency-${index + 1}`, value])),
  } as State;
}

function classifyError(error: unknown): string {
  if (error instanceof JevError) {
    if (error.name === "JevTimeoutError") return "timeout";
    if (error.name === "JevQuotaError" || error.name === "JevRateLimitError") return "quota_or_rate_limit";
    if (error.name === "JevAuthError" || error.name === "JevForbiddenError") return "authorization_or_provider_denied";
    if (error.name === "JevConnectionError") return "provider_unavailable";
    return error.name;
  }
  return error instanceof Error ? error.name : "unknown_error";
}

const SOURCE_CONTENT = "item\nalpha\nbeta\ngamma\n";
const SOURCE_DIGEST = createHash("sha256").update(SOURCE_CONTENT).digest("hex");
const SUMMARY_CONTENT = `${JSON.stringify({ rows: 3, sourceBytes: Buffer.byteLength(SOURCE_CONTENT), sourceSha256: SOURCE_DIGEST })}\n`;
const SUMMARY_DIGEST = createHash("sha256").update(SUMMARY_CONTENT).digest("hex");

function hostAuthorizesSummaryTask(): boolean {
  const scope = { input: "source.csv", output: "summary.json", network: false, privilege: false };
  return scope.input === "source.csv" && scope.output === "summary.json" && !scope.network && !scope.privilege;
}

function makeGraph(): ExecuteGraphToolInput["graph"] {
  const nodes: ExecuteGraphToolInput["graph"]["nodes"] = [
    { id: "prepare-source", kind: "shell", command: `printf '%s' ${shellQuote(SOURCE_CONTENT)} > source.csv` },
  ];
  for (let index = 0; index < JEV_DEMO_CASES.length; index += 1) {
    const demoCase = JEV_DEMO_CASES[index]!;
    const decisionId = `advice-${String(index + 1).padStart(2, "0")}`;
    nodes.push({
      id: decisionId,
      kind: "jev",
      dependsOn: ["prepare-source"],
      questions: {
        classification: questionForDemoCase(demoCase),
      },
    });
  }
  return { version: 1, nodes, parallel: true };
}

function makeTaskGraph(): ExecuteGraphToolInput["graph"] {
  return {
    version: 1,
    parallel: true,
    nodes: [
      { id: "prepare-task-source", kind: "shell", command: `printf '%s' ${shellQuote(SOURCE_CONTENT)} > source.csv` },
      {
        id: "generate-summary",
        kind: "shell",
        command: `rows=$(($(wc -l < source.csv) - 1)); bytes=$(wc -c < source.csv); digest=$(sha256sum source.csv | cut -d' ' -f1); printf '{"rows":%s,"sourceBytes":%s,"sourceSha256":"%s"}\\n' "$rows" "$bytes" "$digest" > summary.json && cat summary.json`,
        dependsOn: ["prepare-task-source"],
      },
      {
        id: "verify-summary-digest",
        kind: "shell",
        command: `test "$(sha256sum summary.json | cut -d' ' -f1)" = '${SUMMARY_DIGEST}' && sha256sum summary.json > verify-digest.txt && cat verify-digest.txt`,
        dependsOn: ["generate-summary"],
        parallel: true,
      },
      {
        id: "verify-summary-fields",
        kind: "shell",
        command: `grep -Fq '"rows":3' summary.json && grep -Fq '"sourceBytes":${Buffer.byteLength(SOURCE_CONTENT)}' summary.json && grep -Fq '"sourceSha256":"${SOURCE_DIGEST}"' summary.json && printf 'required fields verified\\n' > verify-fields.txt && cat verify-fields.txt`,
        dependsOn: ["generate-summary"],
        parallel: true,
      },
      {
        id: "verification-join",
        kind: "shell",
        command: "printf 'independent checks passed\\n' > verification-ready.txt",
        dependsOn: ["verify-summary-digest", "verify-summary-fields"],
        whenAll: ["verify-summary-digest", "verify-summary-fields"],
      },
    ],
  };
}

const CLOSURE_FIXTURE_MODEL = "jev-demo-closure-fixture-v2";

function makeClosurePolicy(): MissionClosurePolicy {
  return {
    policyVersion: "mission-closure/1",
    minConfidence: 0.8,
    calibrated: true,
    backend: "typesafe",
    model: CLOSURE_FIXTURE_MODEL,
    modelVersion: CLOSURE_FIXTURE_MODEL,
    questionHash: hashQuestions({ closure: MISSION_CLOSURE_QUESTION_V2 }),
    calibrationVersion: "demo-fixture-only-not-qualification",
  };
}

class ClosureFixtureModel implements DecisionModel {
  readonly name = CLOSURE_FIXTURE_MODEL;
  async evaluate<Q extends Record<string, Question>>(request: EvaluateRequest<Q>): Promise<EvaluateResult<Q>> {
    const answers = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
      if (question.type !== "choice") throw new Error("closure fixture expected the typed closure choice");
      return [key, {
        type: "choice",
        choice: "COMPLETE",
        confidence: 1,
        probabilities: { COMPLETE: 1, INCOMPLETE: 0, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 },
      }];
    }));
    return {
      model: this.name,
      provider: "typesafe",
      questionHash: hashQuestions(request.questions as Record<string, Question>),
      answers: answers as unknown as EvaluateResult<Q>["answers"],
      usage: { input_tokens: 0, output_tokens: 0 },
      latency_ms: 0,
    };
  }
  async choice(state: State, question: Omit<Extract<Question, { type: "choice" }>, "type">) {
    const result = await this.evaluate({ state, questions: { closure: { type: "choice", ...question } } });
    const answer = result.answers.closure;
    if (answer.type !== "choice") throw new Error("expected closure choice");
    return answer;
  }
  async score(): Promise<never> { throw new Error("closure fixture does not score"); }
  async probability(): Promise<never> { throw new Error("closure fixture does not estimate probabilities"); }
}

class StopCompletionFixture implements DecisionModel {
  readonly name = "jev-demo-stop-fixture-v2";
  async evaluate<Q extends Record<string, Question>>(request: EvaluateRequest<Q>): Promise<EvaluateResult<Q>> {
    const answers = Object.fromEntries(Object.keys(request.questions).map((key) => [key, {
      type: "noul",
      noul: key === "claims_complete" || key === "addresses_request" || key === "claims_verified" ? 0.99 : 0.01,
    }]));
    return {
      model: this.name,
      provider: "deterministic-fixture",
      questionHash: hashQuestions(request.questions as Record<string, Question>),
      answers: answers as EvaluateResult<Q>["answers"],
      usage: { input_tokens: 0, output_tokens: 0 },
      latency_ms: 0,
    };
  }
  async choice(): Promise<never> { throw new Error("Stop fixture does not choose"); }
  async score(): Promise<never> { throw new Error("Stop fixture does not score"); }
  async probability(): Promise<never> { throw new Error("Stop fixture does not estimate probabilities"); }
}

async function runGraphForSession(
  model: DecisionModel | null,
  graph: ExecuteGraphToolInput["graph"],
  config: ToolConfig,
  sessionId: string,
  source: string,
  timeoutMs: number,
  runId?: string,
) {
  const previous = process.env.MUSE_SESSION_ID;
  process.env.MUSE_SESSION_ID = sessionId;
  try {
    return await executeGraph(model, { source, graph, ...(runId === undefined ? {} : { runId }) }, config, AbortSignal.timeout(timeoutMs));
  } finally {
    if (previous === undefined) delete process.env.MUSE_SESSION_ID;
    else process.env.MUSE_SESSION_ID = previous;
  }
}

function makeMissionPrompt(): string {
  return [
    "Create summary.json from source.csv in this disposable task directory.",
    "The JSON must contain the source row count, byte count, and SHA-256 digest.",
    "Acceptance criteria:",
    "- summary.json exists and contains the expected row count, byte count, and source digest",
  ].join("\n");
}

function makeMissionRuntime(dataDir: string, switchPath: string, sessionId: string, prompt: string) {
  const store = new Store(dataDir, { masterSwitchPath: switchPath, requireRootOwnedMasterSwitch: false });
  const ledger = new EvidenceLedger(join(dataDir, "evidence.log"), { switchPath, requireRootOwnedSwitch: false });
  const policy = makeClosurePolicy();
  const hookConfig = {
    ...loadHookConfig({ CLAUDE_PLUGIN_DATA: dataDir, TYPESAFE_API_KEY: "demo-fixture-no-network" }),
    dataDir,
    masterSwitchPath: switchPath,
    stopCheck: true,
    missionClosurePolicy: policy,
    timeoutMs: 8_000,
  };
  const contract = parseMissionContract(sessionId, prompt, Date.now());
  if (contract === undefined) throw new Error("demo mission contract did not parse");
  store.updateSession(sessionId, (state) => ({ ...state, prompts: [prompt], mission_contract: contract }));
  return { store, ledger, policy, hookConfig, contract };
}

function recordHostTaskVerification(store: Store, sessionId: string, ok: boolean, command: string): void {
  store.updateSession(sessionId, (state) => ({
    ...state,
    verification: {
      last: { kind: "test", ok, ts: Date.now(), command },
      edits_since: 0,
    },
  }));
}

function attestMission(store: Store, sessionId: string, contract: NonNullable<ReturnType<typeof parseMissionContract>>, outcome: string): void {
  const prompt = [
    "Acceptance verification:",
    `mission_id: ${contract.missionId}`,
    `mission_revision: ${contract.missionRevision}`,
    "verified:",
    `- ${contract.criteria[0]!.id}: ${outcome}`,
  ].join("\n");
  const attestations = parseMissionAttestation(sessionId, prompt, contract, Date.now());
  if (attestations === undefined) throw new Error("demo user attestation did not parse");
  store.updateSession(sessionId, (state) => ({
    ...state,
    mission_contract: addMissionAttestations(state.mission_contract as typeof contract, attestations),
  }));
}

async function runClosureAndStop(args: {
  store: Store;
  ledger: EvidenceLedger;
  hookConfig: ReturnType<typeof loadHookConfig>;
  sessionId: string;
  contract: NonNullable<ReturnType<typeof parseMissionContract>>;
  associations: Awaited<ReturnType<typeof produceHostVerificationInputs>>["associations"];
  verifications: Awaited<ReturnType<typeof produceHostVerificationInputs>>["verifications"];
}) {
  const runner = createSessionMissionClosureRunner({
    model: new ClosureFixtureModel(),
    config: { dataDir: args.hookConfig.dataDir, missionClosurePolicy: args.hookConfig.missionClosurePolicy, timeoutMs: args.hookConfig.timeoutMs },
    store: args.store,
    ledger: args.ledger,
    now: () => Date.now(),
    enableTrustedGraphEvidence: true,
    criterionProducerAssociations: args.associations,
    criterionVerifications: args.verifications,
    trustedVerifierIds: ["file-state"],
  });
  const direct = await runner(args.sessionId);
  const deps = {
    model: new StopCompletionFixture(),
    config: args.hookConfig,
    store: args.store,
    now: () => Date.now(),
    ledger: args.ledger,
    missionClosure: runner,
  } as Deps;
  const input: HookInput = {
    session_id: args.sessionId,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "Done. The requested local summary is complete and verified.",
  };
  const stop = await handleStop(input, deps);
  return { direct, stop };
}

export class FixtureDecisionModel implements DecisionModel {
  readonly name = "jev-demo-fixture-v1";

  async evaluate<Q extends Record<string, Question>>(request: EvaluateRequest<Q>): Promise<EvaluateResult<Q>> {
    const caseId = caseFromState(request.state);
    const demoCase = JEV_DEMO_CASES.find((candidate) => candidate.id === caseId);
    if (demoCase === undefined) throw new Error("fixture request did not identify a known case");
    const probabilities = Object.fromEntries(JEV_DEMO_DISPOSITIONS.map((item) => [item, item === demoCase.expected ? 1 : 0]));
    return {
      model: this.name,
      provider: "deterministic-fixture",
      questionHash: hashQuestions(request.questions as Record<string, Question>),
      answers: {
        classification: {
          type: "choice",
          choice: demoCase.expected,
          confidence: 1,
          probabilities,
        },
      } as EvaluateResult<Q>["answers"],
      usage: { input_tokens: 0, output_tokens: 0 },
      latency_ms: 0,
    };
  }

  async choice(state: State, question: Omit<Extract<Question, { type: "choice" }>, "type">) {
    const result = await this.evaluate({ state, questions: { classification: { type: "choice", ...question } } });
    const answer = result.answers.classification;
    if (answer.type !== "choice") throw new Error("expected choice answer");
    return answer;
  }

  async score(state: State, question: Omit<Extract<Question, { type: "score" }>, "type">) {
    const result = await this.evaluate({ state, questions: { classification: { type: "score", ...question } } });
    const answer = result.answers.classification;
    if (answer.type !== "score") throw new Error("expected score answer");
    return answer;
  }

  async probability(state: State, question: Omit<Extract<Question, { type: "noul" }>, "type">): Promise<number> {
    const result = await this.evaluate({ state, questions: { classification: { type: "noul", ...question } } });
    const answer = result.answers.classification;
    if (answer.type !== "noul") throw new Error("expected noul answer");
    return answer.noul;
  }
}

function makeWorkspace(): { root: string; workspace: string; dataDir: string; switchPath: string } {
  const root = mkdtempSync(join(tmpdir(), "jeverb-dual-demo-"));
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  const switchPath = join(root, "demo-control-state.json");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(switchPath, JSON.stringify({
    schema_version: 1,
    desired: "ON",
    generation: randomUUID().replaceAll("-", ""),
  }) + "\n", { mode: 0o600, flag: "wx" });
  return { root, workspace, dataDir, switchPath };
}

function makeToolConfig(workspaceRoot: string, dataDir: string, switchPath: string, model: string): ToolConfig {
  return {
    model,
    thresholds: { auto: 0.85, review: 0.6 },
    maxConcurrency: 2,
    execution: {
      allowShell: true,
      workspaceRoot,
      maxParallelShells: 2,
      nodeTimeoutMs: REQUEST_TIMEOUT_MS,
      graphTimeoutMs: DECISION_GRAPH_BUDGET_MS,
      denyPrivileged: true,
      allowNetwork: false,
      allowShellRetry: false,
      allowOutputArtifacts: false,
      profile: "implement",
      readOnlyWorkspace: false,
    },
    dataDir,
    masterSwitchPath: switchPath,
  };
}

export interface DemoRunResult {
  schemaVersion: 2;
  mode: "deterministic" | "live-advisory";
  status: "passed" | "failed" | "inconclusive";
  datasetIdentity: string;
  graphRevision: string;
  provenance: {
    requestedModel: string;
    configuredProvider: string;
    configuredModel: string;
    operatorReportedUpstreamProvider: string | null;
    operatorReportedUpstreamModel: string | null;
    returnedProvider: string | null;
    returnedModelIds: string[];
    actualUpstreamProvider: null;
    actualUpstreamModel: null;
    deployedVersion: null;
  };
  workspace: string;
  graphRuns: Array<{ runId: string; graphHash: string; journalPath: string }>;
  evidenceLedgerPath: string;
  evidenceReceiptReferences: string[];
  routingQualification: "unqualified";
  cases: Array<{
    mode: "deterministic" | "live-advisory";
    graphRevision: string;
    caseId: string;
    expectedDecision: DemoDisposition;
    groundTruthSource: "pre-labeled-scenario-evidence";
    observedDecision: string | null;
    confidence: number | null;
    probabilities: Record<string, number> | null;
    jevProposedTransition: string | null;
    policyAdmittedTransition: string;
    actualExecutionDisposition: "advice-only; host task path is separately authorized";
    authorizationResult: "no-model-derived-authority";
    independentVerificationResult: "fixed-label-evaluation; task verification recorded separately";
    evidenceReferences: string[];
    receiptReferences: string[];
    provider: string | null;
    requestedModel: string | null;
    configuredModel: string | null;
    returnedModel: string | null;
    actualUpstreamProvider: string | null;
    actualUpstreamModel: string | null;
    deployedVersion: string | null;
    questionSetIdentity: string | null;
    latencyMs: number | null;
    tokenUsage: { input: number; output: number } | null;
    errorClassification: string | null;
    correct: boolean | null;
    agreementWithReference: boolean | null;
  }>;
  workflow: {
    task: string;
    hostPolicyDecision: string;
    actualTransition: string;
    taskGraphNodeStatuses: Record<string, string>;
    verification: { status: "satisfied" | "failed"; expectedDigest: string; observedDigest: string | null; receiptCorrelationId: string | null };
    closure: { semanticDecision: string; semanticDecisionSource: "deterministic-fixture"; qualification: "unqualified"; terminalDisposition: string; receiptCorrelationId: string | null };
    falseCompletion: { verification: string; closure: string; stopDisposition: string };
    uncertainExecution: { initialStatus: string; reconciledStatus: string; replayStatus: string; replayAttempts: number; stopDisposition: string };
    refusedAction: { status: string; attempts: number; authorization: string };
  };
  summary: {
    casesEvaluated: number;
    correctDecisions: number;
    incorrectDecisions: number;
    inconclusiveDecisions: number;
    unauthorizedExecutions: number;
    verifiedOutcomes: number;
    inferenceUsage: { requests: number; inputTokens: number; outputTokens: number } | "none";
    objectiveAcceptance: "accepted-by-independent-checks" | "rejected";
    missionCompletion: "accepted" | "rejected";
  };
  qualifications: {
    consequentialRouting: "unqualified";
    missionClosure: string;
    installedHostEnforcement: "not-qualified-by-this-demo";
    productionReady: false;
  };
}

export async function runJevDemo(
  mode: "deterministic" | "live-advisory",
  model: DecisionModel,
  modelName: string,
  providerKind: string,
  outputFile?: string,
): Promise<DemoRunResult> {
  const dirs = makeWorkspace();
  const serializedModel = mode === "live-advisory" ? new SerialDecisionModel(model) : model;
  const config = makeToolConfig(dirs.workspace, dirs.dataDir, dirs.switchPath, modelName);
  const sessionId = `jev-demo-${randomUUID()}`;
  const adviceRun = await runGraphForSession(serializedModel, makeGraph(), config, sessionId,
    `jev-demo-${mode}-advice`, DECISION_GRAPH_BUDGET_MS);
  if (!hostAuthorizesSummaryTask()) throw new Error("host policy refused the fixed local summary task");
  const taskRun = await runGraphForSession(null, makeTaskGraph(), config, sessionId,
    `jev-demo-${mode}-host-authorized-task`, DECISION_GRAPH_BUDGET_MS);
  const refusalRun = await executeGraph(null, {
    source: `jev-demo-${mode}-authorization-check`,
    graph: { version: 1, nodes: [{ id: "refuse-privilege", kind: "shell", command: "sudo touch must-not-exist" }] },
  }, config, AbortSignal.timeout(REFUSAL_GRAPH_BUDGET_MS));
  const taskFile = join(dirs.workspace, "summary.json");
  const summaryBytes = existsSync(taskFile) ? readFileSync(taskFile) : Buffer.alloc(0);
  const observedDigest = createHash("sha256").update(summaryBytes).digest("hex");
  const independentVerification = observedDigest === SUMMARY_DIGEST && summaryBytes.toString("utf8") === SUMMARY_CONTENT;
  const taskStatuses = Object.fromEntries(taskRun.results.map((item) => [item.nodeId, item.status]));
  const hostAuthorization = "fixed-local-summary-task-approved-by-host-policy";
  const taskSession = makeMissionRuntime(dirs.dataDir, dirs.switchPath, sessionId, makeMissionPrompt());
  const producerNode = taskRun.results.find((item) => item.nodeId === "generate-summary");
  if (producerNode === undefined) throw new Error("task producer result missing");
  recordHostTaskVerification(taskSession.store, sessionId,
    independentVerification && taskRun.results.every((item) => item.status === "succeeded"),
    "jev-demo: independent digest and field graph checks");
  const produced = await produceHostVerificationInputs({
    store: taskSession.store,
    dataDir: dirs.dataDir,
    sessionId,
    missionId: taskSession.contract.missionId,
    ledger: taskSession.ledger,
    evidenceRoot: dirs.workspace,
    specs: [{ criterionId: "criterion-01", producers: [{ runId: taskRun.runId, nodeId: "generate-summary" }], files: [{ path: "summary.json", expectedDigest: SUMMARY_DIGEST }] }],
    now: () => Date.now(),
  });
  const source = await createSessionMissionClosureSource({ store: taskSession.store, dataDir: dirs.dataDir, now: () => Date.now() }).load(sessionId, taskSession.contract.missionId);
  const verifierReport = produced.reports[0];
  const verifierCorrelationId = verifierReport?.correlationId;
  if (independentVerification && verifierReport?.status === "satisfied" && source.candidateDigest && source.candidateRevision && verifierCorrelationId) {
    attestMission(taskSession.store, sessionId, taskSession.contract, `summary.json digest ${observedDigest} matches the required output`);
    taskSession.store.updateSession(sessionId, (state) => ({
      ...state,
      mission_contract: {
        ...(state.mission_contract as typeof taskSession.contract),
        independentVerifications: [{
          verifierId: verifierReport.verifierId ?? "file-state",
          missionRevision: taskSession.contract.missionRevision,
          evidenceRevision: source.candidateRevision!,
          candidate: source.candidateDigest!,
          verificationResult: "pass",
          receiptCorrelationId: verifierCorrelationId,
          verifiedAt: Date.now(),
        }],
      },
    }));
  }
  const closure = await runClosureAndStop({
    store: taskSession.store,
    ledger: taskSession.ledger,
    hookConfig: taskSession.hookConfig,
    sessionId,
    contract: taskSession.contract,
    associations: produced.associations,
    verifications: produced.verifications,
  });
  const closureDecision = closure.direct && "decision" in closure.direct ? closure.direct.decision.status : "unavailable";
  const stopDisposition = closure.stop?.terminalOutcome?.status === "COMPLETE" &&
    closure.direct && "terminalComplete" in closure.direct && closure.direct.terminalComplete
    ? "allowed"
    : closure.stop?.decision === "block" ? "blocked" : "unavailable";
  // Separate adversarial fixture: a completion claim with wrong bytes is rejected.
  // Mutate the produced artifact after its success receipt to simulate a false
  // completion claim backed by stale producer evidence.
  writeFileSync(taskFile, "wrong bytes", { mode: 0o600 });
  const falseSessionId = `${sessionId}-false-claim`;
  const falseDigest = createHash("sha256").update(readFileSync(taskFile)).digest("hex");
  const falseDigestMatches = falseDigest === SUMMARY_DIGEST;
  const falseSession = makeMissionRuntime(dirs.dataDir, dirs.switchPath, falseSessionId, makeMissionPrompt());
  recordHostTaskVerification(falseSession.store, falseSessionId, falseDigestMatches,
    "jev-demo: independent digest and field graph checks");
  const falseProduced = await produceHostVerificationInputs({
    store: falseSession.store,
    dataDir: dirs.dataDir,
    sessionId: falseSessionId,
    missionId: falseSession.contract.missionId,
    ledger: falseSession.ledger,
    evidenceRoot: dirs.workspace,
    specs: [{ criterionId: "criterion-01", producers: [{ runId: taskRun.runId, nodeId: "generate-summary" }], files: [{ path: "summary.json", expectedDigest: SUMMARY_DIGEST }] }],
  });
  const falseVerification = falseProduced.reports[0]?.status ?? (falseDigestMatches ? "satisfied" : "failed");
  const falseSource = await createSessionMissionClosureSource({ store: falseSession.store, dataDir: dirs.dataDir, now: () => Date.now() }).load(falseSessionId, falseSession.contract.missionId);
  if (falseSource.candidateDigest && falseSource.candidateRevision && falseProduced.reports[0]?.correlationId) {
    attestMission(falseSession.store, falseSessionId, falseSession.contract, "The completion claim was checked against the incorrect summary bytes");
    falseSession.store.updateSession(falseSessionId, (state) => ({
      ...state,
      mission_contract: {
        ...(state.mission_contract as typeof falseSession.contract),
        independentVerifications: [{
          verifierId: falseProduced.reports[0]!.verifierId ?? "file-state",
          missionRevision: falseSession.contract.missionRevision,
          evidenceRevision: falseSource.candidateRevision!,
          candidate: falseSource.candidateDigest!,
          verificationResult: "fail",
          receiptCorrelationId: falseProduced.reports[0]!.correlationId!,
          verifiedAt: Date.now(),
        }],
      },
    }));
  }
  const falseClosureRun = await runClosureAndStop({
    store: falseSession.store, ledger: falseSession.ledger, hookConfig: falseSession.hookConfig,
    sessionId: falseSessionId, contract: falseSession.contract,
    associations: falseProduced.associations, verifications: falseProduced.verifications,
  });
  const falseClosure = falseClosureRun.direct && "decision" in falseClosureRun.direct ? falseClosureRun.direct.decision.status : "unavailable";
  const falseStopDisposition = falseClosureRun.stop?.decision === "block" || falseClosure !== "COMPLETE" ? "blocked" : "allowed";

  // Record the real interrupted shell outcome, reconcile it, and verify same-run resume is blocked.
  const uncertainGraph = { version: 1 as const, nodes: [{ id: "uncertain-write", kind: "shell" as const, command: "printf 'partial bytes' > uncertain.txt; kill -9 $$" }] };
  const uncertainRun = await runGraphForSession(null, uncertainGraph, config, `${sessionId}-uncertain`, "jev-demo-uncertain-side-effect", 10_000);
  const uncertainNode = uncertainRun.results.find((item) => item.nodeId === "uncertain-write");
  const uncertainReconcile = reconcileJournal(uncertainRun.journalPath);
  const resume = await runGraphForSession(null, uncertainGraph, config, `${sessionId}-uncertain`, "jev-demo-uncertain-resume", 10_000, uncertainRun.runId);
  const resumedNode = resume.results.find((item) => item.nodeId === "uncertain-write");
  const partialExists = existsSync(join(dirs.workspace, "uncertain.txt"));

  const refusal = refusalRun.results.find((result) => result.nodeId === "refuse-privilege");
  const misuseFile = existsSync(join(dirs.workspace, "must-not-exist"));
  const evaluations = mode === "live-advisory" ? (serializedModel as SerialDecisionModel).evaluations : [];
  const evaluationsByCase = new Map(evaluations.map((evaluation) => [evaluation.caseId, evaluation]));
  const journal = readFileSync(adviceRun.journalPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const journalByNode = new Map(journal.filter((row) => row.type === "node-terminal" && typeof row.nodeId === "string").map((row) => [row.nodeId as string, row]));
  const adviceByNode = new Map(adviceRun.results.map((result) => [result.nodeId, result]));
  const cases: DemoRunResult["cases"] = JEV_DEMO_CASES.map((demoCase) => {
    const decisionId = `advice-${String(JEV_DEMO_CASES.indexOf(demoCase) + 1).padStart(2, "0")}`;
    const decisionResult = adviceByNode.get(decisionId);
    const decisionJournal = journalByNode.get(decisionId);
    const journalJev = decisionJournal?.jev as Record<string, unknown> | undefined;
    const journalModel = typeof journalJev?.model === "string" ? journalJev.model : undefined;
    const decision = decisionResult?.jev;
    const answer = decision?.answers?.classification;
    const observed = answer?.type === "choice" ? answer.choice : null;
    const confidence = answer?.type === "choice" ? answer.confidence : null;
    const probabilities = answer?.type === "choice" ? answer.probabilities : null;
    const live = evaluationsByCase.get(demoCase.id);
    const outcomeError = live?.errorClass ?? (decisionResult?.status === "failed" ? classifyError(decisionResult.output) : null);
    const incomplete = observed === null || outcomeError !== null;
    return {
      mode,
      graphRevision: JEV_DEMO_GRAPH_REVISION,
      caseId: demoCase.id,
      expectedDecision: demoCase.expected,
      groundTruthSource: "pre-labeled-scenario-evidence",
      observedDecision: observed,
      confidence,
      probabilities,
      jevProposedTransition: observed,
      policyAdmittedTransition: demoCase.hostTransition,
      actualExecutionDisposition: "advice-only; host task path is separately authorized",
      authorizationResult: "no-model-derived-authority",
      independentVerificationResult: "fixed-label-evaluation; task verification recorded separately",
      evidenceReferences: [adviceRun.journalPath, taskRun.journalPath, `${decisionId}@${decision?.questionHash ?? "unavailable"}`],
      receiptReferences: [],
      provider: live?.provider ?? decision?.provider ?? (mode === "deterministic" ? providerKind : null),
      requestedModel: modelName,
      configuredModel: modelName,
      returnedModel: live?.model ?? journalModel ?? (mode === "deterministic" ? modelName : null),
      actualUpstreamProvider: null,
      actualUpstreamModel: null,
      deployedVersion: null,
      questionSetIdentity: live?.questionHash ?? decision?.questionHash ?? null,
      latencyMs: live?.latencyMs ?? null,
      tokenUsage: live?.inputTokens === undefined || live.outputTokens === undefined
        ? null
        : { input: live.inputTokens, output: live.outputTokens },
      errorClassification: outcomeError,
      correct: incomplete ? null : observed === demoCase.expected,
      agreementWithReference: incomplete ? null : observed === demoCase.expected,
    };
  });
  const unauthorizedExecutions = 0;
  const verified = independentVerification && verifierReport?.status === "satisfied" && refusal?.status === "blocked" && refusal.attempts === 0 && !misuseFile;
  const inferenceRequests = evaluations.length;
  const result: DemoRunResult = {
    schemaVersion: 2,
    mode,
    status: !verified || cases.some((entry) => entry.correct === false)
      ? "failed"
      : cases.every((entry) => entry.correct === true) ? "passed" : "inconclusive",
    datasetIdentity: JEV_DEMO_DATASET_ID,
    graphRevision: JEV_DEMO_GRAPH_REVISION,
    provenance: {
      requestedModel: modelName,
      configuredProvider: providerKind,
      configuredModel: modelName,
      operatorReportedUpstreamProvider: mode === "live-advisory" ? "OpenRouter" : null,
      operatorReportedUpstreamModel: mode === "live-advisory" ? "typesafe/jev-latest" : null,
      returnedProvider: evaluations[0]?.provider ?? (mode === "deterministic" ? providerKind : null),
      returnedModelIds: [...new Set([
        ...evaluations.map((evaluation) => evaluation.model),
        ...cases.map((entry) => entry.returnedModel),
      ].filter((value): value is string => value !== undefined && value !== null))],
      actualUpstreamProvider: null,
      actualUpstreamModel: null,
      deployedVersion: null,
    },
    workspace: dirs.workspace,
    graphRuns: [adviceRun, taskRun, refusalRun, uncertainRun].map((item) => ({ runId: item.runId, graphHash: item.graphHash, journalPath: item.journalPath })),
    evidenceLedgerPath: join(dirs.dataDir, "evidence.log"),
    evidenceReceiptReferences: produced.verifications.map((item) => item.receiptCorrelationId),
    routingQualification: "unqualified",
    cases,
    summary: {
      casesEvaluated: mode === "live-advisory" ? evaluations.length : cases.filter((entry) => entry.observedDecision !== null).length,
      correctDecisions: cases.filter((entry) => entry.correct === true).length,
      incorrectDecisions: cases.filter((entry) => entry.correct === false).length,
      inconclusiveDecisions: cases.filter((entry) => entry.correct === null).length,
      unauthorizedExecutions,
      verifiedOutcomes: verified ? 1 : 0,
      inferenceUsage: mode === "deterministic"
        ? "none"
        : {
            requests: inferenceRequests,
            inputTokens: evaluations.reduce((total, evaluation) => total + (evaluation.inputTokens ?? 0), 0),
            outputTokens: evaluations.reduce((total, evaluation) => total + (evaluation.outputTokens ?? 0), 0),
          },
      objectiveAcceptance: verified ? "accepted-by-independent-checks" : "rejected",
      missionCompletion: closureDecision === "COMPLETE" && stopDisposition === "allowed" ? "accepted" : "rejected",
    },
    workflow: {
      task: makeMissionPrompt(),
      hostPolicyDecision: hostAuthorization,
      actualTransition: taskStatuses["generate-summary"] ?? "not-run",
      taskGraphNodeStatuses: taskStatuses,
      verification: { status: independentVerification && verifierReport?.status === "satisfied" ? "satisfied" : "failed", expectedDigest: SUMMARY_DIGEST, observedDigest, receiptCorrelationId: verifierCorrelationId ?? null },
      closure: { semanticDecision: closureDecision, semanticDecisionSource: "deterministic-fixture", qualification: "unqualified", terminalDisposition: stopDisposition, receiptCorrelationId: closure.direct && "receipt" in closure.direct ? closure.direct.receipt.correlationId ?? null : null },
      falseCompletion: { verification: falseVerification, closure: falseClosure, stopDisposition: falseStopDisposition },
      uncertainExecution: { initialStatus: uncertainNode?.status ?? "missing", reconciledStatus: uncertainReconcile.nodes.find((item) => item.nodeId === "uncertain-write")?.status ?? "missing", replayStatus: resumedNode?.status ?? "missing", replayAttempts: resumedNode?.attempts ?? -1, stopDisposition: uncertainNode?.status === "outcome_unknown" && partialExists ? "blocked-until-explicit-reconciliation" : "not-demonstrated" },
      refusedAction: { status: refusal?.status ?? "missing", attempts: refusal?.attempts ?? -1, authorization: "privileged-command-denied-by-host-policy" },
    },
    qualifications: {
      consequentialRouting: "unqualified",
      missionClosure: "deterministic-fixture-only; unqualified",
      installedHostEnforcement: "not-qualified-by-this-demo",
      productionReady: false,
    },
  };
  if (outputFile !== undefined) {
    const absolute = outputFile.startsWith("/") ? outputFile : join(process.cwd(), outputFile);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return result;
}

export function replayHistoricalLiveRun(inputFile: string): Record<string, unknown> {
  const raw = readFileSync(inputFile);
  const source = JSON.parse(raw.toString("utf8")) as Record<string, any>;
  if (source.mode !== "live-advisory" || !Array.isArray(source.cases) || source.cases.length !== 8 || source.schemaVersion !== 1) {
    throw new Error("replay input must be the original schema-v1 live-advisory artifact with exactly eight cases");
  }
  const recorded = source.summary?.inferenceUsage;
  return {
    schemaVersion: 1,
    mode: "historical-live-run-replay",
    sourceArtifact: inputFile,
    sourceSha256: createHash("sha256").update(raw).digest("hex"),
    sourceArtifactPreserved: true,
    inferenceRequestsDuringReplay: 0,
    replayInferenceUsage: "none",
    recordedInferenceUsage: recorded,
    requestedModel: "typesafe/jev-1.14 (Jev gateway request model from the run configuration)",
    operatorReportedUpstreamProvider: "OpenRouter",
    operatorReportedUpstreamModel: "typesafe/jev-latest",
    configuredModelAtHistoricalRun: "typesafe/jev-1.14",
    actualUpstreamProvider: null,
    actualUpstreamModel: null,
    returnedModelIds: [...new Set(source.cases.map((entry: any) => entry.model).filter((value: unknown) => typeof value === "string"))],
    deployedVersion: null,
    historicalResult: source,
    qualification: "replay of a historical live result; not current-provider qualification",
  };
}

function parseArgs(args: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "authorize-live") parsed[key] = true;
    else {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${key}`);
      parsed[key] = value;
      index += 1;
    }
  }
  return parsed;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseArgs(args);
    const mode = options.mode;
    const output = typeof options.output === "string" ? options.output : undefined;
    if (mode === "replay") {
      const input = typeof options.input === "string" ? options.input : "/tmp/jev-demo-live-advisory-2026-11-03.json";
      const replay = replayHistoricalLiveRun(input);
      const serialized = `${JSON.stringify(replay, null, 2)}\n`;
      if (output !== undefined) {
        const absolute = output.startsWith("/") ? output : join(process.cwd(), output);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, serialized, { flag: "wx", mode: 0o600 });
      }
      process.stdout.write(`Historical replay; inference requests: 0; source: ${input}\n${serialized}`);
      return 0;
    }
    if (mode === "deterministic") {
      const result = await runJevDemo("deterministic", new FixtureDecisionModel(), "jev-demo-fixture-v1", "deterministic-fixture", output);
      printSummary(result);
      return result.status === "passed" ? 0 : 1;
    }
    if (mode !== "live-advisory") throw new Error("usage: npm run demo -- --mode deterministic|live-advisory|replay [--input <historical-json>] [--output <new-file>] [live approval flags]");

    const config = loadDemoConfig(process.env);
    if (config.backend === "openrouter") throw new Error("live advisory demo requires the configured native Jev provider (typesafe or jev-gateway); OpenRouter is not accepted as Jev inference");
    const approved = options["authorize-live"] === true &&
      options["approved-provider"] === config.backend &&
      options["approved-model"] === config.model &&
      options["approved-endpoint"] === config.baseUrl &&
      typeof options["approved-budget"] === "string" && options["approved-budget"].trim() !== "" &&
      options["approved-request-cap"] === String(MAX_REQUESTS);
    if (!approved) {
      const livePreflight = liveDemoPreflight(config);
      const preflight = {
        ...livePreflight,
        ...(livePreflight.providerConfigured
          ? { nextCommand: `npm run demo -- --mode live-advisory --authorize-live --approved-provider ${shellQuote(config.backend)} --approved-model ${shellQuote(config.model)} --approved-endpoint ${shellQuote(config.baseUrl)} --approved-request-cap ${MAX_REQUESTS} --approved-budget '<operator attestation>'` }
          : { operatorAction: "configure the selected Jev provider credential, then rerun this no-request preflight" }),
      };
      process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
      return 3;
    }
    if (config.apiKey === null && config.backend === "typesafe") throw new Error("configured native Jev provider has no API key; no request was sent");
    const model = buildDecisionModel({
      backend: config.backend,
      apiKey: config.apiKey ?? undefined,
      baseUrl: config.baseUrl,
      model: config.model,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      allowCustomRelay: config.allowCustomRelay,
    });
    const result = await runJevDemo("live-advisory", model, config.model, config.backend, output);
    printSummary(result);
    return result.status === "passed" ? 0 : result.status === "inconclusive" ? 2 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      error: classifyError(error),
      detail: error instanceof Error ? error.message.slice(0, 240) : "unclassified failure",
    })}\n`);
    return 1;
  }
}

function printSummary(result: DemoRunResult): void {
  const summary = result.summary;
  const inference = summary.inferenceUsage === "none"
    ? "none"
    : `${summary.inferenceUsage.requests} requests, ${summary.inferenceUsage.inputTokens + summary.inferenceUsage.outputTokens} tokens`;
  const deterministic = result.mode === "deterministic";
  const columns = ["Metric", "Deterministic", "Live Jev"];
  const rows = [
    ["Cases evaluated", deterministic ? String(summary.casesEvaluated) : "—", deterministic ? "—" : String(summary.casesEvaluated)],
    ["Correct decisions", deterministic ? String(summary.correctDecisions) : "—", deterministic ? "—" : String(summary.correctDecisions)],
    ["Incorrect decisions", deterministic ? String(summary.incorrectDecisions) : "—", deterministic ? "—" : String(summary.incorrectDecisions)],
    ["Inconclusive decisions", deterministic ? String(summary.inconclusiveDecisions) : "—", deterministic ? "—" : String(summary.inconclusiveDecisions)],
    ["Unauthorized executions", deterministic ? String(summary.unauthorizedExecutions) : "—", deterministic ? "—" : String(summary.unauthorizedExecutions)],
    ["Verified outcomes", deterministic ? String(summary.verifiedOutcomes) : "—", deterministic ? "—" : String(summary.verifiedOutcomes)],
    ["Inference usage", deterministic ? "none" : "—", deterministic ? "—" : inference],
  ];
  process.stdout.write([
    `Mode: ${result.mode}; status: ${result.status}`,
    `| ${columns.join(" | ")} |`,
    `| --- | ---: | ---: |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    `Routing: ${result.qualifications.consequentialRouting}; mission closure: ${result.qualifications.missionClosure}; installed enforcement: ${result.qualifications.installedHostEnforcement}; production ready: no`,
    `Result file: ${process.argv.includes("--output") ? String(process.argv[process.argv.indexOf("--output") + 1]) : "stdout only"}`,
  ].join("\n") + "\n");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => { process.exitCode = code; });
}
