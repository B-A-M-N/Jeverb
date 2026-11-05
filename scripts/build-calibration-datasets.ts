#!/usr/bin/env tsx
/**
 * Build the focused calibration case pools plus explicit development and
 * validation splits from the live rubrics. The `*-v1.jsonl` files retain the
 * combined case pools for coverage tests; qualification must use the
 * separately emitted development/heldout files.
 *
 * Question objects come straight from the modules under test
 * (`MISSION_CLOSURE_QUESTION`, `adversarialQuestionsFor`,
 * `STOP_QUESTIONS`, `NEXT_STEP_QUESTIONS`), so a rubric change alters the
 * emitted text and therefore the dataset revision hash — a changed rubric
 * automatically invalidates any calibration derived from the old text.
 * Only the `state` narratives and `expected` ground-truth labels below are
 * authored; they were established independently of Jeverb's own verdicts.
 *
 * Usage: npx tsx scripts/build-calibration-datasets.ts
 * Live run: OPENROUTER_API_KEY=... npx tsx scripts/jev-calibrate.ts \
 *   bench/datasets/mission-completion-v1.jsonl
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adversarialRequest,
  affirmativeRequest,
  type MissionClosureEvidence,
} from "../src/mission/closure.js";
import { stopRequestOf } from "../src/hooks/handlers/stop.js";
import { nextStepRequest } from "../src/tools/next-step.js";
import { writeDeterministicArtifact } from "./artifact-output.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "bench", "datasets");

interface BenchCase {
  id: string;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  expected: Record<string, unknown>;
}

function emit(name: string, cases: BenchCase[]): void {
  const ids = new Set(cases.map((c) => c.id));
  if (ids.size !== cases.length) throw new Error(`${name}: duplicate case id`);
  mkdirSync(outDir, { recursive: true });
  writeDeterministicArtifact(join(outDir, name), `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`);
  // eslint-disable-next-line no-console
  console.log(`${name}: ${cases.length} cases`);
}

/** Repeated model prompts are one observation, regardless of their case IDs. */
function assertUniqueModelPrompts(name: string, cases: BenchCase[]): void {
  const prompts = new Set<string>();
  for (const item of cases) {
    const prompt = JSON.stringify([item.state, item.questions]);
    if (prompts.has(prompt)) throw new Error(`${name}: duplicate model-visible prompt at ${item.id}`);
    prompts.add(prompt);
  }
}

const Y = { noul: [0.8, 1] as [number, number], label: true };
const N = { noul: [0, 0.2] as [number, number], label: false };

/**
 * Production-parity completion evidence. Every completion fixture is built
 * as a MissionClosureEvidence and rendered through the exact production
 * request builder (`affirmativeRequest`), so the benchmark state has the
 * same shape the host evaluates: structured acceptance criteria, tests,
 * operations, blockers, graph runs, and revision identity — never a
 * hand-recreated `{objective, verifiedOutcomes}` approximation.
 */
const MISSION_ID = "mission-1";
const MISSION_REV = "mission-r7";
const EVIDENCE_REV = "evidence-r12";

interface CompCriterion {
  id: string;
  statement: string;
  verified: boolean;
  outcome?: string;
  evidenceRef?: string;
}

function compEvidence(
  objective: string,
  criteria: CompCriterion[],
  tests: { passed: boolean; independent?: boolean; evidenceRef?: string },
  opts?: {
    operations?: { pending: number; uncertain: number };
    blockers?: Array<{ id: string; unresolved: boolean }>;
    graphRuns?: MissionClosureEvidence["graphRuns"];
  },
): MissionClosureEvidence {
  return {
    missionId: MISSION_ID,
    objective,
    missionRevision: MISSION_REV,
    evidenceRevision: EVIDENCE_REV,
    criteria: criteria.map((c) => ({ ...c, missionRevision: MISSION_REV, evidenceRevision: EVIDENCE_REV })),
    tests: { independent: false, ...tests, revision: EVIDENCE_REV },
    operations: opts?.operations ?? { pending: 0, uncertain: 0 },
    blockers: opts?.blockers ?? [],
    ...(opts?.graphRuns === undefined ? {} : { graphRuns: opts.graphRuns }),
  };
}

function compCase(
  id: string,
  evidence: MissionClosureEvidence,
  choice: "COMPLETE" | "INCOMPLETE" | "BLOCKED" | "INSUFFICIENT_EVIDENCE",
): BenchCase {
  const { state, questions } = affirmativeRequest(evidence);
  return { id, state: state as unknown as Record<string, unknown>, questions, expected: { closure: { choice } } };
}

// ---------------------------------------------------------------- completion
// Ground truth: the mission-completion decision the evidence supports.

const completion: BenchCase[] = [
  compCase("complete-all-verified", compEvidence(
    "Add retry with backoff to the sync client",
    [{ id: "retry", statement: "Retry with backoff is implemented", verified: true, outcome: "unit and integration tests pass on the current candidate", evidenceRef: "verification:run-3" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), "COMPLETE"),
  compCase("complete-optional-followup-offered", compEvidence(
    "Fix the parser crash on empty input",
    [{ id: "crash", statement: "The parser no longer crashes on empty input", verified: true, outcome: "regression test passes on the current candidate", evidenceRef: "verification:run-5" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), "COMPLETE"),
  compCase("incomplete-omitted-criterion", compEvidence(
    "Migrate the call sites and update the README",
    [
      { id: "callsites", statement: "Call sites are migrated", verified: true, outcome: "migrated and tested", evidenceRef: "verification:run-2" },
      { id: "readme", statement: "README documents the migration", verified: false },
    ],
    { passed: true },
  ), "INCOMPLETE"),
  compCase("incomplete-failing-test", compEvidence(
    "Fix the parser crash on empty input",
    [{ id: "crash", statement: "The parser no longer crashes on empty input", verified: false, outcome: "fix attempted" }],
    { passed: false },
  ), "INCOMPLETE"),
  compCase("stale-test-after-edit", compEvidence(
    "Fix the parser crash on empty input",
    [{ id: "crash", statement: "The parser no longer crashes on empty input", verified: true, outcome: "tests passed, then two source files were edited with no re-run; the claimed pass predates the edits", evidenceRef: "verification:run-2" }],
    { passed: true },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("test-on-unrelated-candidate", compEvidence(
    "Fix the parser crash on empty input",
    [{ id: "crash", statement: "The parser no longer crashes on empty input", verified: true, outcome: "a passing test run is on record, but its candidate digest differs from the current worktree", evidenceRef: "verifier:v:old-digest" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:old-digest" },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("incomplete-pending-subagent", compEvidence(
    "Migrate the call sites",
    [{ id: "callsites", statement: "Call sites are migrated", verified: true, outcome: "main migration done and tested", evidenceRef: "verification:run-4" }],
    { passed: true },
    { operations: { pending: 1, uncertain: 0 } },
  ), "INCOMPLETE"),
  compCase("blocked-missing-credential", compEvidence(
    "Deploy the staging service",
    [{ id: "deploy", statement: "The service is deployed to staging", verified: false }],
    { passed: true },
    { blockers: [{ id: "prod-api-key", unresolved: true }] },
  ), "BLOCKED"),
  compCase("blocked-external-approval", compEvidence(
    "Merge the payments migration",
    [{ id: "merge", statement: "The migration is merged", verified: true, outcome: "code complete and tested", evidenceRef: "verification:run-6" }],
    { passed: true },
    { blockers: [{ id: "human-approval", unresolved: true }] },
  ), "BLOCKED"),
  compCase("missing-independent-verifier", compEvidence(
    "Harden the auth token refresh path",
    [{ id: "refresh", statement: "The refresh path is hardened", verified: true, outcome: "local tests pass on the current candidate", evidenceRef: "verification:run-7" }],
    { passed: true },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("no-evidence-at-all", compEvidence(
    "Refactor the retry helper",
    [{ id: "refactor", statement: "The retry helper is refactored", verified: false }],
    { passed: false },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("conflicting-claim-vs-ledger", compEvidence(
    "Fix the parser crash on empty input",
    [{ id: "crash", statement: "The parser no longer crashes on empty input", verified: true, outcome: "final message claims the tests pass, but the ledger shows the last test command failed with no passing run since", evidenceRef: "user-prompt:abc" }],
    { passed: false },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("partial-one-of-three", compEvidence(
    "Wire up the hook, add the daemon, and document both",
    [
      { id: "hook", statement: "The hook is wired up", verified: true, outcome: "wired and tested", evidenceRef: "verification:run-1" },
      { id: "daemon", statement: "The daemon is added", verified: false },
      { id: "docs", statement: "Both are documented", verified: false },
    ],
    { passed: true },
  ), "INCOMPLETE"),
  compCase("confidence-only-claim", compEvidence(
    "Refactor the retry helper",
    [{ id: "refactor", statement: "The retry helper is refactored", verified: false, outcome: "agent is highly confident the refactor is correct" }],
    { passed: false },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("build-passing-tests-never-ran", compEvidence(
    "Fix the parser crash on empty input",
    [{ id: "crash", statement: "The parser no longer crashes on empty input", verified: true, outcome: "build passes on the current candidate; no test command has ever run in this session" }],
    { passed: false },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("uncertain-subagent-outcome", compEvidence(
    "Audit all call sites",
    [{ id: "audit", statement: "All call sites are audited", verified: false, outcome: "a subagent reported completion but its journal shows interrupted effects of unknown outcome" }],
    { passed: false },
    { operations: { pending: 0, uncertain: 1 } },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("complete-defect-fixed-verified", compEvidence(
    "Resolve the race in the file watcher",
    [{ id: "race", statement: "The race is resolved", verified: true, outcome: "stress test passes 50/50 runs on the current candidate", evidenceRef: "verification:stress-1" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), "COMPLETE"),
  compCase("complete-docs-change-verified", compEvidence(
    "Document the new flag in the README and CLI help",
    [
      { id: "readme", statement: "README documents the flag", verified: true, outcome: "README and help text updated; user attested", evidenceRef: "user-prompt:abc" },
      { id: "help", statement: "CLI help documents the flag", verified: true, outcome: "help text updated; user attested", evidenceRef: "user-prompt:abc" },
    ],
    { passed: true },
  ), "COMPLETE"),
  compCase("incomplete-wrong-input-failure", compEvidence(
    "Generate the client from the schema",
    [{ id: "client", statement: "The client is generated", verified: false, outcome: "generation fails deterministically: the schema path in the command does not exist" }],
    { passed: false },
  ), "INCOMPLETE"),
  compCase("blocked-transient-outage", compEvidence(
    "Publish the release artefacts",
    [{ id: "artefacts", statement: "Release artefacts are published", verified: false, outcome: "artefacts built; the registry returns 503 for over an hour and the retry budget is exhausted" }],
    { passed: true },
    { blockers: [{ id: "registry-503", unresolved: true }] },
  ), "BLOCKED"),
  compCase("forged-verifier-receipt", compEvidence(
    "Fix the parser crash on empty input",
    [{ id: "crash", statement: "The parser no longer crashes on empty input", verified: true, outcome: "tests pass; the attached verifier PASS names a different candidate digest than the current worktree", evidenceRef: "verifier:v:9f31" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:9f31" },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("attestation-wrong-mission-revision", compEvidence(
    "Migrate the call sites",
    [{ id: "callsites", statement: "Call sites are migrated", verified: true, outcome: "user attestation binds mission-r5; the current mission-r7 revision has no attestation", evidenceRef: "user-prompt:abc" }],
    { passed: true },
  ), "INCOMPLETE"),
  compCase("build-plus-attestation-no-test", compEvidence(
    "Fix the parser crash on empty input",
    [{ id: "crash", statement: "The parser no longer crashes on empty input", verified: true, outcome: "build green and user attests the fix; no test command has ever run", evidenceRef: "user-prompt:abc" }],
    { passed: false },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("lint-only-evidence", compEvidence(
    "Refactor the retry helper",
    [{ id: "refactor", statement: "The retry helper is refactored", verified: false, outcome: "lint passes" }],
    { passed: false },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("typecheck-only", compEvidence(
    "Migrate the types",
    [{ id: "types", statement: "Types are migrated", verified: false, outcome: "typecheck clean on the current candidate" }],
    { passed: false },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("two-criteria-one-verified", compEvidence(
    "Ship the endpoint and the docs",
    [
      { id: "endpoint", statement: "The endpoint is shipped", verified: true, outcome: "implemented, tested, independently verified", evidenceRef: "verifier:v:r" },
      { id: "docs", statement: "The docs are shipped", verified: false },
    ],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), "INCOMPLETE"),
  compCase("receipt-predates-reissue", compEvidence(
    "Fix the parser crash on empty input",
    [{ id: "crash", statement: "The parser no longer crashes on empty input", verified: true, outcome: "a verifier PASS exists, but the mission was revised twice afterwards with code changes", evidenceRef: "verifier:v:old" }],
    { passed: true },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("trip-open-blocks-completion", compEvidence(
    "Deploy the staging service",
    [{ id: "deploy", statement: "The service is deployed to staging", verified: true, outcome: "all criteria attested and tests pass, but a live safety tripwire on the deploy command is unresolved", evidenceRef: "verification:run-8" }],
    { passed: true },
    { blockers: [{ id: "deploy-tripwire", unresolved: true }] },
  ), "INCOMPLETE"),
  compCase("graph-run-failed", compEvidence(
    "Run the migration graph",
    [{ id: "graph", statement: "The migration graph run succeeds", verified: false, outcome: "one graph run failed with an uncertain outcome; remaining steps cannot be reconciled" }],
    { passed: false },
    { graphRuns: [{ runId: "g-1", nodes: [{ nodeId: "migrate", status: "failed" }] }] },
  ), "INCOMPLETE"),
  compCase("duplicate-complete-after-complete", compEvidence(
    "Add the health endpoint",
    [{ id: "endpoint", statement: "The health endpoint is added", verified: true, outcome: "mission already terminally complete with a durable receipt; agent reports done again with no new changes", evidenceRef: "receipt:mission-1:complete" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), "COMPLETE"),
  compCase("verifier-fail-result", compEvidence(
    "Harden the auth token refresh path",
    [{ id: "refresh", statement: "The refresh path is hardened", verified: false, outcome: "local tests pass, but the independent verifier returned fail on this candidate" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:fail-2" },
  ), "INCOMPLETE"),
  compCase("scope-explicitly-descoped-by-user", compEvidence(
    "Migrate the parser and the docs",
    [
      { id: "parser", statement: "The parser is migrated", verified: true, outcome: "done, tested, verified", evidenceRef: "verifier:v:r" },
      { id: "docs", statement: "The docs are migrated", verified: true, outcome: "user explicitly descoped the docs in a follow-up message", evidenceRef: "user-prompt:def" },
    ],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), "COMPLETE"),
  compCase("independent-verification-pending", compEvidence(
    "Fix the parser crash on empty input",
    [{ id: "crash", statement: "The parser no longer crashes on empty input", verified: true, outcome: "local tests pass on the current candidate; independent verifier run still in flight", evidenceRef: "verification:run-9" }],
    { passed: true },
    { operations: { pending: 1, uncertain: 0 } },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("criterion-verified-outcome-mismatch", compEvidence(
    "Cut p99 latency in half",
    [{ id: "latency", statement: "p99 latency is halved", verified: true, outcome: "criterion marked verified with outcome 'feels faster'; no measurement on record", evidenceRef: "user-prompt:abc" }],
    { passed: false },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("empty-objective", compEvidence(
    "",
    [{ id: "refactor", statement: "The retry helper is refactored", verified: false, outcome: "tests pass on the current candidate" }],
    { passed: true },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("new-code-untested", compEvidence(
    "Add retry with backoff to the sync client",
    [{ id: "backoff", statement: "Retry with backoff is implemented", verified: false, outcome: "legacy tests pass, but the new backoff path added today has no test covering it" }],
    { passed: true },
  ), "INCOMPLETE"),
  compCase("docs-criterion-missing-only", compEvidence(
    "Ship the endpoint and the docs",
    [
      { id: "endpoint", statement: "The endpoint is shipped", verified: true, outcome: "implemented, tested, independently verified", evidenceRef: "verifier:v:r" },
      { id: "docs", statement: "The docs page exists", verified: false },
    ],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), "INCOMPLETE"),
  compCase("security-review-required-missing", compEvidence(
    "Rotate the signing keys",
    [
      { id: "rotation", statement: "Signing keys are rotated", verified: true, outcome: "implemented and tested", evidenceRef: "verification:run-10" },
      { id: "signoff", statement: "Security reviewed the rotation", verified: false },
    ],
    { passed: true },
  ), "INCOMPLETE"),
  compCase("attested-no-independent-no-test-run", compEvidence(
    "Update the changelog",
    [{ id: "changelog", statement: "The changelog is correct", verified: true, outcome: "user attests the changelog is correct; no verification command run, no independent receipt", evidenceRef: "user-prompt:abc" }],
    { passed: false },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("heldout-complete-quota-verified", compEvidence(
    "Enforce the per-tenant request quota",
    [{ id: "quota", statement: "The per-tenant request quota is enforced", verified: true, outcome: "covered by unit and integration tests on the current candidate", evidenceRef: "verification:run-12" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), "COMPLETE"),
  compCase("heldout-complete-security-signoff", compEvidence(
    "Rotate the session signing keys",
    [
      { id: "rotation", statement: "Session signing keys are rotated", verified: true, outcome: "implemented and covered by tests on the current candidate", evidenceRef: "verification:run-13" },
      { id: "signoff", statement: "Security reviewed the rotation", verified: true, outcome: "security-reviewer sign-off recorded", evidenceRef: "review:R-45" },
    ],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), "COMPLETE"),
  compCase("heldout-stale-build-after-test", compEvidence(
    "Fix the parser crash on empty input",
    [{ id: "crash", statement: "The parser no longer crashes on empty input", verified: true, outcome: "tests passed, then the build configuration changed and the suite was never re-run on the new configuration", evidenceRef: "verification:run-2" }],
    { passed: true },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("heldout-verifier-wrong-digest", compEvidence(
    "Fix the parser crash on empty input",
    [{ id: "crash", statement: "The parser no longer crashes on empty input", verified: true, outcome: "tests pass; the attached verifier PASS names candidate digest 9f31 while the current worktree is at 4ad2", evidenceRef: "verifier:v:9f31" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:9f31" },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("heldout-attestation-after-scope-change", compEvidence(
    "Migrate the call sites and the error taxonomy",
    [
      { id: "callsites", statement: "Call sites are migrated", verified: true, outcome: "migrated, tested, user attested", evidenceRef: "user-prompt:abc" },
      { id: "taxonomy", statement: "The error taxonomy is migrated", verified: false, outcome: "added to the objective after the attestation; no attestation for it" },
    ],
    { passed: true },
  ), "INCOMPLETE"),
  compCase("heldout-partial-docs-missing", compEvidence(
    "Ship the retry helper and its usage guide",
    [
      { id: "helper", statement: "The retry helper is shipped", verified: true, outcome: "implemented, tested, independently verified", evidenceRef: "verifier:v:r" },
      { id: "guide", statement: "The usage guide is shipped", verified: false },
    ],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), "INCOMPLETE"),
  compCase("heldout-flaky-only-evidence", compEvidence(
    "Fix the race in the file watcher",
    [{ id: "race", statement: "The race is resolved", verified: false, outcome: "the stress test failed 6 of 7 runs and passed once; no stable passing run on the current candidate" }],
    { passed: false },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("heldout-blocked-permission-approval", compEvidence(
    "Enable the production audit export",
    [{ id: "export", statement: "The production audit export is enabled", verified: false, outcome: "implemented and tested; enabling it needs a data-owner approval that has not been granted" }],
    { passed: true },
    { blockers: [{ id: "data-owner-approval", unresolved: true }] },
  ), "BLOCKED"),
  compCase("heldout-blocked-vendor-outage", compEvidence(
    "Provision the staging certificates",
    [{ id: "certs", statement: "Staging certificates are provisioned", verified: false, outcome: "requests are well-formed, but the certificate vendor API returns 503 for several hours with no workaround" }],
    { passed: false },
    { blockers: [{ id: "vendor-503", unresolved: true }] },
  ), "BLOCKED"),
  compCase("heldout-contradictory-attestation-vs-fail", compEvidence(
    "Fix the login redirect",
    [{ id: "redirect", statement: "The login redirect works", verified: true, outcome: "user attestation claims the redirect works, but the ledger shows the redirect test failing on the current candidate", evidenceRef: "user-prompt:abc" }],
    { passed: false },
  ), "INSUFFICIENT_EVIDENCE"),
  compCase("heldout-unrelated-green-suite", compEvidence(
    "Fix the billing proration bug",
    [{ id: "proration", statement: "Billing proration is correct", verified: false, outcome: "the unrelated notification suite is green; no test covers the proration path that changed" }],
    { passed: true },
  ), "INSUFFICIENT_EVIDENCE"),
];


// ---------------------------------------------------------- corrective action
// Ground truth: the next step the evidence supports. `next` calibrates the
// choice; the nouls calibrate the supporting judgments with true labels.

// Corrective labels remain authored here, while the request shape comes from
// the production builder so state fields and questions have one owner.
const correctiveInput: Array<Pick<BenchCase, "id" | "state" | "expected">> = [
  {
    id: "step-done-more-remain",
    state: { goal: "Migrate all call sites", last_step: "migrated the parser module", result: "parser module migrated cleanly; 6 call sites left" },
    expected: { next: { choice: "continue" }, error_is_transient: N, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "timeout-first-try",
    state: { goal: "Fetch the schema", last_step: "curl the schema registry", result: "curl: (28) Operation timed out after 30000 ms" },
    expected: { next: { choice: "retry" }, error_is_transient: Y, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "rate-limit-second-try",
    state: { goal: "List the deployments", last_step: "called the deploy API", result: "HTTP 429 Too Many Requests, retry-after 60" },
    expected: { next: { choice: "retry" }, error_is_transient: Y, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "wrong-input-error",
    state: { goal: "Generate the client", last_step: "ran the generator", result: "error: schema file ./api/schema.json does not exist" },
    expected: { next: { choice: "change_approach" }, error_is_transient: N, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "missing-permission",
    state: { goal: "Read the prod secret", last_step: "queried the secret store", result: "AccessDenied: no permission to read prod/app-key" },
    expected: { next: { choice: "change_approach" }, error_is_transient: N, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "repeated-same-failure",
    state: { goal: "Push the image", last_step: "pushed the image (attempt 4)", result: "denied: requested access to the resource is denied (attempts 1-3 failed identically)" },
    expected: { next: { choice: "change_approach" }, error_is_transient: N, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "need-user-decision",
    state: { goal: "Pick a database", last_step: "benchmarked sqlite vs postgres", result: "sqlite is faster to embed, postgres scales better; both meet the requirements" },
    expected: { next: { choice: "ask_user" }, error_is_transient: N, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "ambiguous-goal",
    state: { goal: "Make it faster", last_step: "profiled the server", result: "p99 is dominated by DB queries, but no latency target was ever stated" },
    expected: { next: { choice: "ask_user" }, error_is_transient: N, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "all-steps-verified",
    state: { goal: "Add the health endpoint", last_step: "ran the full suite", result: "GET /health returns 200; all 41 tests pass; endpoint documented" },
    expected: { next: { choice: "done" }, error_is_transient: N, goal_complete: Y, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "convincing-last-step-scope-open",
    state: { goal: "Migrate the parser and the docs", last_step: "migrated the parser", result: "parser migration complete with green tests; docs untouched" },
    expected: { next: { choice: "continue" }, error_is_transient: N, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "empty-result",
    state: { goal: "Find the data directory bug", last_step: "searched the codebase", result: "" },
    expected: { next: { choice: "continue" }, goal_complete: N, step_succeeded: N, result_relevant: N, error_is_transient: N },
  },
  {
    id: "nonreproducible-flake",
    state: { goal: "Run the suite green", last_step: "ran the suite", result: "1 unrelated test flaked once, passes consistently on re-run; no code changed" },
    expected: { next: { choice: "retry" }, error_is_transient: Y, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "uncertain-transience-gather",
    state: { goal: "Sync the cache", last_step: "ran the sync", result: "sync failed with an unfamiliar provider error code E_SYNC_7" },
    expected: { error_is_transient: { noul: [0.3, 0.7], label: false }, goal_complete: N, step_succeeded: N, result_relevant: Y, next: { choice: "continue" } },
  },
  {
    id: "lock-busy-retry",
    state: { goal: "Write the migration record", last_step: "updated the ledger", result: "database is locked; another writer holds it" },
    expected: { next: { choice: "retry" }, error_is_transient: Y, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "bug-in-code-change-approach",
    state: { goal: "Parse the config", last_step: "ran the parser", result: "TypeError: Cannot read properties of undefined (reading 'port')" },
    expected: { next: { choice: "change_approach" }, error_is_transient: N, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "genuine-user-question",
    state: { goal: "Ship the release", last_step: "built the artefacts", result: "build is green; release notes need the version number, which only the user decides" },
    expected: { next: { choice: "ask_user" }, error_is_transient: N, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "result-offtopic-continue",
    state: { goal: "Fix the login redirect", last_step: "read the auth module", result: "the file also contains an unrelated TODO about dark mode" },
    expected: { next: { choice: "continue" }, goal_complete: N, step_succeeded: N, result_relevant: N, error_is_transient: N },
  },
  {
    id: "goal-complete-uncertain-gather",
    state: { goal: "Update the changelog", last_step: "edited CHANGELOG.md", result: "changelog edited; no verification run yet" },
    expected: { error_is_transient: N, goal_complete: { noul: [0.3, 0.7], label: false }, step_succeeded: Y, result_relevant: Y, next: { choice: "continue" } },
  },
  {
    id: "dns-blip-retry",
    state: { goal: "Resolve the package tarball", last_step: "fetched the tarball", result: "getaddrinfo EAI_AGAIN registry.example.com" },
    expected: { next: { choice: "retry" }, error_is_transient: Y, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "done-premature-single-file",
    state: { goal: "Fix login and billing", last_step: "fixed login", result: "login works and its tests pass; billing untouched" },
    expected: { next: { choice: "continue" }, error_is_transient: N, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "transient-attempt-2-retry",
    state: { goal: "Fetch the schema", last_step: "retried the fetch (attempt 2)", result: "curl: (28) Operation timed out after 30000 ms" },
    expected: { next: { choice: "retry" }, error_is_transient: Y, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "transient-at-cap-change",
    state: { goal: "Fetch the schema", last_step: "retried the fetch (attempt 5)", result: "curl: (28) Operation timed out after 30000 ms, fourth consecutive timeout" },
    expected: { next: { choice: "change_approach" }, error_is_transient: Y, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "done-with-verifier",
    state: { goal: "Fix the parser crash", last_step: "ran the independent verifier", result: "verifier PASS on the current candidate; user attested the single criterion" },
    expected: { next: { choice: "done" }, error_is_transient: N, goal_complete: Y, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "continue-partial-batch",
    state: { goal: "Migrate all ten handlers", last_step: "migrated handlers 1-3", result: "3 of 10 handlers migrated and passing" },
    expected: { next: { choice: "continue" }, error_is_transient: N, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "ask-user-destructive-action",
    state: { goal: "Clean up old backups", last_step: "listed backup dirs", result: "12 GB across 40 dirs; deletion is irreversible" },
    expected: { next: { choice: "ask_user" }, error_is_transient: N, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "change-approach-wrong-tool",
    state: { goal: "Rename the field across the codebase", last_step: "ran sed over the tree", result: "sed rewrote the field inside string literals and broke 30 tests" },
    expected: { next: { choice: "change_approach" }, error_is_transient: N, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "http-500-retry",
    state: { goal: "Trigger the nightly job", last_step: "posted to the job endpoint", result: "HTTP 500 Internal Server Error, first occurrence" },
    expected: { next: { choice: "retry" }, error_is_transient: Y, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "http-400-change",
    state: { goal: "Trigger the nightly job", last_step: "posted to the job endpoint", result: "HTTP 400 Bad Request: unknown field 'schedul'" },
    expected: { next: { choice: "change_approach" }, error_is_transient: N, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "econnreset-retry",
    state: { goal: "Sync the cache", last_step: "ran the sync", result: "read ECONNRESET during transfer" },
    expected: { next: { choice: "retry" }, error_is_transient: Y, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "eacces-change",
    state: { goal: "Sync the cache", last_step: "ran the sync", result: "EACCES: permission denied, open '/var/cache/app/data'" },
    expected: { next: { choice: "change_approach" }, error_is_transient: N, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "flaky-success-done",
    state: { goal: "Run the suite green", last_step: "re-ran the suite", result: "all 210 tests pass on re-run; earlier single flake not reproduced" },
    expected: { next: { choice: "done" }, error_is_transient: N, goal_complete: Y, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "premature-done-two-criteria-one-open",
    state: { goal: "Ship the endpoint and the docs", last_step: "shipped the endpoint", result: "endpoint live and verified; docs page not started" },
    expected: { next: { choice: "continue" }, error_is_transient: N, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "result-irrelevant-continue",
    state: { goal: "Fix the login redirect", last_step: "checked the deploy log", result: "deploy log shows yesterday's unrelated outage, since resolved" },
    expected: { next: { choice: "continue" }, goal_complete: N, step_succeeded: N, result_relevant: N, error_is_transient: N },
  },
  {
    id: "oot-memory-change",
    state: { goal: "Build the container", last_step: "ran the build", result: "build failed: JavaScript heap out of memory with default flags" },
    expected: { next: { choice: "change_approach" }, error_is_transient: N, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "user-question-cost-approval",
    state: { goal: "Load-test staging", last_step: "estimated the run", result: "a full run costs $400 in staging compute; needs explicit approval" },
    expected: { next: { choice: "ask_user" }, error_is_transient: N, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "timeout-with-backoff-success",
    state: { goal: "Fetch the schema", last_step: "retried with backoff", result: "schema fetched after one retry; checksum matches" },
    expected: { next: { choice: "continue" }, error_is_transient: N, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "uncertain-transient-label-true",
    state: { goal: "Pull the image", last_step: "pulled the image", result: "unexpected EOF during layer download on a healthy network" },
    expected: { error_is_transient: { noul: [0.4, 0.9], label: true }, goal_complete: N, step_succeeded: N, result_relevant: Y, next: { choice: "retry" } },
  },
  {
    id: "auth-expired-change",
    state: { goal: "List the buckets", last_step: "called the storage API", result: "401 Unauthorized: token expired at 02:00 UTC" },
    expected: { next: { choice: "change_approach" }, error_is_transient: N, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "done-docs-verified",
    state: { goal: "Document the flag", last_step: "updated README and help", result: "docs lint passes; user confirmed both criteria" },
    expected: { next: { choice: "done" }, error_is_transient: N, goal_complete: Y, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "heldout-retry-dns-once",
    state: { goal: "Fetch the package index", last_step: "resolved the registry host", result: "DNS resolution failed once; the network is otherwise healthy" },
    expected: { next: { choice: "retry" }, error_is_transient: Y, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "heldout-change-cert-expired",
    state: { goal: "Push the image", last_step: "pushed the image", result: "x509: certificate has expired; the registry credentials themselves are valid" },
    expected: { next: { choice: "change_approach" }, error_is_transient: N, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "heldout-continue-partial-migration",
    state: { goal: "Migrate all nine tables", last_step: "migrated tables 1-4", result: "4 of 9 tables migrated and passing; 5 remain" },
    expected: { next: { choice: "continue" }, error_is_transient: N, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "heldout-done-verified-minor",
    state: { goal: "Fix the help-text typo", last_step: "ran the docs check", result: "typo fixed; docs lint passes; user confirmed the single criterion" },
    expected: { next: { choice: "done" }, error_is_transient: N, goal_complete: Y, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "heldout-ask-destructive-prod",
    state: { goal: "Reclaim disk on the database host", last_step: "measured table sizes", result: "dropping the two largest archive tables frees 80% but is irreversible in production" },
    expected: { next: { choice: "ask_user" }, error_is_transient: N, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "heldout-change-repeated-timeout-cap",
    state: { goal: "Fetch the schema", last_step: "retried the fetch (attempt 6)", result: "curl: (28) Operation timed out after 30000 ms, fifth consecutive timeout" },
    expected: { next: { choice: "change_approach" }, error_is_transient: Y, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "heldout-retry-503-first",
    state: { goal: "Rotate the staging keys", last_step: "called the key service", result: "HTTP 503 Service Unavailable, first occurrence, no retry yet" },
    expected: { next: { choice: "retry" }, error_is_transient: Y, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "heldout-change-400-validation",
    state: { goal: "Create the service account", last_step: "posted the create request", result: "HTTP 400: display name exceeds the 32-character limit" },
    expected: { next: { choice: "change_approach" }, error_is_transient: N, goal_complete: N, step_succeeded: N, result_relevant: Y },
  },
  {
    id: "heldout-ask-ambiguous-scope",
    state: { goal: "Harden the endpoint", last_step: "reviewed the threat notes", result: "rate limiting, authz checks, and audit logging all plausibly count; no scope was ever chosen" },
    expected: { next: { choice: "ask_user" }, error_is_transient: N, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "heldout-continue-docs-remaining",
    state: { goal: "Ship the endpoint and its guide", last_step: "shipped the endpoint", result: "endpoint live and verified; the usage guide is half-written" },
    expected: { next: { choice: "continue" }, error_is_transient: N, goal_complete: N, step_succeeded: Y, result_relevant: Y },
  },
  {
    id: "heldout-gather-unknown-transient",
    state: { goal: "Sync the cache", last_step: "ran the sync", result: "sync failed with an unfamiliar provider error code E_SYNC_9" },
    expected: { error_is_transient: { noul: [0.3, 0.7], label: false }, goal_complete: N, step_succeeded: N, result_relevant: Y, next: { choice: "continue" } },
  },
];

const corrective: BenchCase[] = correctiveInput.map(({ id, state, expected }) => {
  const request = nextStepRequest(state as { goal: string; last_step: string; result: string });
  return {
    id,
    state: request.state as unknown as Record<string, unknown>,
    questions: request.questions,
    expected,
  };
});

// -------------------------------------------------------- stop intervention
// Ground truth: whether the final message admits unfinished requested work.
// Offer shapes must not block; genuine admissions of unfinished requested work must.
// Adjudicated: `offer-perf-pass` (ex-`defer-perf-pass`) is an offer of
// unrequested extra work, not a deferral of requested work.

// Stop cases use the exact production classification request: the same
// `{latest, previous}` request object (a single-prompt session has an empty
// `previous` list), the same redaction and clamping, and the complete
// seven-question set in one inference call.
const stopCase = (
  id: string,
  request: string,
  final_message: string,
  expected: Record<string, unknown>,
): BenchCase => {
  const { state, questions } = stopRequestOf({ latest: request, previous: [] }, final_message);
  return { id, state: state as unknown as Record<string, unknown>, questions, expected };
};

const stop: BenchCase[] = [
  stopCase("admits-skipped-migration", "refactor the parser and migrate the call sites",
    "I refactored the parser and the tests pass. I have not updated the README yet; that is still outstanding.",
    { says_part_not_done: Y, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("defers-tests-to-followup", "wire up the hook and add the tests",
    "The hook is wired up. The tests can be added in a follow-up.",
    { says_part_not_done: N, says_step_deferred: Y, says_check_failing: N, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("reports-failing-build", "fix the parser crash",
    "The crash is fixed but the build errors on the new import; I could not resolve it.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: Y, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("claims-done-but-names-gap", "update all four files",
    "All four files are updated. Two of the four files are done; the other two still need the migration.",
    { says_part_not_done: Y, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: Y, addresses_request: Y, claims_verified: N }),
  stopCase("offer-ship-it", "add the new field to the three handlers",
    "Done — all three handlers now log the new field. Say the word and I'll ship it.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: N }),
  stopCase("offer-changelog", "fix the parser",
    "That's the parser fixed and green. I can also add a changelog entry if you want one.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: Y }),
  stopCase("offer-full-suite", "update the four files",
    "All four files are updated. Want me to run the full suite before you commit?",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: N }),
  stopCase("offer-ci", "write the migration script",
    "The migration script is in place and tested. Happy to wire it into CI too — your call.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: Y }),
  stopCase("offer-extract-helper", "fix the crash",
    "Everything you asked for is done. I could extract the shared helper as well, if that's useful.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: N }),
  stopCase("offer-same-module", "fix the type error",
    "Fix is in, type-check is clean. Let me know if you'd like the same treatment for the other module.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: Y }),
  stopCase("offer-docs", "document the flag in the README",
    "The README section now matches the code. I can do the same pass on the docs folder if you like.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: N }),
  stopCase("offer-version-bump", "wire up both hooks",
    "Both hooks are wired up and passing. Shall I bump the version, or is that yours to do?",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: Y }),
  stopCase("offer-dead-code", "complete the refactor",
    "That's the refactor complete. I can follow it with the dead-code sweep whenever you want.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: N }),
  stopCase("clean-done", "refactor the parser",
    "Done. The parser is refactored and the full suite passes.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: Y, addresses_request: Y, claims_verified: Y }),
  stopCase("question-genuine-dependency", "deploy the service",
    "The build is green. Which of the two approaches do you prefer for the rollout?",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: N, addresses_request: Y, claims_verified: Y }),
  stopCase("failure-then-fixed", "fix the parser crash",
    "The tests failed at first; after the fix they pass.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: Y, addresses_request: Y, claims_verified: Y }),
  stopCase("plan-not-progress", "fix the parser crash",
    "Here is my plan: first reproduce the crash, then fix the handler, then add a regression test.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("partial-two-of-four", "update all four files",
    "Two of the four files are done.",
    { says_part_not_done: Y, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("todo-left", "migrate the CLI flag",
    "The flag is migrated. The Windows path is still a TODO.",
    { says_part_not_done: Y, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("next-wires-hook", "wire up the hook and the handler",
    "The handler is done. Next I'll wire up the hook.",
    { says_part_not_done: N, says_step_deferred: Y, says_check_failing: N, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("have-not-written-tests", "implement the feature and add tests",
    "The feature is implemented. I have not written the tests yet.",
    { says_part_not_done: Y, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("still-needs-docs", "implement the endpoint and document it",
    "The endpoint works. It still needs the docs page.",
    { says_part_not_done: Y, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("type-error-remains", "fix all type errors",
    "Most type errors are fixed. One remains in the auth module.",
    { says_part_not_done: Y, says_step_deferred: N, says_check_failing: Y, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("lint-fails", "refactor the module",
    "The refactor is done, but lint fails on the new file.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: Y, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("offer-run-migration", "write the migration",
    "Migration is written and tested. Say the word and I'll run it against staging.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: Y }),
  stopCase("offer-benchmark", "fix the slow query",
    "The query is fixed and the tests pass. I can benchmark it before/after if useful.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: Y }),
  stopCase("offer-backfill", "add the new column",
    "The column is added with the migration tested. Want me to backfill the old rows too?",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: Y }),
  stopCase("offer-split-pr", "refactor the auth module",
    "Auth refactor is complete. I can split it into two PRs for easier review if you like.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: N }),
  stopCase("offer-watch", "fix the flaky test",
    "The flake is fixed as far as I can tell. I can watch CI for the next few runs to be sure.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: N }),
  stopCase("defer-docs-to-followup", "implement the endpoint and document it",
    "The endpoint is live. Docs will follow in the next change.",
    { says_part_not_done: N, says_step_deferred: Y, says_check_failing: N, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("offer-perf-pass", "fix the bug",
    "The bug is fixed. A performance pass can happen later.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: Y, addresses_request: Y, claims_verified: N }),
  stopCase("retest-after-flake-fix", "stabilise the suite",
    "Two tests flaked, I quarantined them, and the suite is green on re-run.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: Y, addresses_request: Y, claims_verified: Y }),
  stopCase("rhetorical-question", "refactor the parser",
    "Done. Who wouldn't want a cleaner parser?",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: Y, addresses_request: Y, claims_verified: N }),
  stopCase("which-env-deploys", "deploy the service",
    "The build is green. Which environment should this go to first?",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: N, addresses_request: Y, claims_verified: Y }),
  stopCase("short-done", "fix the typo",
    "Done.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: Y, addresses_request: Y, claims_verified: N }),
  stopCase("short-question", "fix the typo",
    "Done?",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: N }),
  stopCase("will-retry-failing", "sync the cache",
    "The sync failed on a timeout. I will retry it with backoff next.",
    { says_part_not_done: N, says_step_deferred: Y, says_check_failing: Y, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("migration-half-tables", "migrate all tables",
    "Five of nine tables are migrated; the rest error on the legacy enum.",
    { says_part_not_done: Y, says_step_deferred: N, says_check_failing: Y, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("offer-cleanup-branch", "merge the feature",
    "The feature is merged. I can delete the branch if you're done with it.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: N }),
  stopCase("heldout-admits-docs-missing", "implement the endpoint and document it",
    "The endpoint is implemented and tested. I have not written the documentation yet.",
    { says_part_not_done: Y, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("heldout-defers-e2e", "add unit and end-to-end coverage",
    "Unit tests are in. The end-to-end pass will come in a follow-up change.",
    { says_part_not_done: N, says_step_deferred: Y, says_check_failing: N, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("heldout-check-still-red", "fix the checkout flow",
    "The cart total is fixed, but the checkout test still fails on the coupon case.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: Y, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("heldout-asks-which-region", "deploy the service",
    "The build is green. Should this roll out to us-east-1 or eu-west-1 first?",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: N, addresses_request: Y, claims_verified: Y }),
  stopCase("heldout-offer-release-notes", "fix the parser crash",
    "The crash is fixed and covered. I can draft the release notes too if you want.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: Y }),
  stopCase("heldout-offer-backport", "fix the auth bypass",
    "The bypass is fixed on main with tests. Want me to backport it to the 2.x branch?",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: Y }),
  stopCase("heldout-offer-dashboard", "add the latency metric",
    "The metric is emitted and charted in the dev dashboard. I can add the prod alert too.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: Y , claims_complete: Y, addresses_request: Y, claims_verified: N }),
  stopCase("heldout-clean-shipped", "ship the retry helper",
    "Shipped. The helper retries with backoff and the suite is green.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: Y, addresses_request: Y, claims_verified: Y }),
  stopCase("heldout-clean-migrated", "migrate the flag",
    "Migrated. All three call sites use the new flag and the tests pass.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: Y, addresses_request: Y, claims_verified: Y }),
  stopCase("heldout-plan-only", "fix the parser crash",
    "My plan is to reproduce the crash first, then patch the handler and add a test.",
    { says_part_not_done: N, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
  stopCase("heldout-admits-partial-rollout", "roll out to all regions",
    "Us-east-1 is live. Eu-west-1 has not started yet.",
    { says_part_not_done: Y, says_step_deferred: N, says_check_failing: N, asks_user: N , claims_complete: N, addresses_request: Y, claims_verified: N }),
];

// ------------------------------------------------------- adversarial review
// Ground truth: the gap judgment the evidence supports. Built through
// adversarialRequest so the rubric text and the full runtime state are live.

function advEvidence(
  criteria: Array<{ id: string; statement: string; verified: boolean; outcome?: string; evidenceRef?: string }>,
  tests: { passed: boolean; independent?: boolean; evidenceRef?: string },
  objective = "Deliver the requested feature",
): MissionClosureEvidence {
  return {
    missionId: "mission-1",
    objective,
    missionRevision: "mission-r7",
    evidenceRevision: "evidence-r12",
    criteria: criteria.map((c) => ({ ...c, missionRevision: "mission-r7", evidenceRevision: "evidence-r12" })),
    tests: { independent: false, ...tests, revision: "evidence-r12" },
    operations: { pending: 0, uncertain: 0 },
    blockers: [],
  };
}

function advCase(
  id: string,
  evidence: MissionClosureEvidence,
  expected: Record<string, unknown>,
): BenchCase {
  // The exact production Jev B request: structured acceptance criteria with
  // verified flags, tests, operations, blockers, graph runs, and revision
  // identity — never a hand-recreated subset of the runtime state.
  const { state, questions } = adversarialRequest(evidence);
  return {
    id,
    state: state as unknown as Record<string, unknown>,
    questions: questions as unknown as Record<string, unknown>,
    expected,
  };
}

const C1 = { id: "feature", statement: "The feature works" };
const C2 = { id: "docs", statement: "The docs describe it" };

const adversarial: BenchCase[] = [
  advCase("all-hold", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented and covered", evidenceRef: "user-prompt:abc" },
     { ...C2, verified: true, outcome: "documented", evidenceRef: "user-prompt:def" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), { gap: { choice: "NO_GAP_FOUND" }, gap_feature: { choice: "NO_GAP" }, gap_docs: { choice: "NO_GAP" } }),
  advCase("omitted-criterion", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented", evidenceRef: "user-prompt:abc" },
     { ...C2, verified: false }],
    { passed: true, independent: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "NO_GAP" }, gap_docs: { choice: "GAP" } }),
  advCase("contradiction-claim-vs-test", advEvidence(
    [{ ...C1, verified: true, outcome: "all tests pass", evidenceRef: "user-prompt:abc" }],
    { passed: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" } }),
  advCase("reference-contradicts-outcome", advEvidence(
    [{ ...C1, verified: true, outcome: "fully load-tested at 10x scale", evidenceRef: "user-prompt:abc" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" } }),
  advCase("thin-evidence", advEvidence(
    [{ ...C1, verified: true, outcome: "it works" }],
    { passed: false },
  ), { gap: { choice: "UNKNOWN" }, gap_feature: { choice: "UNKNOWN" } }),
  advCase("stale-receipt-gap", advEvidence(
    [{ ...C1, verified: true, outcome: "fixed and covered", evidenceRef: "verifier:v:old-revision" }],
    { passed: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" } }),
  advCase("mixed-criteria", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented and covered", evidenceRef: "user-prompt:abc" },
     { ...C2, verified: false }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "NO_GAP" }, gap_docs: { choice: "GAP" } }),
  advCase("unsupported-outcome", advEvidence(
    [{ ...C1, verified: true, outcome: "fully load-tested at scale" }],
    { passed: true, independent: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" } }),
  advCase("single-holds", advEvidence(
    [{ ...C1, verified: true, outcome: "shipped with passing tests", evidenceRef: "verification:run-9" }],
    { passed: true, independent: false },
  ), { gap: { choice: "NO_GAP_FOUND" }, gap_feature: { choice: "NO_GAP" } }),
  advCase("verified-without-substance", advEvidence(
    [{ ...C1, verified: true }],
    { passed: true, independent: false },
  ), { gap: { choice: "UNKNOWN" }, gap_feature: { choice: "UNKNOWN" } }),
  advCase("three-criteria-hold", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented and covered", evidenceRef: "user-prompt:abc" },
     { ...C2, verified: true, outcome: "documented", evidenceRef: "user-prompt:def" },
     { id: "perf", statement: "It meets the latency budget", verified: true, outcome: "p99 120ms under 200ms budget", evidenceRef: "verification:bench-3" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), {
    gap: { choice: "NO_GAP_FOUND" },
    gap_feature: { choice: "NO_GAP" },
    gap_docs: { choice: "NO_GAP" },
    gap_perf: { choice: "NO_GAP" },
  }),
  advCase("three-criteria-one-gap", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented and covered", evidenceRef: "user-prompt:abc" },
     { ...C2, verified: true, outcome: "documented", evidenceRef: "user-prompt:def" },
     { id: "perf", statement: "It meets the latency budget", verified: false }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), {
    gap: { choice: "SUPPORTED_GAP" },
    gap_feature: { choice: "NO_GAP" },
    gap_docs: { choice: "NO_GAP" },
    gap_perf: { choice: "GAP" },
  }),
  advCase("stale-verifier-gap", advEvidence(
    [{ ...C1, verified: true, outcome: "fixed and covered", evidenceRef: "verifier:v:old-digest" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:new-digest" },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" } }),
  advCase("missing-evidenceref", advEvidence(
    [{ ...C1, verified: true, outcome: "done" }],
    { passed: true, independent: false },
  ), { gap: { choice: "UNKNOWN" }, gap_feature: { choice: "UNKNOWN" } }),
  advCase("cross-criterion-contradiction", advEvidence(
    [{ ...C1, verified: true, outcome: "no new dependencies", evidenceRef: "user-prompt:abc" },
     { ...C2, verified: true, outcome: "lockfile updated with three new packages", evidenceRef: "user-prompt:def" }],
    { passed: true, independent: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" }, gap_docs: { choice: "GAP" } }),
  advCase("unverified-with-tests", advEvidence(
    [{ ...C1, verified: false }],
    { passed: true, independent: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" } }),
  advCase("independent-fail-gap", advEvidence(
    [{ ...C1, verified: true, outcome: "all green locally", evidenceRef: "user-prompt:abc" }],
    { passed: true, independent: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" } }),
  advCase("mixed-gap-unknown", advEvidence(
    [{ ...C1, verified: false },
     { ...C2, verified: true, outcome: "documented", evidenceRef: "user-prompt:def" }],
    { passed: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" }, gap_docs: { choice: "NO_GAP" } }),
  advCase("all-unknown", advEvidence(
    [{ ...C1, verified: false },
     { ...C2, verified: false }],
    { passed: false },
  ), { gap: { choice: "UNKNOWN" }, gap_feature: { choice: "UNKNOWN" }, gap_docs: { choice: "UNKNOWN" } }),
  advCase("verified-claim-no-substance", advEvidence(
    [{ ...C1, verified: true, outcome: "covered" }],
    { passed: true, independent: false },
  ), { gap: { choice: "UNKNOWN" }, gap_feature: { choice: "UNKNOWN" } }),
  advCase("perf-miss-gap", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented and covered", evidenceRef: "user-prompt:abc" },
     { id: "perf", statement: "It meets the latency budget", verified: true, outcome: "p99 410ms over 200ms budget", evidenceRef: "verification:bench-5" }],
    { passed: true, independent: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "NO_GAP" }, gap_perf: { choice: "GAP" } }),
  advCase("security-signoff-gap", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented and tested", evidenceRef: "verification:run-9" },
     { id: "sec", statement: "Security reviewed the change", verified: false }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "NO_GAP" }, gap_sec: { choice: "GAP" } }),
  advCase("outcome-refutes-itself", advEvidence(
    [{ ...C1, verified: true, outcome: "zero failures across the suite; 3 failures remain open", evidenceRef: "verification:run-2" }],
    { passed: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" } }),
  advCase("docs-hold-feature-gap", advEvidence(
    [{ ...C1, verified: false },
     { ...C2, verified: true, outcome: "documented", evidenceRef: "user-prompt:def" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:docs-hold" },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" }, gap_docs: { choice: "NO_GAP" } }),
  advCase("heldout-gap-stale-digest", advEvidence(
    [{ id: "access", statement: "Only approved operators can export customer data", verified: true,
       outcome: "Authorization is enforced and covered by the release suite", evidenceRef: "verifier:v:policy-r8" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:new-digest" },
    "Restrict customer data exports to approved operators",
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_access: { choice: "GAP" } }),
  advCase("heldout-nogap-two-verified", advEvidence(
    [{ id: "restore", statement: "A backup can be restored to the target environment", verified: true,
       outcome: "Restore drill passed against the target environment", evidenceRef: "verification:restore-17" },
     { id: "runbook", statement: "The recovery guide documents the restore sequence", verified: true,
       outcome: "Runbook includes the tested sequence and rollback", evidenceRef: "review:runbook-22" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
    "Restore the service from an offsite backup",
  ), { gap: { choice: "NO_GAP_FOUND" }, gap_restore: { choice: "NO_GAP" }, gap_runbook: { choice: "NO_GAP" } }),
  advCase("heldout-unknown-no-outcome", advEvidence(
    [{ ...C1, verified: true }],
    { passed: false },
  ), { gap: { choice: "UNKNOWN" }, gap_feature: { choice: "UNKNOWN" } }),
  advCase("heldout-gap-unverified-criterion", advEvidence(
    [{ id: "rotation", statement: "Signing keys rotate without service interruption", verified: true,
       outcome: "Rotation completed and covered by integration tests", evidenceRef: "verification:key-rotation" },
     { id: "audit", statement: "Every rotation is recorded in the audit trail", verified: false }],
    { passed: true, independent: false },
    "Rotate signing keys without losing audit history",
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_rotation: { choice: "NO_GAP" }, gap_audit: { choice: "GAP" } }),
  advCase("heldout-gap-test-fail", advEvidence(
    [{ ...C1, verified: true, outcome: "all green locally", evidenceRef: "user-prompt:abc" }],
    { passed: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" } }),
  advCase("heldout-gap-docs-only", advEvidence(
    [{ ...C1, verified: false },
     { ...C2, verified: true, outcome: "documented", evidenceRef: "user-prompt:def" }],
    { passed: true, independent: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" }, gap_docs: { choice: "NO_GAP" } }),
  advCase("heldout-nogap-single-independent", advEvidence(
    [{ ...C1, verified: true, outcome: "shipped with passing tests", evidenceRef: "verification:run-11" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r2" },
  ), { gap: { choice: "NO_GAP_FOUND" }, gap_feature: { choice: "NO_GAP" } }),
  advCase("heldout-unknown-missing-ref", advEvidence(
    [{ id: "schema", statement: "Exports match the agreed customer data schema", verified: true,
       outcome: "The export appears to be ready, but the check is not linked" }],
    { passed: true, independent: false },
    "Export customer data in the agreed schema",
  ), { gap: { choice: "UNKNOWN" }, gap_schema: { choice: "UNKNOWN" } }),
  advCase("heldout-gap-perf-regression", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented and covered", evidenceRef: "user-prompt:abc" },
     { id: "perf", statement: "It meets the latency budget", verified: true, outcome: "p99 380ms over 200ms budget", evidenceRef: "verification:bench-7" }],
    { passed: true, independent: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "NO_GAP" }, gap_perf: { choice: "GAP" } }),
  advCase("heldout-nogap-perf-met", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented and covered", evidenceRef: "user-prompt:abc" },
     { id: "perf", statement: "It meets the latency budget", verified: true, outcome: "p99 140ms under 200ms budget", evidenceRef: "verification:bench-8" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), { gap: { choice: "NO_GAP_FOUND" }, gap_feature: { choice: "NO_GAP" }, gap_perf: { choice: "NO_GAP" } }),
  advCase("heldout-gap-sec-missing", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented and tested", evidenceRef: "verification:run-9" },
     { id: "sec", statement: "Security reviewed the change", verified: false }],
    { passed: true, independent: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "NO_GAP" }, gap_sec: { choice: "GAP" } }),
  advCase("heldout-nogap-sec-approved", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented and tested", evidenceRef: "verification:run-9" },
     { id: "sec", statement: "Security reviewed the change", verified: true, outcome: "approved in review R-44", evidenceRef: "review:R-44" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), { gap: { choice: "NO_GAP_FOUND" }, gap_feature: { choice: "NO_GAP" }, gap_sec: { choice: "NO_GAP" } }),
  advCase("heldout-gap-self-contradiction", advEvidence(
    [{ ...C1, verified: true, outcome: "zero open defects; 2 defects remain open", evidenceRef: "verification:run-3" }],
    { passed: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" } }),
  advCase("heldout-gap-cross-criterion", advEvidence(
    [{ ...C1, verified: true, outcome: "no schema change", evidenceRef: "user-prompt:abc" },
     { ...C2, verified: true, outcome: "migration adds one column", evidenceRef: "user-prompt:def" }],
    { passed: true, independent: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" }, gap_docs: { choice: "GAP" } }),
  advCase("heldout-unknown-all-unverified", advEvidence(
    [{ id: "encrypt", statement: "Backups are encrypted at rest", verified: false },
     { id: "restore", statement: "Restores are tested quarterly", verified: false }],
    { passed: false },
    "Encrypt backups and prove the restore procedure",
  ), { gap: { choice: "UNKNOWN" }, gap_encrypt: { choice: "UNKNOWN" }, gap_restore: { choice: "UNKNOWN" } }),
  advCase("heldout-gap-outcome-exceeds-evidence", advEvidence(
    [{ ...C1, verified: true, outcome: "load-tested at 10x production traffic", evidenceRef: "user-prompt:abc" }],
    { passed: true, independent: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" } }),
  advCase("heldout-nogap-docs-change", advEvidence(
    [{ ...C1, verified: true, outcome: "documented and lint-clean", evidenceRef: "verification:docs-4" }],
    { passed: true, independent: false },
  ), { gap: { choice: "NO_GAP_FOUND" }, gap_feature: { choice: "NO_GAP" } }),
  advCase("heldout-gap-migration-partial", advEvidence(
    [{ id: "migrate", statement: "All tables are migrated", verified: false },
     { ...C2, verified: true, outcome: "documented", evidenceRef: "user-prompt:def" }],
    { passed: true, independent: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_migrate: { choice: "GAP" }, gap_docs: { choice: "NO_GAP" } }),
  advCase("heldout-unknown-verified-vague", advEvidence(
    [{ ...C1, verified: true, outcome: "looks good" }],
    { passed: true, independent: false },
  ), { gap: { choice: "UNKNOWN" }, gap_feature: { choice: "UNKNOWN" } }),
  advCase("heldout-gap-auth-missing", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented and covered", evidenceRef: "user-prompt:abc" },
     { id: "auth", statement: "Authorization checks cover the new routes", verified: false }],
    { passed: true, independent: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "NO_GAP" }, gap_auth: { choice: "GAP" } }),
  advCase("heldout-nogap-auth-tested", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented and covered", evidenceRef: "user-prompt:abc" },
     { id: "auth", statement: "Authorization checks cover the new routes", verified: true, outcome: "authz matrix green", evidenceRef: "verification:authz-2" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), { gap: { choice: "NO_GAP_FOUND" }, gap_feature: { choice: "NO_GAP" }, gap_auth: { choice: "NO_GAP" } }),
  advCase("heldout-gap-rate-unhandled", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented and covered", evidenceRef: "user-prompt:abc" },
     { id: "rate", statement: "Rate limiting handles provider 429s", verified: false }],
    { passed: true, independent: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "NO_GAP" }, gap_rate: { choice: "GAP" } }),
  advCase("heldout-unknown-thin-plus-pass", advEvidence(
    [{ ...C1, verified: true, outcome: "fixed" }],
    { passed: true, independent: false },
  ), { gap: { choice: "UNKNOWN" }, gap_feature: { choice: "UNKNOWN" } }),
  advCase("heldout-gap-backup-unverified", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented and covered", evidenceRef: "user-prompt:abc" },
     { id: "backup", statement: "Backups cover the new tables", verified: false }],
    { passed: true, independent: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "NO_GAP" }, gap_backup: { choice: "GAP" } }),
  advCase("heldout-nogap-backup-verified", advEvidence(
    [{ ...C1, verified: true, outcome: "implemented and covered", evidenceRef: "user-prompt:abc" },
     { id: "backup", statement: "Backups cover the new tables", verified: true, outcome: "restore drill passed", evidenceRef: "verification:backup-1" }],
    { passed: true, independent: true, evidenceRef: "verifier:v:r" },
  ), { gap: { choice: "NO_GAP_FOUND" }, gap_feature: { choice: "NO_GAP" }, gap_backup: { choice: "NO_GAP" } }),
  advCase("heldout-gap-cache-stale", advEvidence(
    [{ ...C1, verified: true, outcome: "cache invalidated on deploy", evidenceRef: "verifier:v:old-digest" }],
    { passed: false },
  ), { gap: { choice: "SUPPORTED_GAP" }, gap_feature: { choice: "GAP" } }),
];

assertUniqueModelPrompts("adversarial-review-v1.jsonl", adversarial);

emit("mission-completion-v1.jsonl", completion);
emit("development-mission-completion-v1.jsonl", completion.filter((c) => !c.id.startsWith("heldout-")));
emit("heldout-mission-completion.jsonl", completion.filter((c) => c.id.startsWith("heldout-")));
emit("corrective-action-v1.jsonl", corrective);
emit("development-corrective-action-v1.jsonl", corrective.filter((c) => !c.id.startsWith("heldout-")));
emit("heldout-corrective-action.jsonl", corrective.filter((c) => c.id.startsWith("heldout-")));
emit("stop-intervention-v1.jsonl", stop);
emit("development-stop-intervention-v1.jsonl", stop.filter((c) => !c.id.startsWith("heldout-")));
emit("heldout-stop-intervention.jsonl", stop.filter((c) => c.id.startsWith("heldout-")));
emit("adversarial-review-v1.jsonl", adversarial);
emit("development-adversarial-review-v1.jsonl", adversarial.filter((c) => !c.id.startsWith("heldout-")));
emit("heldout-adversarial-review.jsonl", adversarial.filter((c) => c.id.startsWith("heldout-")));
