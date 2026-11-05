import { writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import { isJeverbObservation } from "../../src/integrations/veyrict/observation.js";
import { run } from "../../src/tools/observations.js";
import { testLedgerForFile } from "../helpers/control-state.js";

function seed(dir: string): void {
  const ledger = testLedgerForFile(join(dir, "evidence.log"));
  const base = {
    schema: 1 as const,
    sessionId: "s1",
    event: "PreToolUse",
    subjectHash: "h",
    policyVersion: "1",
    deterministicFindings: [] as string[],
    latencyMs: 1,
  };
  ledger.append({
    ...base,
    id: "a",
    ts: new Date(1000).toISOString(),
    enforcement: "deny",
    reasons: ["r-a"],
    eventHost: "muse",
  });
  ledger.append({
    ...base,
    id: "b",
    ts: new Date(2000).toISOString(),
    enforcement: "deny",
    reasons: ["r-b"],
    candidate: "sha-1",
  });
  ledger.append({
    ...base,
    id: "c",
    ts: new Date(3000).toISOString(),
    event: "PostToolUse",
    enforcement: "observed",
    reasons: ["r-c"],
    candidate: "sha-1",
  });
}

function seedGraphReceipt(dir: string): void {
  const ledger = testLedgerForFile(join(dir, "evidence.log"));
  ledger.append({
    schema: 1,
    id: "graph-receipt",
    ts: new Date(4000).toISOString(),
    sessionId: "s1",
    turnId: "run-graph-123",
    correlationId: "a".repeat(64),
    outputDigest: "c".repeat(64),
    executionStatus: "succeeded",
    eventHost: "muse",
    outcome: "execution-observed",
    event: "GraphNodeTerminal",
    subjectHash: "b".repeat(32),
    policyVersion: "graph-execution/c",
    deterministicFindings: ["node_status=succeeded", `output_digest=${"c".repeat(64)}`],
    enforcement: "execution_succeeded",
    reasons: ["terminal graph status recorded; output text excluded"],
    latencyMs: 0,
  });
}

describe("jev_observations tool", () => {
  it("returns newest-first observations with digests, read-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-obs-"));
    seed(dir);
    const out = await run(null, { limit: 50, sessionId: "s1" }, { dataDir: dir } as never);
    expect(out.observations).toHaveLength(3);
    expect(out.truncated).toBe(false);
    expect(out.status).toBe("ok");
    // Newest first: the PostToolUse receipt was appended last.
    expect(out.observations[0]?.event).toBe("PostToolUse");
    for (const obs of out.observations) expect(isJeverbObservation(obs)).toBe(true);
  });

  it("preserves the recorded event host and never reports the transport", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-obs-"));
    seed(dir);
    const out = await run(null, { limit: 50, sessionId: "s1" }, { dataDir: dir } as never);
    // Receipt "a" (reasons ["r-a"]) recorded eventHost "muse"; "b" and
    // "c" predate host recording, so they project as unknown — never
    // the "mcp" retrieval transport.
    expect(out.observations.find((o) => o.advice.includes("r-a"))?.host).toBe("muse");
    expect(out.observations.filter((o) => o.host === "mcp")).toHaveLength(0);
    expect(out.observations.filter((o) => o.host === "unknown")).toHaveLength(2);
  });

  it("requires a session or candidate scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-obs-"));
    seed(dir);
    const config = { dataDir: dir } as never;
    const unscoped = await run(null, { limit: 50 }, config);
    expect(unscoped.observations).toHaveLength(0);
    expect(unscoped.status).toBe("unavailable");
    expect(unscoped.detail).toMatch(/scope-required/);
    // An event filter alone is not a scope either.
    const eventOnly = await run(null, { limit: 50, event: "PreToolUse" }, config);
    expect(eventOnly.status).toBe("unavailable");
  });

  it("filters by session, candidate, and event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-obs-"));
    seed(dir);
    const config = { dataDir: dir } as never;
    expect((await run(null, { sessionId: "nope", limit: 50 }, config)).observations).toHaveLength(0);
    expect((await run(null, { sessionId: "nope", limit: 50 }, config)).status).toBe("ok");
    expect((await run(null, { candidate: "sha-1", limit: 50 }, config)).observations).toHaveLength(2);
    const events = await run(null, { event: "PreToolUse", limit: 50, sessionId: "s1" }, config);
    expect(events.observations).toHaveLength(2);
    expect(events.observations.every((o) => o.event === "PreToolUse")).toBe(true);
  });

  it("filters graph observations by run id and preserves the full correlation id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-obs-"));
    seed(dir);
    seedGraphReceipt(dir);
    const config = { dataDir: dir } as never;
    const out = await run(null, { operationId: "run-graph-123", limit: 50 }, config);
    expect(out.observations).toHaveLength(1);
    expect(out.observations[0]).toMatchObject({
      operationId: "run-graph-123",
      correlationId: "a".repeat(64),
      outputDigest: "c".repeat(64),
      executionStatus: "succeeded",
      event: "GraphNodeTerminal",
      deterministicFindings: ["node_status=succeeded", "output_digest=[REDACTED HEX]"],
    });
    expect((await run(null, { operationId: "other-run", limit: 50 }, config)).observations).toHaveLength(0);
  });

  it("paginates newest-first with stable cursors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-obs-"));
    seed(dir);
    const config = { dataDir: dir } as never;
    const first = await run(null, { limit: 2, sessionId: "s1" }, config);
    expect(first.observations).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(first.status).toBe("truncated");
    expect(typeof first.nextCursor).toBe("string");
    // Newest first: PostToolUse, then the sha-1 deny.
    expect(first.observations[0]?.event).toBe("PostToolUse");
    const second = await run(null, { limit: 2, sessionId: "s1", cursor: first.nextCursor }, config);
    expect(second.observations).toHaveLength(1);
    expect(second.truncated).toBe(false);
    expect(second.status).toBe("ok");
    expect(second.observations[0]?.event).toBe("PreToolUse");
    // Pages do not overlap or skip.
    const ids = (obs: { evidence: { receiptDigest: string } }[]) => obs.map((o) => o.evidence.receiptDigest);
    expect(new Set([...ids(first.observations), ...ids(second.observations)]).size).toBe(3);
  });

  it("distinguishes absent, empty, and corrupt ledgers", async () => {
    const missing = await run(null, { limit: 50, sessionId: "s1" }, {
      dataDir: join(tmpdir(), "jev-obs-missing"),
    } as never);
    expect(missing.status).toBe("unavailable");
    expect(missing.detail).toMatch(/ledger-not-found/);
    const emptyDir = mkdtempSync(join(tmpdir(), "jev-obs-"));
    writeFileSync(join(emptyDir, "evidence.log"), "\n");
    const empty = await run(null, { limit: 50, sessionId: "s1" }, { dataDir: emptyDir } as never);
    expect(empty.status).toBe("empty");
    const dir = mkdtempSync(join(tmpdir(), "jev-obs-"));
    writeFileSync(join(dir, "evidence.log"), "not json\n{bad\n");
    const corrupt = await run(null, { limit: 50, sessionId: "s1" }, { dataDir: dir } as never);
    expect(corrupt.status).toBe("corrupt");
    expect(corrupt.detail).toMatch(/corrupt-lines:2:first-line:1/);
    expect(corrupt.observations).toHaveLength(0);
  });

  it("returns valid observations alongside corruption with its location", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-obs-"));
    seed(dir);
    writeFileSync(join(dir, "evidence.log"), "STILL NOT JSON\n", { flag: "a" });
    const out = await run(null, { limit: 50, sessionId: "s1" }, { dataDir: dir } as never);
    expect(out.status).toBe("corrupt");
    expect(out.observations).toHaveLength(3);
    expect(out.detail).toMatch(/first-line:4/);
  });
});
