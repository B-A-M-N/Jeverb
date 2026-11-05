#!/usr/bin/env tsx
/**
 * Build development, validation, and sealed-final mission-closure datasets.
 *
 * Outputs (bench/datasets/):
 *   mission-completion-dev-v3.jsonl + .labels.json    (32 cases: 12+/20-)
 *   mission-completion-validation-v3.jsonl + .labels.json (32 cases: 12+/20-)
 *   mission-completion-lockbox-v3.jsonl + .labels.json   (216 cases: 64+/152-)
 *   mission-completion-lockbox-v3.freeze.json (hashes, counts, protocol)
 *
 * The v3 lockbox is SEALED blind evidence: never use it to tune prompts,
 * models, or thresholds. Tune only on dev/validation. v1/v2 stay as
 * regression evidence; all v3 missions, ids, and prompt text are new.
 *
 * Build-time contracts (throw rather than emit a bad row):
 * - every case passes/fails preflight exactly as its category declares
 *   (verified, not asserted: runs preflightMissionClosure locally)
 * - no duplicate case ids, no duplicate model-visible prompts
 *   (TREE-13: stale-revision rows are excluded — affirmativeRequest omits
 *   per-criterion revisions, so such rows would collide with contradictory
 *   labels)
 * - cross-split id disjointness against v1, v2, dev-v1, heldout, and
 *   among the three new files; near-duplicate scan on normalized prompts
 * - every row parses under parseCalibrationDataset with a valid closure label
 * - label/preflight consistency: COMPLETE implies preflight-ready;
 *   BLOCKED implies preflight-stopped-as-BLOCKED
 *
 * No model calls are made. Labels are hand-authored from observable request
 * content; the rationale names the exact semantic gap.
 *
 * Usage: npx tsx scripts/build-final-lockbox-datasets.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  affirmativeRequest,
  MISSION_CLOSURE_QUESTION,
  preflightMissionClosure,
  preflightReachedReview,
  type MissionClosureEvidence,
  type MissionClosurePolicy,
} from "../src/mission/closure.js";
import { hashQuestions } from "../src/decision/provenance.js";
import { parseCalibrationDataset } from "../src/jev/calibration.js";
import { writeDeterministicArtifact } from "./artifact-output.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "bench", "datasets");

export type FinalExpected = "COMPLETE" | "INCOMPLETE" | "BLOCKED" | "INSUFFICIENT_EVIDENCE";

interface CriterionTemplate {
  id: string;
  statement: string;
  solidA: string;
  solidB: string;
  /** Narrower than the statement: partial work presented as done. */
  narrow: string;
}

interface MissionTemplate {
  key: string;
  objective: string;
  criteria: CriterionTemplate[];
}

const MISSIONS: MissionTemplate[] = [
  {
    key: "billing-refund",
    objective: "Refund prorated amounts on plan downgrades and notify the account owner",
    criteria: [
      { id: "prorate", statement: "Downgrades trigger a prorated refund", solidA: "prorated refunds issued on every downgrade", solidB: "refund math verified against ledger fixtures for all plan pairs", narrow: "refunds issued for monthly plans only; annual plans still manual" },
      { id: "notify", statement: "The account owner is notified of the refund", solidA: "owner notified by email with the refund receipt", solidB: "notification sent with receipt link on every refund", narrow: "notified for refunds over $50 only" },
    ],
  },
  {
    key: "search-index",
    objective: "Index new documents within a minute and rank exact title matches first",
    criteria: [
      { id: "freshness", statement: "New documents are searchable within a minute", solidA: "p99 index latency 41 seconds on the prod topic", solidB: "freshness probe green for seven days on the prod topic", narrow: "freshness met for text docs; PDFs lag by an hour" },
      { id: "ranking", statement: "Exact title matches rank first", solidA: "title-match boost verified on the fixture query set", solidB: "exact title matches rank first across all fixture queries", narrow: "title boost applies to English titles only" },
    ],
  },
  {
    key: "backup-restore",
    objective: "Take nightly encrypted backups and restore a full account in under an hour",
    criteria: [
      { id: "nightly", statement: "Encrypted backups run every night", solidA: "nightly AES-256 backups completed 30 days running", solidB: "backup job green 30 nights with checksum receipts", narrow: "backups run nightly for the primary region only" },
      { id: "restore", statement: "A full account restores in under an hour", solidA: "full restore drill completed in 38 minutes", solidB: "restore drill passed twice, 38 and 44 minutes", narrow: "restore drill covered data only; attachments skipped" },
    ],
  },
  {
    key: "notify-sms",
    objective: "Deliver one-time codes by SMS within ten seconds and cap retries at three",
    criteria: [
      { id: "latency", statement: "Codes arrive within ten seconds", solidA: "p99 delivery latency 6.2 seconds across carriers", solidB: "delivery probe green across all carriers for a week", narrow: "latency met on two carriers; the third averages 25 seconds" },
      { id: "retries", statement: "Delivery retries are capped at three", solidA: "retry counter capped at three with backoff", solidB: "cap verified in carrier sandbox for all error classes", narrow: "cap enforced for timeouts; gateway errors retry forever" },
    ],
  },
  {
    key: "rate-limit",
    objective: "Enforce per-key rate limits on the public API and return Retry-After headers",
    criteria: [
      { id: "enforce", statement: "Per-key rate limits are enforced", solidA: "limits enforced per key at the edge on every route", solidB: "soak test held the configured limits for 24 hours", narrow: "limits enforced on read routes; write routes unmetered" },
      { id: "headers", statement: "Rejected requests carry Retry-After headers", solidA: "Retry-After present on every 429 in the fixture sweep", solidB: "header asserted on all 429 responses in staging", narrow: "header present on JSON responses; HTML error pages omit it" },
    ],
  },
  {
    key: "audit-log",
    objective: "Record every admin action in the tamper-evident audit log with actor identity",
    criteria: [
      { id: "record", statement: "Every admin action is recorded", solidA: "action coverage diffed against the route table: 100%", solidB: "route-table diff shows zero unlogged admin actions", narrow: "recorded for settings pages; bulk import actions missing" },
      { id: "identity", statement: "Each record carries the actor identity", solidA: "actor identity present on every record in the sample", solidB: "identity field asserted across the sampled week", narrow: "identity present for human actors; service accounts log as system" },
    ],
  },
  {
    key: "feature-flag",
    objective: "Roll out the new checkout behind a flag and keep the old path until cutover",
    criteria: [
      { id: "flagged", statement: "New checkout is flag-gated", solidA: "flag gates 100% of checkout traffic paths", solidB: "flag evaluated on every checkout request in staging", narrow: "flag gates the cart page; the payment step bypasses it" },
      { id: "fallback", statement: "Old path serves until cutover", solidA: "old path served 100% of control traffic during the test", solidB: "control cohort stayed on the old path for the full window", narrow: "old path kept for desktop; mobile redirects to the new flow" },
    ],
  },
  {
    key: "cert-rotate",
    objective: "Rotate TLS certificates automatically before expiry and alert on failure",
    criteria: [
      { id: "rotate", statement: "Certificates rotate automatically before expiry", solidA: "rotation ran 14 days before expiry on all domains", solidB: "dry-run rotation green across the domain set", narrow: "auto-rotation covers public domains; internal certs manual" },
      { id: "alert", statement: "Failures raise an operator alert", solidA: "failed rotation paged the operator in the chaos drill", solidB: "alert fired within a minute in the induced-failure drill", narrow: "alerts fire for expiry; issuance failures are silent" },
    ],
  },
  {
    key: "log-retention",
    objective: "Retain request logs for 90 days and redact card numbers before storage",
    criteria: [
      { id: "retain", statement: "Request logs are retained for 90 days", solidA: "oldest retrievable log is 91 days old", solidB: "retention probe fetched day-90 logs successfully", narrow: "90-day retention for app logs; edge logs kept 7 days" },
      { id: "redact", statement: "Card numbers are redacted before storage", solidA: "PAN patterns absent from a full day of stored logs", solidB: "redaction filter passed the PAN fixture corpus", narrow: "redaction covers request bodies; query strings unfiltered" },
    ],
  },
  {
    key: "pagination",
    objective: "Paginate the admin user list at fifty rows and keep sort order stable across pages",
    criteria: [
      { id: "pages", statement: "Lists paginate at fifty rows", solidA: "page size fixed at fifty across the admin list", solidB: "cursor pagination asserted at fifty rows per page", narrow: "pagination works for name sort; date sort loads everything" },
      { id: "stable", statement: "Sort order is stable across pages", solidA: "no row repeats or gaps across a full traversal", solidB: "full traversal twice with zero drift", narrow: "stable for active users; archived users shuffle between pages" },
    ],
  },
  {
    key: "oauth-scope",
    objective: "Request only the calendar read scope at signup and explain each scope in product language",
    criteria: [
      { id: "minimal", statement: "Only the calendar read scope is requested", solidA: "consent screen shows exactly the calendar read scope", solidB: "scope audit of the signup flow lists one scope", narrow: "minimal scopes for new signups; legacy flow asks for mail too" },
      { id: "explain", statement: "Each scope is explained in product language", solidA: "scope explainer reviewed by support for plain language", solidB: "explainer text approved in the copy review", narrow: "explainer shown for calendar; contacts scope unexplained" },
    ],
  },
  {
    key: "cache-ttl",
    objective: "Serve product pages from cache with a five-minute TTL and purge on price change",
    criteria: [
      { id: "ttl", statement: "Product pages cache with a five-minute TTL", solidA: "TTL measured at 300 seconds on sampled pages", solidB: "cache headers assert max-age 300 across the catalog", narrow: "TTL applies to in-stock items; sale items bypass cache" },
      { id: "purge", statement: "Price changes purge the cache", solidA: "price edit purged the page within ten seconds", solidB: "purge verified for every price edit in the test window", narrow: "purge runs for list prices; variant prices stay stale" },
    ],
  },
  {
    key: "queue-dlq",
    objective: "Route failed jobs to the dead-letter queue after five attempts and alert the owner",
    criteria: [
      { id: "route", statement: "Failed jobs land in the dead-letter queue", solidA: "poison jobs arrived in the DLQ after five attempts", solidB: "DLQ routing verified for every failure class", narrow: "routing works for timeouts; validation errors vanish" },
      { id: "alert", statement: "The job owner is alerted", solidA: "owner alerted within five minutes of DLQ arrival", solidB: "alert drill passed for all three owner channels", narrow: "alerts sent for the first failure; repeats are silent" },
    ],
  },
  {
    key: "health-probe",
    objective: "Expose liveness and readiness probes and fail readiness when the database is unreachable",
    criteria: [
      { id: "probes", statement: "Liveness and readiness probes are exposed", solidA: "both probes answer on the ops port in staging", solidB: "probe contract test green in CI", narrow: "liveness exposed; readiness endpoint returns 404" },
      { id: "dbfail", statement: "Readiness fails when the database is unreachable", solidA: "readiness went red within seconds of killing the database", solidB: "database-kill drill flipped readiness red twice", narrow: "readiness fails on connection loss; slow queries still report ready" },
    ],
  },
  {
    key: "metrics-dash",
    objective: "Publish checkout conversion on the team dashboard and refresh it every minute",
    criteria: [
      { id: "publish", statement: "Conversion is published on the dashboard", solidA: "conversion panel matches warehouse numbers within 1%", solidB: "panel reconciled against the warehouse for a week", narrow: "published for web checkout; mobile numbers missing" },
      { id: "refresh", statement: "The panel refreshes every minute", solidA: "refresh interval measured at 60 seconds", solidB: "staleness alert fires past 90 seconds without data", narrow: "refreshes every minute during business hours; hourly overnight" },
    ],
  },
  {
    key: "secret-rotate",
    objective: "Rotate database credentials every 30 days without downtime and keep the previous pair for a week",
    criteria: [
      { id: "rotate", statement: "Credentials rotate every 30 days without downtime", solidA: "rotation completed with zero failed queries", solidB: "two rotations observed, both without downtime", narrow: "rotation automated for the primary; replicas rotated by hand" },
      { id: "overlap", statement: "The previous pair stays valid for a week", solidA: "old pair accepted for seven days after rotation", solidB: "overlap window asserted in the rotation runbook test", narrow: "overlap honored for app servers; workers cut over instantly" },
    ],
  },
  {
    key: "cors-policy",
    objective: "Restrict cross-origin access to the partner dashboard origin and reject credentialed wildcard use",
    criteria: [
      { id: "restrict", statement: "Only the partner origin is allowed", solidA: "preflight allows exactly the partner origin", solidB: "origin sweep shows one allowed origin", narrow: "restricted in production; staging allows any origin with creds" },
      { id: "nowildcard", statement: "Credentialed wildcard responses are rejected", solidA: "wildcard-plus-credentials combos rejected in the sweep", solidB: "middleware test rejects every wildcard credential combo", narrow: "rejected for API routes; asset routes still wildcard" },
    ],
  },
  {
    key: "webhook-retry",
    objective: "Retry failed partner webhooks with backoff and sign each attempt",
    criteria: [
      { id: "backoff", statement: "Failures retry with backoff", solidA: "retry delays measured at 1s, 10s, 100s", solidB: "backoff schedule asserted in the partner sandbox", narrow: "backoff applies to 5xx; 429 responses retried immediately" },
      { id: "sign", statement: "Each attempt carries a valid signature", solidA: "signatures verified on all attempts including retries", solidB: "partner verified signatures across a retry storm", narrow: "first attempts signed; retries reuse the original signature" },
    ],
  },
  {
    key: "session-quota",
    objective: "Cap concurrent sessions at three per user and evict the oldest on overflow",
    criteria: [
      { id: "cap", statement: "Concurrent sessions are capped at three", solidA: "fourth login evicted exactly one session in the test", solidB: "cap asserted for password, SSO, and token logins", narrow: "cap enforced on web; mobile sessions are unlimited" },
      { id: "evict", statement: "The oldest session is evicted on overflow", solidA: "eviction order oldest-first confirmed in logs", solidB: "order verified across ten forced overflows", narrow: "oldest evicted except pinned admin sessions, which pile up" },
    ],
  },
  {
    key: "export-csv",
    objective: "Export transaction history as CSV with headers and stream rows for large accounts",
    criteria: [
      { id: "headers", statement: "Exports include the documented headers", solidA: "header row matches the data dictionary exactly", solidB: "dictionary diff green for all account types", narrow: "headers correct for USD accounts; EUR exports shift one column" },
      { id: "stream", statement: "Large exports stream instead of buffering", solidA: "million-row export held flat memory in the soak run", solidB: "memory profile flat across the million-row export", narrow: "streaming works over the API; the dashboard download buffers" },
    ],
  },
  {
    key: "sso-login",
    objective: "Support SSO login for workspace members and fall back to password for guests",
    criteria: [
      { id: "sso", statement: "Members can log in with SSO", solidA: "SSO round-trip green for all three identity providers", solidB: "provider matrix passed in staging", narrow: "SSO works with two providers; the third errors on groups" },
      { id: "fallback", statement: "Guests fall back to password login", solidA: "guest password path exercised end to end", solidB: "fallback asserted for every guest role", narrow: "fallback works for invited guests; self-serve guests loop" },
    ],
  },
  {
    key: "api-version",
    objective: "Serve API v2 alongside v1 during migration and sunset v1 with six months notice",
    criteria: [
      { id: "coexist", statement: "v1 and v2 serve side by side", solidA: "both versions answered the contract suite in staging", solidB: "contract suite green against both versions", narrow: "side by side for reads; v2 writes return 501" },
      { id: "sunset", statement: "v1 sunset carries six months notice", solidA: "sunset header names a date six months out", solidB: "deprecation notice reviewed by developer relations", narrow: "notice sent to active keys; dormant keys get none" },
    ],
  },
  {
    key: "deploy-freeze",
    objective: "Block deploys during the holiday freeze window and queue them for afterwards",
    criteria: [
      { id: "block", statement: "Deploys are blocked in the freeze window", solidA: "freeze-window deploy refused with a clear message", solidB: "refusal asserted for every deploy channel", narrow: "blocked for services; config-only changes still ship" },
      { id: "queue", statement: "Blocked deploys queue for afterwards", solidA: "queued deploy ran automatically when the window lifted", solidB: "queue drain verified after two freeze windows", narrow: "queued for the main branch; hotfix branches skip the queue" },
    ],
  },
  {
    key: "storage-tier",
    objective: "Move attachments older than a year to cold storage and keep them retrievable within a day",
    criteria: [
      { id: "move", statement: "Old attachments move to cold storage", solidA: "year-old attachments verified in cold storage", solidB: "tier audit matched policy for the sampled quarter", narrow: "moved for new accounts; legacy accounts untouched" },
      { id: "retrieve", statement: "Cold attachments retrieve within a day", solidA: "retrieval completed in eleven hours in the drill", solidB: "two retrieval drills finished inside the day budget", narrow: "retrieval met for small files; gigabyte archives timed out" },
    ],
  },
  {
    key: "password-reset",
    objective: "Deliver password reset links within a minute and expire them after one use",
    criteria: [
      { id: "deliver", statement: "Reset links arrive within a minute", solidA: "p99 email delivery 34 seconds in the test window", solidB: "delivery probe green across mailbox providers", narrow: "fast for major providers; corporate filters delay to ten minutes" },
      { id: "singleuse", statement: "Links expire after one use", solidA: "reused link rejected in the security test", solidB: "single-use asserted for every link in the test batch", narrow: "single-use enforced on web; the mobile deep link replays" },
    ],
  },
  {
    key: "invoice-tax",
    objective: "Apply regional tax rates to invoices and show the breakdown per line item",
    criteria: [
      { id: "rates", statement: "Regional tax rates are applied", solidA: "rates matched the tax table for all configured regions", solidB: "table diff green across the configured regions", narrow: "rates correct for US states; EU VAT still flat-rated" },
      { id: "breakdown", statement: "Each line item shows its tax breakdown", solidA: "line-level breakdown present on sampled invoices", solidB: "breakdown asserted for multi-rate invoices", narrow: "breakdown shown on PDFs; the web view shows totals only" },
    ],
  },
  {
    key: "audit-export",
    objective: "Export the audit log for a date range on operator request and sign the archive",
    criteria: [
      { id: "range", statement: "Exports cover the requested date range", solidA: "range export matched the live query row for row", solidB: "row-for-row match across three sampled ranges", narrow: "ranges up to a month work; year ranges truncate silently" },
      { id: "sign", statement: "The archive carries a verifiable signature", solidA: "signature verified with the published key", solidB: "key rotation drill kept verification green", narrow: "signed for full exports; filtered exports unsigned" },
    ],
  },
  {
    key: "data-erase",
    objective: "Erase a user account and all derived data within 30 days of request",
    criteria: [
      { id: "erase", statement: "Account and derived data are erased", solidA: "post-erase scan found zero rows for the test user", solidB: "scan clean across primary, warehouse, and backups", narrow: "erased from primary and warehouse; backups age out naturally" },
      { id: "deadline", statement: "Erasure completes within 30 days", solidA: "request-to-clean ticket closed on day 12", solidB: "SLA report shows every request inside 30 days", narrow: "met for standard accounts; enterprise holds await legal" },
    ],
  },
];

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

interface BuiltCase {
  id: string;
  category: string;
  rationale: string;
  evidence: MissionClosureEvidence;
  expected: FinalExpected;
  mustReady: boolean;
  mustStatus?: string;
}

const FINAL_MISSIONS = MISSIONS.slice(0, 16);
const DEV_MISSIONS = MISSIONS.slice(16, 22);
const VAL_MISSIONS = MISSIONS.slice(22, 28);

function baseEvidence(mission: MissionTemplate, tag: string, n: number, solid: "A" | "B"): MissionClosureEvidence {
  const missionRevision = `mission-${tag}`;
  const evidenceRevision = `evidence-${tag}-${n}`;
  return {
    missionId: `${tag}-${mission.key}`,
    objective: mission.objective,
    missionRevision,
    evidenceRevision,
    candidateDigest: `candidate-${tag}-${mission.key}-${n}`,
    criteria: mission.criteria.map((c) => ({
      id: c.id,
      statement: c.statement,
      verified: true,
      outcome: solid === "A" ? c.solidA : c.solidB,
      evidenceRef: `verification:${tag}run-${n}`,
      missionRevision,
      evidenceRevision,
    })),
    tests: {
      passed: true,
      independent: true,
      evidenceRef: `verifier:${tag}v:${n}`,
      revision: evidenceRevision,
    },
    operations: { pending: 0, uncertain: 0 },
    blockers: [],
  };
}

function withGraphRuns(evidence: MissionClosureEvidence, n: number): MissionClosureEvidence {
  return {
    ...evidence,
    graphRuns: [
      {
        runId: `f3graph-${n}`,
        graphHash: `graphhash-${n}`,
        policyHash: `policyhash-${n}`,
        nodes: [
          { nodeId: "plan", status: "succeeded" },
          { nodeId: "apply", status: "succeeded" },
        ],
      },
    ],
  };
}

function positive(mission: MissionTemplate, tag: string, n: number, variant: number): BuiltCase {
  let evidence = baseEvidence(mission, tag, n, variant % 2 === 0 ? "A" : "B");
  if (variant >= 2) evidence = withGraphRuns(evidence, n);
  return {
    id: `${tag}-${mission.key}-full-complete-v${variant}`,
    category: "full-complete",
    rationale: "positive control: every clause attested with solid outcomes and receipts",
    evidence,
    expected: "COMPLETE",
    mustReady: true,
  };
}

/** Mechanical defects: preflight must stop with the declared status. */
function mechanical(mission: MissionTemplate, tag: string, n: number, kind: string): BuiltCase {
  const evidence = baseEvidence(mission, tag, n, "A");
  const id = `${tag}-${mission.key}-${kind}`;
  switch (kind) {
    case "unresolved-blocker":
      return { id, category: "unresolved-blocker", rationale: "an external credential dependency is unresolved", evidence: { ...evidence, blockers: [{ id: "vendor-key", unresolved: true }] }, expected: "BLOCKED", mustReady: false, mustStatus: "BLOCKED" };
    case "pending-operations":
      return { id, category: "pending-operations", rationale: "two operations are still pending", evidence: { ...evidence, operations: { pending: 2, uncertain: 0 } }, expected: "INCOMPLETE", mustReady: false, mustStatus: "INCOMPLETE" };
    case "uncertain-operations":
      return { id, category: "uncertain-operations", rationale: "one operation outcome is unknown", evidence: { ...evidence, operations: { pending: 0, uncertain: 1 } }, expected: "INCOMPLETE", mustReady: false, mustStatus: "INCOMPLETE" };
    case "missing-evidence-ref":
      return { id, category: "missing-evidence-ref", rationale: "criterion 1 has an outcome but no evidence reference", evidence: { ...evidence, criteria: evidence.criteria.map((c, i) => i === 0 ? dropKeys({ ...c, verified: false }, "evidenceRef") : c) }, expected: "INCOMPLETE", mustReady: false, mustStatus: "INCOMPLETE" };
    case "missing-outcome":
      return { id, category: "missing-outcome", rationale: "criterion 1 has no recorded outcome", evidence: { ...evidence, criteria: evidence.criteria.map((c, i) => i === 0 ? dropKeys({ ...c, verified: false }, "outcome") : c) }, expected: "INCOMPLETE", mustReady: false, mustStatus: "INCOMPLETE" };
    case "tests-failed":
      return { id, category: "tests-failed", rationale: "the test suite did not pass", evidence: { ...evidence, tests: { ...evidence.tests, passed: false } }, expected: "INCOMPLETE", mustReady: false, mustStatus: "INCOMPLETE" };
    case "tests-not-independent":
      return { id, category: "tests-not-independent", rationale: "tests passed but were not independently verified", evidence: { ...evidence, tests: { ...evidence.tests, independent: false } }, expected: "INCOMPLETE", mustReady: false, mustStatus: "INCOMPLETE" };
    case "tests-ref-missing":
      return { id, category: "tests-ref-missing", rationale: "tests passed but carry no evidence reference", evidence: { ...evidence, tests: dropKeys({ ...evidence.tests }, "evidenceRef") }, expected: "INCOMPLETE", mustReady: false, mustStatus: "INCOMPLETE" };
    case "empty-objective":
      return { id, category: "empty-objective", rationale: "no objective is stated; nothing can be judged fulfilled", evidence: { ...evidence, objective: "" }, expected: "INSUFFICIENT_EVIDENCE", mustReady: false, mustStatus: "INSUFFICIENT_EVIDENCE" };
    case "duplicate-criterion-ids":
      return { id, category: "duplicate-criterion-ids", rationale: "two criteria share one id; coverage cannot be established", evidence: { ...evidence, criteria: evidence.criteria.map((c, i) => i === 1 ? { ...c, id: evidence.criteria[0]!.id } : c) }, expected: "INSUFFICIENT_EVIDENCE", mustReady: false, mustStatus: "INSUFFICIENT_EVIDENCE" };
    default:
      throw new Error(`unknown mechanical kind ${kind}`);
  }
}

/** Semantic traps: preflight must pass; only the judge can refuse. */
function semantic(mission: MissionTemplate, tag: string, n: number, kind: string, custom?: { outcomeA?: string; outcomeB?: string }): BuiltCase {
  const evidence = baseEvidence(mission, tag, n, "A");
  const id = `${tag}-${mission.key}-${kind}`;
  const first = (outcome: string): MissionClosureEvidence => ({
    ...evidence,
    criteria: evidence.criteria.map((c, i) => i === 0 ? { ...c, outcome } : c),
  });
  switch (kind) {
    case "narrow-outcome":
      return { id, category: "narrow-outcome", rationale: "criterion 1 outcome covers only part of its statement", evidence: first(mission.criteria[0]!.narrow), expected: "INCOMPLETE", mustReady: true };
    case "contradictory-outcome":
      return { id, category: "contradictory-outcome", rationale: "criterion 1 outcome states the work was deferred", evidence: first("not implemented; deferred to next quarter"), expected: "INCOMPLETE", mustReady: true };
    case "missing-scope":
      return { id, category: "missing-scope", rationale: "the objective's second clause has no criterion at all", evidence: { ...evidence, criteria: evidence.criteria.slice(0, 1) }, expected: "INCOMPLETE", mustReady: true };
    case "vague-outcome":
      return { id, category: "vague-outcome", rationale: "criterion 1 outcome is non-empty but unverifiable", evidence: first("mostly implemented; a few edge cases may remain open"), expected: "INSUFFICIENT_EVIDENCE", mustReady: true };
    case "ambiguous-outcome":
      return { id, category: "ambiguous-outcome", rationale: "criterion 1 outcome supports two readings; fulfillment cannot be decided", evidence: first(custom?.outcomeA ?? "partially rolled out; coverage unconfirmed"), expected: "INSUFFICIENT_EVIDENCE", mustReady: true };
    case "contradictory-pair":
      return {
        id, category: "contradictory-pair", rationale: "the two criterion outcomes contradict each other",
        evidence: {
          ...evidence,
          criteria: evidence.criteria.map((c, i) =>
            i === 0 ? { ...c, ...(custom?.outcomeA === undefined ? {} : { outcome: custom.outcomeA }) }
            : i === 1 ? { ...c, ...(custom?.outcomeB === undefined ? {} : { outcome: custom.outcomeB }) }
            : c),
        },
        expected: "INSUFFICIENT_EVIDENCE", mustReady: true,
      };
    case "stale-build":
      return { id, category: "stale-build", rationale: "the evidence cites a superseded build; current behavior unmeasured", evidence: first("load test passed on last quarter's build; this quarter's build not yet measured"), expected: "INSUFFICIENT_EVIDENCE", mustReady: true };
    case "pending-item":
      return { id, category: "pending-item", rationale: "criterion 1 outcome admits the named item is still pending", evidence: first(custom?.outcomeA ?? "work staged; final confirmation pending"), expected: "INCOMPLETE", mustReady: true };
    default:
      throw new Error(`unknown semantic kind ${kind}`);
  }
}

const S5_CUSTOM: Array<{ mission: string; criterion: number; outcome: string }> = [
  { mission: "billing-refund", criterion: 1, outcome: "owner notified through the in-app inbox; email receipt pending confirmation" },
  { mission: "search-index", criterion: 0, outcome: "index latency normal on the primary cluster; new region not yet measured" },
  { mission: "backup-restore", criterion: 1, outcome: "tabletop restore drill passed; full-account drill scheduled but not run" },
  { mission: "notify-sms", criterion: 0, outcome: "codes arrive in seconds on major carriers; regional carriers unmeasured" },
  { mission: "rate-limit", criterion: 1, outcome: "Retry-After present in staging responses; production header rollout unverified" },
  { mission: "audit-log", criterion: 1, outcome: "actor identity logged for UI actions; API key actions log the key prefix only" },
  { mission: "feature-flag", criterion: 1, outcome: "old path serving while the flag is evaluated; cutover criterion not yet defined" },
  { mission: "cert-rotate", criterion: 1, outcome: "alerts configured in the paging tool; end-to-end drill not yet performed" },
  { mission: "log-retention", criterion: 1, outcome: "card numbers redacted in sampled logs; full-corpus scan still running" },
];

const S6_CUSTOM: Array<{ mission: string; outcomeA: string; outcomeB: string }> = [
  { mission: "pagination", outcomeA: "page size fixed at fifty across the admin list", outcomeB: "archived users paginate at one hundred rows" },
  { mission: "oauth-scope", outcomeA: "consent screen shows exactly the calendar read scope", outcomeB: "explainer covers calendar and contacts scopes" },
  { mission: "cache-ttl", outcomeA: "TTL measured at 300 seconds on sampled pages", outcomeB: "sale pages cache for one hour per the promo rule" },
  { mission: "queue-dlq", outcomeA: "poison jobs arrived in the DLQ after five attempts", outcomeB: "owner alerted on the third attempt before DLQ routing" },
  { mission: "health-probe", outcomeA: "both probes answer on the ops port", outcomeB: "readiness always answers 200; database state checked separately" },
  { mission: "metrics-dash", outcomeA: "conversion panel matches warehouse within 1%", outcomeB: "panel refreshes every fifteen minutes" },
  { mission: "secret-rotate", outcomeA: "rotation completed with zero failed queries", outcomeB: "previous pair revoked immediately on rotation" },
  { mission: "billing-refund", outcomeA: "owner notified by email with the refund receipt", outcomeB: "email receipts disabled during the provider outage; owners not informed" },
  { mission: "search-index", outcomeA: "p99 index latency 41 seconds on the prod topic", outcomeB: "exact title matches rank first except when ads are present; ads always outrank" },
  { mission: "notify-sms", outcomeA: "p99 delivery latency 6.2 seconds across carriers", outcomeB: "gateway errors retry forever without a cap" },
];

const S8_CUSTOM: Array<{ mission: string; criterion: number; outcome: string }> = [
  { mission: "billing-refund", criterion: 1, outcome: "receipt link generated; email batch send pending" },
  { mission: "search-index", criterion: 1, outcome: "ranking change merged; index rebuild with new weights still running" },
  { mission: "backup-restore", criterion: 0, outcome: "backup job configured; first scheduled run tonight, none completed yet" },
  { mission: "notify-sms", criterion: 1, outcome: "cap implemented in code; carrier sandbox verification not yet run" },
  { mission: "rate-limit", criterion: 0, outcome: "limits live on the staging edge; production rollout pending the freeze lift" },
  { mission: "audit-log", criterion: 0, outcome: "route table diff done; logging patch for bulk import awaiting deploy" },
  { mission: "feature-flag", criterion: 1, outcome: "flag created; old-path soak test still collecting traffic" },
  { mission: "cert-rotate", criterion: 0, outcome: "rotation playbook written; first automatic rotation scheduled, none observed yet" },
  { mission: "log-retention", criterion: 0, outcome: "retention policy set; backfill of pre-policy logs still running" },
];

/** Omit optional keys instead of assigning explicit undefined (exactOptionalPropertyTypes). */
function dropKeys<T extends object>(obj: T, ...keys: Array<keyof T>): T {
  const out = { ...obj };
  for (const key of keys) delete (out as Record<string, unknown>)[key as string];
  return out;
}

function missionByKey(pool: MissionTemplate[], key: string): MissionTemplate {
  const found = pool.find((m) => m.key === key);
  if (found === undefined) throw new Error(`unknown mission ${key}`);
  return found;
}

function buildDev(): BuiltCase[] {
  const cases: BuiltCase[] = [];
  let n = 0;
  for (const m of DEV_MISSIONS) {
    cases.push(positive(m, "dev3", n++, 0));
    cases.push(positive(m, "dev3", n++, 1));
  }
  const mech = ["unresolved-blocker", "pending-operations", "missing-evidence-ref", "missing-outcome", "tests-failed"];
  const sem = ["narrow-outcome", "contradictory-outcome", "missing-scope", "vague-outcome", "stale-build"];
  for (const kind of mech) for (let r = 0; r < 2; r++) cases.push(mechanical(DEV_MISSIONS[n % DEV_MISSIONS.length]!, "dev3", n++, kind));
  for (const kind of sem) for (let r = 0; r < 2; r++) cases.push(semantic(DEV_MISSIONS[n % DEV_MISSIONS.length]!, "dev3", n++, kind));
  return cases;
}

function buildVal(): BuiltCase[] {
  const cases: BuiltCase[] = [];
  let n = 0;
  for (const m of VAL_MISSIONS) {
    cases.push(positive(m, "val3", n++, 0));
    cases.push(positive(m, "val3", n++, 1));
  }
  const mech = ["unresolved-blocker", "pending-operations", "missing-evidence-ref", "missing-outcome", "tests-failed"];
  const sem = ["narrow-outcome", "contradictory-outcome", "missing-scope", "vague-outcome", "stale-build"];
  for (const kind of mech) for (let r = 0; r < 2; r++) cases.push(mechanical(VAL_MISSIONS[n % VAL_MISSIONS.length]!, "val3", n++, kind));
  for (const kind of sem) for (let r = 0; r < 2; r++) cases.push(semantic(VAL_MISSIONS[n % VAL_MISSIONS.length]!, "val3", n++, kind));
  return cases;
}

function buildFinal(): BuiltCase[] {
  const cases: BuiltCase[] = [];
  let n = 0;
  for (const m of FINAL_MISSIONS) for (let v = 0; v < 4; v++) cases.push(positive(m, "f3", n++, v));
  const mechPlan: Array<[string, number]> = [
    ["unresolved-blocker", 8], ["pending-operations", 8], ["uncertain-operations", 8],
    ["missing-evidence-ref", 8], ["missing-outcome", 8], ["tests-failed", 8],
    ["tests-not-independent", 8], ["tests-ref-missing", 8], ["empty-objective", 6], ["duplicate-criterion-ids", 6],
  ];
  let mi = 0;
  for (const [kind, count] of mechPlan) {
    for (let r = 0; r < count; r++) {
      cases.push(mechanical(FINAL_MISSIONS[mi % FINAL_MISSIONS.length]!, "f3", n++, kind));
      mi++;
    }
  }
  const semPlan: Array<[string, number]> = [
    ["narrow-outcome", 10], ["contradictory-outcome", 10], ["missing-scope", 10],
    ["vague-outcome", 10], ["stale-build", 9],
  ];
  for (const [kind, count] of semPlan) {
    for (let r = 0; r < count; r++) {
      cases.push(semantic(FINAL_MISSIONS[mi % FINAL_MISSIONS.length]!, "f3", n++, kind));
      mi++;
    }
  }
  for (const c of S5_CUSTOM) {
    const m = missionByKey(FINAL_MISSIONS, c.mission);
    const evidence = baseEvidence(m, "f3", n, "A");
    evidence.criteria[c.criterion]!.outcome = c.outcome;
    cases.push({ id: `f3-${m.key}-ambiguous-outcome`, category: "ambiguous-outcome", rationale: "the outcome supports two readings; fulfillment cannot be decided", evidence, expected: "INSUFFICIENT_EVIDENCE", mustReady: true });
    n++;
  }
  for (const c of S6_CUSTOM) {
    const m = missionByKey(FINAL_MISSIONS, c.mission);
    const evidence = baseEvidence(m, "f3", n, "A");
    evidence.criteria[0]!.outcome = c.outcomeA;
    evidence.criteria[1]!.outcome = c.outcomeB;
    cases.push({ id: `f3-${m.key}-contradictory-pair`, category: "contradictory-pair", rationale: "the two criterion outcomes contradict each other", evidence, expected: "INSUFFICIENT_EVIDENCE", mustReady: true });
    n++;
  }
  for (const c of S8_CUSTOM) {
    const m = missionByKey(FINAL_MISSIONS, c.mission);
    const evidence = baseEvidence(m, "f3", n, "A");
    evidence.criteria[c.criterion]!.outcome = c.outcome;
    cases.push({ id: `f3-${m.key}-pending-item`, category: "pending-item", rationale: "the outcome admits the named item is still pending", evidence, expected: "INCOMPLETE", mustReady: true });
    n++;
  }
  return cases;
}

/** Strip run-specific ids so structural duplicates are caught, not just id collisions. */
function normalizePrompt(text: string): string {
  return text
    .replace(/evidence-[a-z0-9-]+/g, "evidence-R")
    .replace(/mission-[a-z0-9-]+/g, "mission-R")
    .replace(/srun-\d+/g, "srun-R")
    .replace(/sv:\d+/g, "sv-R")
    .replace(/candidate-\S+"/g, 'candidate-R"')
    .replace(/f3graph-\d+/g, "f3graph-R")
    .replace(/graphhash-\d+/g, "H")
    .replace(/policyhash-\d+/g, "H");
}

function toRows(cases: BuiltCase[]): string[] {
  return cases.map((c) => {
    const request = affirmativeRequest(c.evidence);
    return JSON.stringify({ id: c.id, state: request.state, questions: request.questions, expected: { closure: { choice: c.expected } } });
  });
}

function validateSplit(name: string, cases: BuiltCase[], rows: string[]): { ready: number; stopped: number } {
  const ids = new Set<string>();
  const prompts = new Set<string>();
  let ready = 0;
  let stopped = 0;
  const byCategory = new Map<string, number>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`${name}: duplicate case id ${c.id}`);
    ids.add(c.id);
    const preflight = preflightMissionClosure(c.evidence, SELFCHECK_POLICY);
    const isReady = preflightReachedReview(preflight);
    if (isReady !== c.mustReady) {
      throw new Error(`${name}: ${c.id} preflightReady=${isReady}, expected ${c.mustReady} (${preflight.reasons[0] ?? "no reason"})`);
    }
    if (c.mustStatus !== undefined && preflight.status !== c.mustStatus) {
      throw new Error(`${name}: ${c.id} preflight status ${preflight.status}, expected ${c.mustStatus}`);
    }
    if (c.expected === "COMPLETE" && !isReady) throw new Error(`${name}: ${c.id} COMPLETE label on a preflight-stopped case`);
    if (c.expected === "BLOCKED" && preflight.status !== "BLOCKED") throw new Error(`${name}: ${c.id} BLOCKED label without a blocking preflight`);
    if (isReady) ready++; else stopped++;
    byCategory.set(c.category, (byCategory.get(c.category) ?? 0) + 1);
  }
  for (const row of rows) {
    const request = JSON.parse(row) as { id: string; state: unknown; questions: unknown };
    const norm = normalizePrompt(JSON.stringify([request.state, request.questions]));
    if (prompts.has(norm)) throw new Error(`${name}: duplicate model-visible prompt at ${request.id}`);
    prompts.add(norm);
  }
  parseCalibrationDataset(`${rows.join("\n")}\n`);
  return { ready, stopped };
}

function existingIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of [
    "bench/datasets/mission-completion-lockbox-v1.jsonl",
    "bench/datasets/mission-completion-lockbox-v2.jsonl",
    "bench/datasets/development-mission-completion-v1.jsonl",
    "bench/datasets/heldout-mission-completion.jsonl",
  ]) {
    try {
      for (const c of parseCalibrationDataset(readFileSync(join(root, file), "utf8"))) ids.add(c.id);
    } catch {
      // A missing optional reference file cannot break the build.
    }
  }
  return ids;
}

function main(): void {
  const dev = buildDev();
  const val = buildVal();
  const fin = buildFinal();
  const devRows = toRows(dev);
  const valRows = toRows(val);
  const finRows = toRows(fin);
  const devStats = validateSplit("dev-v3", dev, devRows);
  const valStats = validateSplit("validation-v3", val, valRows);
  const finStats = validateSplit("lockbox-v3", fin, finRows);

  const seen = existingIds();
  for (const c of [...dev, ...val, ...fin]) {
    if (seen.has(c.id)) throw new Error(`id overlaps an existing dataset: ${c.id}`);
    seen.add(c.id);
  }
  const crossPrompts = new Set<string>();
  for (const [name, rows] of [["dev", devRows], ["val", valRows], ["final", finRows]] as const) {
    for (const row of rows) {
      const request = JSON.parse(row) as { id: string; state: unknown; questions: unknown };
      const norm = normalizePrompt(JSON.stringify([request.state, request.questions]));
      if (crossPrompts.has(norm)) throw new Error(`cross-split near-duplicate prompt at ${name}:${request.id}`);
      crossPrompts.add(norm);
    }
  }

  const positives = fin.filter((c) => c.expected === "COMPLETE").length;
  const negatives = fin.length - positives;
  if (positives < 60) throw new Error(`final lockbox has ${positives} positives, need >= 60`);
  if (negatives < 149) throw new Error(`final lockbox has ${negatives} negatives, need >= 149`);

  mkdirSync(outDir, { recursive: true });
  const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
  const writeSplit = (base: string, cases: BuiltCase[], rows: string[]): Record<string, string> => {
    const data = `${rows.join("\n")}\n`;
    const labels = Object.fromEntries(cases.map((c) => {
      const preflight = preflightMissionClosure(c.evidence, SELFCHECK_POLICY);
      return [c.id, {
        category: c.category,
        rationale: c.rationale,
        expected: c.expected,
        preflight: preflightReachedReview(preflight) ? "ready" : preflight.status,
      }];
    }));
    const labelsText = `${JSON.stringify(labels, null, 2)}\n`;
    writeDeterministicArtifact(join(outDir, `${base}.jsonl`), data);
    writeDeterministicArtifact(join(outDir, `${base}.labels.json`), labelsText);
    return { [`${base}.jsonl`]: sha256Hex(data), [`${base}.labels.json`]: sha256Hex(labelsText) };
  };
  const hashes: Record<string, string> = {
    ...writeSplit("mission-completion-dev-v3", dev, devRows),
    ...writeSplit("mission-completion-validation-v3", val, valRows),
    ...writeSplit("mission-completion-lockbox-v3", fin, finRows),
  };
  const freeze = {
    sealed: "mission-completion-lockbox-v3 is blind release evidence; tune only on dev/validation",
    files: hashes,
    counts: {
      dev: { cases: dev.length, positives: dev.filter((c) => c.expected === "COMPLETE").length },
      validation: { cases: val.length, positives: val.filter((c) => c.expected === "COMPLETE").length },
      final: { cases: fin.length, positives, negatives, preflightReady: finStats.ready, preflightStopped: finStats.stopped },
    },
    evaluationProtocol: {
      runner: "scripts/jev-lockbox.ts (two model calls per preflight-passing case: model-only + integrated)",
      verifier: "scripts/jev-verify-lockbox.ts",
      binder: "scripts/jev-qualify-lockbox.ts with --require-liveness 0.95 --min-positives 60 --min-negatives 149 --min-confidence 0.9",
      estimatedModelCalls: `final ${fin.length + finStats.ready} + dev ${dev.length + devStats.ready} + val ${val.length + valStats.ready} before transport retries`,
    },
    provenance: "scripts/build-final-lockbox-datasets.ts (hand-authored labels; preflight expectations verified at build time, not asserted)",
  };
  const freezeText = `${JSON.stringify(freeze, null, 2)}\n`;
  hashes["mission-completion-lockbox-v3.freeze.json"] = sha256Hex(freezeText);
  writeDeterministicArtifact(join(outDir, "mission-completion-lockbox-v3.freeze.json"), freezeText);

  console.error(`dev-v3: ${dev.length} cases (${devStats.ready} ready)`);
  console.error(`validation-v3: ${val.length} cases (${valStats.ready} ready)`);
  console.error(`lockbox-v3: ${fin.length} cases, ${positives} positives, ${negatives} negatives (${finStats.ready} ready)`);
  console.error("frozen files:");
  for (const [file, hash] of Object.entries(hashes)) console.error(`  ${hash}  ${file}`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
