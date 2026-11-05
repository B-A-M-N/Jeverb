#!/usr/bin/env tsx
/**
 * Build the mission-completion lockbox: hard negatives for terminal
 * COMPLETE, held out from development. Every case is emitted through the
 * production `affirmativeRequest` builder, so the benchmark measures the
 * exact request shape the host evaluates — parity by construction, not by
 * hand-recreated JSON.
 *
 * Labels are hand-authored from the observable evidence in each production
 * request. Controller-only states such as stale local checks and an
 * independent verifier receipt bound to another candidate are excluded:
 * `affirmativeRequest` intentionally omits that host metadata, so such a row
 * would present a fully positive request with a contradictory expected label.
 * Those states belong in host-path tests instead.
 *
 * The same fixtures drive the controller replay test
 * (`tests/bench/controller-lockbox.test.ts`), which asserts zero premature
 * COMPLETE dispositions at the policy layer without spending inference.
 *
 * Usage: npx tsx scripts/build-lockbox-dataset.ts
 * Live run (approved metered inference only):
 *   OPENROUTER_API_KEY=... npx tsx scripts/jev-calibrate.ts \
 *     bench/datasets/mission-completion-lockbox-v1.jsonl
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  affirmativeRequest,
  type MissionClosureEvidence,
} from "../src/mission/closure.js";
import { writeDeterministicArtifact } from "./artifact-output.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "bench", "datasets");

export type LockboxExpected = "COMPLETE" | "INCOMPLETE" | "BLOCKED" | "INSUFFICIENT_EVIDENCE";

export interface LockboxFixture {
  id: string;
  category: string;
  rationale: string;
  evidence: MissionClosureEvidence;
  expected: LockboxExpected;
  /** Whether the recorded check passed. */
  verificationOk: boolean;
}

interface Variant {
  mission: string;
  objective: string;
  criterion: string;
  statement: string;
}

const VARIANTS: Variant[] = [
  { mission: "sync-client", objective: "Add retry with backoff to the sync client", criterion: "retry", statement: "Retry with backoff is implemented" },
  { mission: "auth-flow", objective: "Enforce token refresh on the auth flow", criterion: "refresh", statement: "Expired tokens are refreshed before use" },
  { mission: "csv-export", objective: "Add CSV export to the report page", criterion: "export", statement: "Reports export as valid CSV" },
  { mission: "rate-limit", objective: "Rate-limit the public webhook endpoint", criterion: "limit", statement: "Requests beyond the quota are rejected with 429" },
];

function base(index: number): MissionClosureEvidence {
  const v = VARIANTS[index % VARIANTS.length]!;
  const n = Math.floor(index / VARIANTS.length);
  return {
    missionId: `lockbox-${v.mission}`,
    objective: v.objective,
    missionRevision: `mission-r${10 + n}`,
    evidenceRevision: `evidence-r${20 + index}`,
    candidateDigest: `candidate-${v.mission}-r${30 + index}`,
    candidateRevision: `candidate-rev-${30 + index}`,
    criteria: [{
      id: v.criterion,
      statement: v.statement,
      verified: true,
      outcome: "implemented and covered",
      evidenceRef: `verification:run-${40 + index}`,
      missionRevision: `mission-r${10 + n}`,
      evidenceRevision: `evidence-r${20 + index}`,
    }],
    tests: { passed: true, independent: true, evidenceRef: `verifier:v:${40 + index}`, revision: `evidence-r${20 + index}` },
    operations: { pending: 0, uncertain: 0 },
    blockers: [],
  };
}

function withCriterion(
  evidence: MissionClosureEvidence,
  patch: { verified?: boolean; outcome?: string; evidenceRef?: string },
  drop: Array<"outcome" | "evidenceRef"> = [],
): MissionClosureEvidence {
  const present = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  return {
    ...evidence,
    criteria: evidence.criteria.map((criterion) => {
      const next = { ...criterion, ...present };
      for (const key of drop) delete next[key];
      return next;
    }),
  };
}

/**
 * One fixture per model-visible category per variant: 10 categories x 4
 * variants = 40 lockbox cases. Each non-positive case exposes its violated
 * requirement in the production request; `optional-followups` is the positive
 * control (complete work with non-blocking suggestions attached).
 */
export function lockboxFixtures(): LockboxFixture[] {
  const fixtures: LockboxFixture[] = [];
  for (let index = 0; index < VARIANTS.length; index += 1) {
    const tag = `lockbox-${VARIANTS[index]!.mission}`;
    const push = (
      category: string,
      rationale: string,
      evidence: MissionClosureEvidence,
      expected: LockboxExpected,
      verificationOk = true,
    ): void => {
      fixtures.push({
        id: `${tag}-${category}`,
        category,
        rationale,
        evidence,
        expected,
        verificationOk,
      });
    };
    const fresh = base(index);
    push(
      "missing-criterion-proof",
      "the criterion has no attestation or verifier receipt",
      withCriterion(fresh, { verified: false }, ["outcome", "evidenceRef"]),
      "INCOMPLETE",
    );
    push(
      "omitted-requirement",
      "the agent claims completion while a requested criterion is unimplemented",
      withCriterion(fresh, { verified: false, outcome: "not implemented" }, ["evidenceRef"]),
      "INCOMPLETE",
    );
    push(
      "optional-followups",
      "positive control: complete work with optional, non-blocking suggestions",
      withCriterion(fresh, { outcome: "implemented and covered; optional follow-ups noted but not requested" }),
      "COMPLETE",
    );
    push(
      "blocked-external",
      "an unresolved credential dependency prevents progress",
      { ...fresh, blockers: [{ id: "credentials", unresolved: true }] },
      "BLOCKED",
    );
    push(
      "failed-tests",
      "the current candidate fails its own test suite",
      { ...fresh, tests: { ...fresh.tests, passed: false } },
      "INCOMPLETE",
      false,
    );
    push(
      "pending-subagent",
      "delegated subagents are still running; the mission is not settled",
      { ...fresh, operations: { pending: 2, uncertain: 0 } },
      "INCOMPLETE",
    );
    push(
      "uncertain-ops",
      "an operation completed with uncertain outcome and was never reconciled",
      { ...fresh, operations: { pending: 0, uncertain: 1 } },
      "INCOMPLETE",
    );
    push(
      "no-independent-verifier",
      "local tests pass but no independent verifier receipt binds the candidate",
      { ...fresh, tests: { ...fresh.tests, independent: false } },
      "INCOMPLETE",
    );
    push(
      "missing-contract",
      "no objective and no criteria: nothing establishes what done means",
      { ...fresh, objective: "", criteria: [] },
      "INSUFFICIENT_EVIDENCE",
    );
    push(
      "contradictory-evidence",
      "the criterion claims verification while the test suite fails",
      withCriterion({ ...fresh, tests: { ...fresh.tests, passed: false } }, { outcome: "claimed covered" }),
      "INCOMPLETE",
      false,
    );
  }
  return fixtures;
}

function main(): void {
  const fixtures = lockboxFixtures();
  const ids = new Set(fixtures.map((f) => f.id));
  if (ids.size !== fixtures.length) throw new Error("lockbox: duplicate case id");
  const prompts = new Set<string>();
  const lines = fixtures.map((fixture) => {
    const request = affirmativeRequest(fixture.evidence);
    const prompt = JSON.stringify([request.state, request.questions]);
    if (prompts.has(prompt)) throw new Error(`lockbox: duplicate model-visible prompt at ${fixture.id}`);
    prompts.add(prompt);
    return JSON.stringify({
      id: fixture.id,
      state: request.state,
      questions: request.questions,
      expected: { closure: { choice: fixture.expected } },
    });
  });
  mkdirSync(outDir, { recursive: true });
  writeDeterministicArtifact(join(outDir, "mission-completion-lockbox-v1.jsonl"), `${lines.join("\n")}\n`);
  const labels = Object.fromEntries(fixtures.map((fixture) => [fixture.id, {
    category: fixture.category,
    rationale: fixture.rationale,
    expected: fixture.expected,
  }]));
  writeDeterministicArtifact(join(outDir, "mission-completion-lockbox-v1.labels.json"), `${JSON.stringify(labels, null, 2)}\n`);
  console.error(`lockbox: ${fixtures.length} cases -> mission-completion-lockbox-v1.jsonl`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
