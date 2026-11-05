#!/usr/bin/env tsx
/**
 * Mission-closure lockbox runner with three-stage scoring.
 *
 * Runs every case of a mission-completion lockbox dataset through
 * deterministic preflight, the semantic model alone, and the integrated
 * production path (`decideMissionClosure`), then reports per-stage tallies.
 * A model-only failure on a case production preflight already rejects is a
 * model weakness, not a production enforcement failure — this script keeps
 * the two (and the integrated outcome) in separate columns.
 *
 * The bench policy carries `calibrated: true` as an explicit measurement
 * premise (see src/jev/lockbox.ts): the integrated stage measures the
 * production path as if the model under test were the calibrated one.
 *
 * Usage:
 *   npx tsx scripts/jev-lockbox.ts bench/datasets/mission-completion-lockbox-v1.jsonl \
 *     --adapter-version <HOOK_VERSION> \
 *     --policy-version mission-closure/1 [--backend jev-gateway] [--model <id>] \
 *     [--adapter gateway|openrouter] [--model-version <served-id>] [--base-url <url>] [--fi] [--min-confidence 0.9] [--out <scores.jsonl>]
 *   OpenRouter defaults to typesafe/jev-latest and makes one request per call;
 *   one unscored identity probe pins the serving id when --model-version is
 *   omitted. If an explicit id differs, the run stops after that probe.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hashQuestions } from "../src/decision/provenance.js";
import { parseCalibrationDataset } from "../src/jev/calibration.js";
import { preflightMissionClosure, preflightReachedReview } from "../src/mission/closure.js";
import {
  lockboxLegacyEvidence,
  lockboxPolicy,
  scoreLockboxCase,
  summarizeLockbox,
  type LockboxCaseScore,
} from "../src/jev/lockbox.js";
import { HOOK_VERSION } from "../src/hooks/version.js";
import { isOpenRouterJevModel, OpenRouterDecisionModel, OpenRouterJevDecisionModel } from "../src/jev/openrouter.js";
import { JevGatewayDecisionModel } from "../src/jev/gateway.js";
import type { DecisionModel, EvaluateResult, State } from "../src/decision/types.js";
import { assertOutputPathAvailable, writeNewArtifact } from "./artifact-output.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const datasetPath = args[0];
if (!datasetPath) {
  console.error("usage: jev-lockbox.ts <dataset.jsonl> --model-version <v> --adapter-version <v> --policy-version <v> [options]");
  process.exit(2);
}
const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const adapter = flag("--adapter") ?? "gateway";
const defaultModel = adapter === "gateway" ? "typesafe/jev-1.14" : "typesafe/jev-latest";
const modelName = flag("--model") ?? defaultModel;
const requestedModelVersion = flag("--model-version");
let modelVersion = requestedModelVersion ?? modelName;
const adapterVersion = flag("--adapter-version");
const policyVersion = flag("--policy-version");
const backend = flag("--backend") ?? (adapter === "openrouter" ? "openrouter" : "jev-gateway");
const baseUrl = flag("--base-url");
const minConfidence = parseFloat(flag("--min-confidence") ?? "0.9");
const outPath = flag("--out");
if (outPath !== undefined) assertOutputPathAvailable(outPath);
if (!adapterVersion || !policyVersion) {
  console.error("jev-lockbox: --adapter-version and --policy-version are required");
  process.exit(2);
}
if (adapterVersion !== HOOK_VERSION) {
  console.error(`jev-lockbox: --adapter-version must match running hook version ${HOOK_VERSION}`);
  process.exit(2);
}
if (!Number.isFinite(minConfidence) || minConfidence <= 0 || minConfidence > 1) {
  console.error("jev-lockbox: --min-confidence must be in (0, 1]");
  process.exit(2);
}

const datasetText = readFileSync(datasetPath, "utf8");
const datasetRevision = createHash("sha256").update(datasetText, "utf8").digest("hex");
const cases = parseCalibrationDataset(datasetText);
if (cases.length === 0) {
  console.error("jev-lockbox: no cases in dataset");
  process.exit(2);
}
const questionHash = hashQuestions(cases[0]!.questions);
for (const c of cases) {
  if (hashQuestions(c.questions) !== questionHash) {
    console.error(`jev-lockbox: refusing — case ${c.id} uses a different question set; one run binds one question set`);
    process.exit(2);
  }
}

if (adapter !== "gateway" && adapter !== "openrouter") {
  console.error('jev-lockbox: --adapter must be "gateway" (production jev slot) or "openrouter" (separate provider identity; production use still requires its own verified qualification manifest)');
  process.exit(2);
}
const limit = process.env.CASE_LIMIT !== undefined ? parseInt(process.env.CASE_LIMIT, 10) : cases.length;
let model: DecisionModel;
if (adapter === "gateway") {
  model = new JevGatewayDecisionModel({
    model: modelName,
    baseUrl: baseUrl ?? "http://127.0.0.1:18769/jev",
  });
} else {
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) {
    console.error("jev-lockbox: OPENROUTER_API_KEY is not set");
    process.exit(2);
  }
  const useFi = process.argv.includes("--fi");
  const gatewayFetch: typeof fetch | undefined = useFi
    ? ((async (url: unknown, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("X-FI-Local-Client", "muse-code");
        return globalThis.fetch(url as string, { ...init, headers });
      }) as typeof fetch)
    : undefined;
  const openRouterOptions = {
    apiKey,
    model: modelName,
    // Keep a qualification run's request ceiling exact: no hidden retries.
    // Transport failures are recorded as misses and can be investigated on dev.
    maxRetries: 0,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(gatewayFetch === undefined ? {} : { fetch: gatewayFetch }),
  };
  model = isOpenRouterJevModel(modelName)
    ? new OpenRouterJevDecisionModel(openRouterOptions)
    : new OpenRouterDecisionModel(openRouterOptions);
}

let identityProbe: {
  caseId: string;
  provider: string;
  model: string;
  questionHash: string;
  requestId: string;
  usage: { input_tokens: number; output_tokens: number; cost_usd?: number };
  latencyMs: number;
  scored: false;
} | undefined;
if (adapter === "openrouter") {
  let probe: EvaluateResult;
  try {
    probe = await model.evaluate({ state: cases[0]!.state as State, questions: cases[0]!.questions });
  } catch (error) {
    console.error(JSON.stringify({
      event: "jev-lockbox-identity-probe-failed",
      provider: "openrouter",
      caseId: cases[0]!.id,
      errorClass: error instanceof Error ? error.name : "Error",
      callsConsumed: 1,
    }));
    process.exit(1);
  }
  if (probe.provider !== "openrouter" || probe.questionHash !== questionHash || probe.correlationId === undefined) {
    console.error(JSON.stringify({
      event: "jev-lockbox-identity-probe-invalid",
      provider: probe.provider,
      model: probe.model,
      questionHash: probe.questionHash,
      callsConsumed: 1,
    }));
    process.exit(1);
  }
  if (requestedModelVersion !== undefined && requestedModelVersion !== probe.model) {
    console.error(JSON.stringify({
      event: "jev-lockbox-serving-model-mismatch",
      requestedModel: modelName,
      expectedModelVersion: requestedModelVersion,
      observedModel: probe.model,
      requestId: probe.correlationId,
      questionHash: probe.questionHash,
      callsConsumed: 1,
    }));
    process.exit(1);
  }
  modelVersion = probe.model;
  identityProbe = {
    caseId: cases[0]!.id,
    provider: probe.provider,
    model: probe.model,
    questionHash: probe.questionHash,
    requestId: probe.correlationId,
    usage: probe.usage,
    latencyMs: probe.latency_ms,
    scored: false,
  };
}

const policy = lockboxPolicy(cases[0]!.questions, {
  policyVersion,
  minConfidence,
  backend,
  model: modelName,
  modelVersion,
});
if (policy.questionHash !== questionHash) {
  console.error("jev-lockbox: internal question-hash mismatch");
  process.exit(2);
}

const scores: LockboxCaseScore[] = [];
const observedModels = new Set<string>(identityProbe === undefined ? [] : [identityProbe.model]);
const maxLogicalRequests =
  (identityProbe === undefined ? 0 : 1) +
  cases.slice(0, limit).reduce((count, c) => count + 1 + Number(preflightReachedReview(preflightMissionClosure(lockboxLegacyEvidence(c.id, c.state), policy))), 0);
let stoppedEarly = false;
for (const c of cases.slice(0, limit)) {
  const score = await scoreLockboxCase(model, c, policy, datasetRevision, {
    stopAfterModelOnlyFailureOrBindingMismatch: adapter === "openrouter",
  });
  scores.push(score);
  observedModels.add(score.modelCall?.model ?? score.observedModel);
  if (adapter === "openrouter") {
    const returnedCalls = [score.modelCall, score.integratedCall].filter((call) => call !== undefined);
    const wrongIdentity = returnedCalls.find((call) =>
      call.provider !== "openrouter" || call.model !== modelVersion || call.questionHash !== questionHash,
    );
    if (wrongIdentity !== undefined) {
      console.error(`jev-lockbox: stopping after ${scores.length} case(s): provider, serving-model, or question binding mismatch`);
      stoppedEarly = true;
      break;
    }
    if (score.modelOnlyError !== undefined || score.integratedFailure !== undefined) {
      console.error(`jev-lockbox: stopping after ${scores.length} case(s): model or integrated judgment error`);
      stoppedEarly = true;
      break;
    }
    if (score.integratedComplete && score.expected !== "COMPLETE") {
      console.error(`jev-lockbox: stopping after ${scores.length} case(s): false integrated COMPLETE`);
      stoppedEarly = true;
      break;
    }
  }
}

const measuredCalls = [
  ...(identityProbe === undefined ? [] : [{ usage: identityProbe.usage, latencyMs: identityProbe.latencyMs }]),
  ...scores.flatMap((score) => [score.modelCall, score.integratedCall]
    .filter((call) => call !== undefined)
    .map((call) => ({ usage: call.usage, latencyMs: call.latencyMs }))),
];
const sortedLatencies = measuredCalls.map((call) => call.latencyMs).sort((a, b) => a - b);
const latencyAt = (quantile: number): number | undefined => sortedLatencies.length === 0
  ? undefined
  : sortedLatencies[Math.max(0, Math.ceil(sortedLatencies.length * quantile) - 1)];
const providerTelemetry = {
  responsesMeasured: measuredCalls.length,
  inputTokens: measuredCalls.reduce((sum, call) => sum + call.usage.input_tokens, 0),
  outputTokens: measuredCalls.reduce((sum, call) => sum + call.usage.output_tokens, 0),
  responsesWithReportedCost: measuredCalls.filter((call) => call.usage.cost_usd !== undefined).length,
  reportedCostUsd: Number(measuredCalls.reduce((sum, call) => sum + (call.usage.cost_usd ?? 0), 0).toFixed(12)),
  latencyMs: sortedLatencies.length === 0 ? undefined : {
    min: sortedLatencies[0],
    mean: Number((sortedLatencies.reduce((sum, value) => sum + value, 0) / sortedLatencies.length).toFixed(2)),
    p50: latencyAt(0.5),
    p95: latencyAt(0.95),
    max: sortedLatencies.at(-1),
  },
};

const summary = {
  dataset: datasetPath,
  datasetRevision,
  configuredModel: model.name,
  requestedModel: modelName,
  adapterVersion,
  modelVersion,
  backend,
  questionHash,
  policyVersion,
  minConfidence,
  ...(identityProbe === undefined ? {} : { identityProbe }),
  observedModels: [...observedModels].sort(),
  casesRun: scores.length,
  stoppedEarly,
  maxLogicalRequests,
  providerTelemetry,
  logicalRequestsConsumed:
    (identityProbe === undefined ? 0 : 1) +
    scores.reduce((count, score) => count + 1 + Number(
      score.integratedCall !== undefined ||
      (score.integratedOutcome === "unavailable" && score.preflightReady && score.modelOnlyError === undefined),
    ), 0),
  ...summarizeLockbox(scores),
};
console.log(JSON.stringify(summary, null, 2));
if (outPath !== undefined) {
  const rows = scores.map((s) => JSON.stringify({ ...s, dataset: datasetRevision, modelVersion, adapterVersion, backend, questionHash }));
  writeNewArtifact(outPath, rows.join("\n") + "\n");
  console.error(`scores: ${rows.length} rows -> ${outPath}`);
}
if (summary.stoppedEarly) process.exitCode = 1;
