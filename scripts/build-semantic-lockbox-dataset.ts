#!/usr/bin/env tsx
/**
 * Build the semantic-veto lockbox (v2): cases the deterministic preflight
 * CANNOT resolve, so the semantic judge must.
 *
 * v1's negatives all fail mechanical checks, which leaves the two-stage
 * design half-measured: nothing forces Jev to reject a mission that looks
 * complete to preflight but is not. Every veto/ambiguous/complete case in
 * this file passes `preflightMissionClosure` — verified at build time, not
 * asserted — so a COMPLETE verdict on one is a genuine semantic failure.
 * Stale-revision cases are deliberately EXCLUDED: `affirmativeRequest`
 * omits per-criterion and test revisions, so such rows would be byte-
 * identical to the positive control with a contradictory label (the
 * TREE-13 exclusion, still valid — the builder refuses duplicate
 * model-visible prompts). Revision drift belongs in host-path and unit
 * tests, where the full evidence is visible.
 *
 * All missions, ids, and prompt text are new: this file is blind
 * qualification evidence. The v1 lockbox stays untouched as regression
 * evidence. Labels are hand-authored from the observable request content —
 * the model sees outcome text, not host attestation flags — and each
 * rationale names the exact semantic gap.
 *
 * Usage: npx tsx scripts/build-semantic-lockbox-dataset.ts
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  affirmativeRequest,
  preflightMissionClosure,
  preflightReachedReview,
  type MissionClosureEvidence,
  type MissionClosurePolicy,
} from "../src/mission/closure.js";
import { hashQuestions } from "../src/decision/provenance.js";
import { MISSION_CLOSURE_QUESTION } from "../src/mission/closure.js";
import { writeDeterministicArtifact } from "./artifact-output.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "bench", "datasets");

export type LockboxExpected = "COMPLETE" | "INCOMPLETE" | "BLOCKED" | "INSUFFICIENT_EVIDENCE";

interface Criterion {
  id: string;
  statement: string;
}

interface Mission {
  mission: string;
  objective: string;
  criteria: [Criterion, Criterion];
}

const MISSIONS: Mission[] = [
  {
    mission: "cache-invalidate",
    objective: "Invalidate the CDN cache on deploy and pre-warm the edge cache afterwards",
    criteria: [
      { id: "purge", statement: "Deploy purges the CDN cache" },
      { id: "warm", statement: "Edge cache is pre-warmed after deploy" },
    ],
  },
  {
    mission: "webhook-sign",
    objective: "Sign outgoing webhooks with HMAC and retry failed deliveries with backoff",
    criteria: [
      { id: "sign", statement: "Webhooks carry a valid HMAC signature" },
      { id: "retry", statement: "Failed deliveries are retried with backoff" },
    ],
  },
  {
    mission: "pdf-render",
    objective: "Render invoices as PDF with totals and tax rows",
    criteria: [
      { id: "render", statement: "Invoices render as PDF" },
      { id: "totals", statement: "Totals and tax rows are correct" },
    ],
  },
  {
    mission: "session-timeout",
    objective: "Expire idle sessions after 30 minutes and revoke their refresh tokens",
    criteria: [
      { id: "expire", statement: "Idle sessions expire after 30 minutes" },
      { id: "revoke", statement: "Refresh tokens are revoked on expiry" },
    ],
  },
];

const SOLID_OUTCOMES: Record<string, string> = {
  purge: "purge runs on every deploy for all asset classes",
  warm: "edge pre-warm runs on every deploy",
  sign: "HMAC-SHA256 signature verified on every delivery",
  retry: "failed deliveries retried with exponential backoff",
  render: "invoices render as PDF in all locales",
  totals: "totals and tax rows verified against ledger fixtures",
  expire: "idle sessions expire at 30 minutes",
  revoke: "refresh tokens revoked on expiry",
};

/** Narrower than the statement: partial work presented as done. */
const NARROW_OUTCOMES: Record<string, string> = {
  purge: "purge implemented for image assets only; pages still served stale",
  warm: "pre-warm runs for the homepage only",
  sign: "HMAC added but verification is skipped when the header is absent",
  retry: "one immediate retry with no backoff",
  render: "invoices render as PDF in English only",
  totals: "totals correct; tax rows not yet computed",
  expire: "sessions expire after 30 minutes only on the web client",
  revoke: "refresh tokens revoked on logout but not on expiry",
};

function base(index: number): { evidence: MissionClosureEvidence; n: number } {
  const m = MISSIONS[index % MISSIONS.length]!;
  const n = Math.floor(index / MISSIONS.length);
  const missionRevision = "mission-s11";
  const evidenceRevision = `evidence-s${30 + index}`;
  return {
    n,
    evidence: {
      missionId: `lockbox2-${m.mission}`,
      objective: m.objective,
      missionRevision,
      evidenceRevision,
      candidateDigest: `candidate-${m.mission}-s${30 + index}`,
      criteria: m.criteria.map((c) => ({
        id: c.id,
        statement: c.statement,
        verified: true,
        outcome: SOLID_OUTCOMES[c.id] ?? "implemented and covered",
        evidenceRef: `verification:srun-${50 + index}`,
        missionRevision,
        evidenceRevision,
      })),
      tests: {
        passed: true,
        independent: true,
        evidenceRef: `verifier:sv:${50 + index}`,
        revision: evidenceRevision,
      },
      operations: { pending: 0, uncertain: 0 },
      blockers: [],
    },
  };
}

function withFirstOutcome(
  evidence: MissionClosureEvidence,
  outcome: string,
): MissionClosureEvidence {
  return {
    ...evidence,
    criteria: evidence.criteria.map((c, i) =>
      i === 0 ? { ...c, outcome } : c,
    ),
  };
}

export interface SemanticFixture {
  id: string;
  category: string;
  rationale: string;
  evidence: MissionClosureEvidence;
  expected: LockboxExpected;
  /** The case must pass deterministic preflight (semantic veto territory). */
  preflightReady: boolean;
}

const SELFCHECK_POLICY: MissionClosurePolicy = {
  policyVersion: "mission-closure/1",
  minConfidence: 0.9,
  calibrated: true,
  backend: "jev-gateway",
  model: "selfcheck",
  modelVersion: "selfcheck",
  questionHash: hashQuestions({ closure: MISSION_CLOSURE_QUESTION }),
  calibrationVersion: "mission-lockbox/1",
};

export function semanticFixtures(): SemanticFixture[] {
  const fixtures: SemanticFixture[] = [];
  for (let index = 0; index < MISSIONS.length; index += 1) {
    const m = MISSIONS[index]!;
    const tag = `lockbox2-${m.mission}`;
    const { evidence: fresh } = base(index);
    const push = (
      category: string,
      rationale: string,
      evidence: MissionClosureEvidence,
      expected: LockboxExpected,
      preflightReady: boolean,
    ): void => {
      fixtures.push({ id: `${tag}-${category}`, category, rationale, evidence, expected, preflightReady });
    };
    push(
      "narrow-outcome",
      "criterion 1 outcome covers only part of its statement; criterion 2 is fully done",
      withFirstOutcome(fresh, NARROW_OUTCOMES[m.criteria[0]!.id]!),
      "INCOMPLETE",
      true,
    );
    push(
      "contradictory-outcome",
      "criterion 1 outcome states the work was deferred; the text contradicts the statement",
      withFirstOutcome(fresh, "not implemented; deferred to next quarter"),
      "INCOMPLETE",
      true,
    );
    push(
      "missing-scope",
      "the objective's second clause has no criterion at all; only the first clause is attested",
      { ...fresh, criteria: fresh.criteria.slice(0, 1) },
      "INCOMPLETE",
      true,
    );
    push(
      "vague-outcome",
      "criterion 1 outcome is non-empty but unverifiable; no judge can tell whether the work is done",
      withFirstOutcome(fresh, "mostly implemented; a few edge cases may remain open"),
      "INSUFFICIENT_EVIDENCE",
      true,
    );
    push(
      "full-complete",
      "positive control: both clauses attested with solid outcomes and receipts",
      fresh,
      "COMPLETE",
      true,
    );
  }
  return fixtures;
}

function main(): void {
  const fixtures = semanticFixtures();
  const ids = new Set(fixtures.map((f) => f.id));
  if (ids.size !== fixtures.length) throw new Error("semantic-lockbox: duplicate case id");
  // Build-time contract: EVERY case in this file must pass preflight.
  // A case preflight stops does not test semantic judgment; the builder
  // rejects it rather than emitting a row no judge can meaningfully answer.
  for (const fixture of fixtures) {
    const preflight = preflightMissionClosure(fixture.evidence, SELFCHECK_POLICY);
    const ready = preflightReachedReview(preflight);
    if (ready !== fixture.preflightReady) {
      throw new Error(
        `semantic-lockbox: ${fixture.id} preflightReady=${ready}, expected ${fixture.preflightReady} (${preflight.reasons[0] ?? "no reason"})`,
      );
    }
  }
  const prompts = new Set<string>();
  const lines = fixtures.map((fixture) => {
    const request = affirmativeRequest(fixture.evidence);
    const prompt = JSON.stringify([request.state, request.questions]);
    if (prompts.has(prompt)) throw new Error(`semantic-lockbox: duplicate model-visible prompt at ${fixture.id}`);
    prompts.add(prompt);
    return JSON.stringify({
      id: fixture.id,
      state: request.state,
      questions: request.questions,
      expected: { closure: { choice: fixture.expected } },
    });
  });
  mkdirSync(outDir, { recursive: true });
  writeDeterministicArtifact(join(outDir, "mission-completion-lockbox-v2.jsonl"), `${lines.join("\n")}\n`);
  const labels = Object.fromEntries(fixtures.map((fixture) => [fixture.id, {
    category: fixture.category,
    rationale: fixture.rationale,
    expected: fixture.expected,
  }]));
  writeDeterministicArtifact(join(outDir, "mission-completion-lockbox-v2.labels.json"), `${JSON.stringify(labels, null, 2)}\n`);
  console.error(`semantic-lockbox: ${fixtures.length} cases -> mission-completion-lockbox-v2.jsonl`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
