import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileJournal } from "../../src/graph/journal.js";
import { enforceEvidenceRetention } from "../../src/hooks/maintenance.js";
import { testLedgerForFile } from "../helpers/control-state.js";

function settledJournal(runId: string, directory: string, hostSessionId?: string): FileJournal {
  const journal = new FileJournal(runId, directory, hostSessionId);
  const inputHash = "a".repeat(64);
  journal.record({ type: "run-started", runId, ts: "" });
  journal.record({ type: "node-running", runId, ts: "", nodeId: "step", attemptId: "step/1", inputHash });
  journal.record({
    type: "node-terminal",
    runId,
    ts: "",
    nodeId: "step",
    attemptId: "step/1",
    status: "failed",
    inputHash,
    outputDigest: "b".repeat(64),
  });
  return journal;
}

function evidenceRecord(id: string, ts: string) {
  return {
    schema: 1 as const,
    id,
    ts,
    sessionId: "s1",
    turnId: "run-1",
    event: "noteEmitted",
    eventHost: "mcp" as const,
    outcome: "execution-observed" as const,
    subjectHash: "a".repeat(32),
    policyVersion: "graph-execution/" + "b".repeat(64),
    deterministicFindings: [] as string[],
    enforcement: "none",
    reasons: [] as string[],
    latencyMs: 0,
  };
}

describe("enforceEvidenceRetention", () => {
  it("reaps provider-health crash-orphan temps after the writer process exits", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-maintenance-provider-health-"));
    const now = Date.now();
    const deadPid = 2_000_000_000;
    const staleTimestamp = now - 2 * 60 * 60 * 1000;
    const orphan = join(dir, `provider-health.json.${deadPid}.${staleTimestamp}.orphan.tmp`);
    const liveOwnerTemp = join(dir, `provider-health.json.${process.pid}.${staleTimestamp}.live.tmp`);
    const old = new Date(now - 2 * 60 * 60 * 1000);
    writeFileSync(orphan, "partial state\n", { mode: 0o600 });
    writeFileSync(liveOwnerTemp, "still-owned\n", { mode: 0o600 });
    utimesSync(orphan, old, old);
    utimesSync(liveOwnerTemp, old, old);

    const outcome = enforceEvidenceRetention({
      dataDir: dir,
      retentionDays: 365,
      maxRecords: 100,
      now,
    });

    expect(outcome.tempFilesRemoved).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(liveOwnerTemp)).toBe(true);
  });

  it("prunes aged-out records and enforces the cap, keeping the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-maintenance-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const now = Date.now();
    const old = new Date(now - 400 * 24 * 60 * 60 * 1000).toISOString();
    expect(ledger.appendDetailed(evidenceRecord("old", old), { durable: true }).ok).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(ledger.appendDetailed(evidenceRecord(`new-${i}`, new Date(now).toISOString()), { durable: true }).ok).toBe(true);
    }
    const outcome = enforceEvidenceRetention({
      ledger,
      dataDir: dir,
      retentionDays: 365,
      maxRecords: 3,
      isMissionSessionActive: () => false,
      now,
    });
    expect(outcome.ran).toBe(true);
    // 400-day record aged out; cap of 3 keeps the newest three.
    expect(ledger.read().records).toHaveLength(3);
    expect(outcome.ledgerKept).toBe(3);
    // Daily gate: a second run in the same window does no work.
    expect(enforceEvidenceRetention({ ledger, dataDir: dir, retentionDays: 365, maxRecords: 3, isMissionSessionActive: () => false, now }).ran).toBe(false);
  });

  it("reaps stale graph journals but keeps recent ones and foreign files", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-maintenance-"));
    const journalDir = join(dir, "graph-journals");
    mkdirSync(journalDir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const ancient = new Date(now - 400 * 24 * 60 * 60 * 1000);
    const staleJournal = settledJournal("oldrun", journalDir);
    const freshJournal = settledJournal("newrun", journalDir);
    const stale = staleJournal.path;
    const fresh = freshJournal.path;
    const foreign = join(journalDir, "operator-notes.txt");
    writeFileSync(foreign, "do not touch\n");
    utimesSync(stale, ancient, ancient);
    utimesSync(foreign, ancient, ancient);
    const outcome = enforceEvidenceRetention({ dataDir: dir, retentionDays: 365, maxRecords: 100_000, isMissionSessionActive: () => false, now });
    expect(outcome.ran).toBe(true);
    expect(outcome.journalsRemoved).toBe(1);
    expect(statSync(fresh).isFile()).toBe(true);
    expect(statSync(foreign).isFile()).toBe(true);
  });

  it("retains old settled journals for active mission sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-maintenance-active-mission-"));
    const journalDir = join(dir, "graph-journals");
    mkdirSync(journalDir, { recursive: true, mode: 0o700 });
    const journal = settledJournal("mission-run", journalDir, "active-session");
    const secondJournal = settledJournal("mission-run-2", journalDir, "active-session");
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    utimesSync(journal.path, old, old);
    utimesSync(secondJournal.path, old, old);

    let ownerChecks = 0;
    const outcome = enforceEvidenceRetention({
      dataDir: dir,
      retentionDays: 365,
      maxRecords: 100_000,
      removeGraphJournalIfMissionInactive: (sessionId) => {
        ownerChecks += 1;
        return sessionId !== "active-session";
      },
    });

    expect(outcome.journalsRemoved).toBe(0);
    expect(ownerChecks).toBe(1);
    expect(statSync(journal.path).isFile()).toBe(true);
    expect(statSync(secondJournal.path).isFile()).toBe(true);
  });

  it("retains old unresolved effects even when their mission is not active", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-maintenance-uncertain-"));
    const journalDir = join(dir, "graph-journals");
    mkdirSync(journalDir, { recursive: true, mode: 0o700 });
    const journal = new FileJournal("uncertain-run", journalDir, "inactive-session");
    journal.record({ type: "run-started", runId: "uncertain-run", ts: "" });
    journal.record({ type: "node-running", runId: "uncertain-run", ts: "", nodeId: "effect", attemptId: "effect/1" });
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    utimesSync(journal.path, old, old);

    const outcome = enforceEvidenceRetention({
      dataDir: dir,
      retentionDays: 365,
      maxRecords: 100_000,
      isMissionSessionActive: () => false,
    });

    expect(outcome.journalsRemoved).toBe(0);
    expect(statSync(journal.path).isFile()).toBe(true);
  });

  it("ignores invalid retention inputs and a missing data dir without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-maintenance-"));
    expect(enforceEvidenceRetention({ dataDir: dir, retentionDays: 0, maxRecords: 100, isMissionSessionActive: () => false }).ran).toBe(false);
    expect(enforceEvidenceRetention({ dataDir: dir, retentionDays: NaN, maxRecords: 100, isMissionSessionActive: () => false }).ran).toBe(false);
    expect(
      enforceEvidenceRetention({ dataDir: join(dir, "does-not-exist"), retentionDays: 365, maxRecords: 100, isMissionSessionActive: () => false }).ran,
    ).toBe(true);
  });

  it("reaps an orphaned ledger rewrite from the data directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-maintenance-tmp-"));
    const now = Date.now();
    const staleStamp = now - 3 * 60 * 60 * 1000;
    const stale = join(dir, `evidence.log.4194304.${staleStamp}.deadbeef.tmp`);
    const live = join(dir, `evidence.log.${process.pid}.${now}.cafe01.tmp`);
    const foreign = join(dir, "operator-export.tmp");
    writeFileSync(stale, "partial ledger replacement\n");
    const oldMtime = (now - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, oldMtime, oldMtime);
    writeFileSync(live, "live writer\n");
    writeFileSync(foreign, "keep\n");

    const outcome = enforceEvidenceRetention({ dataDir: dir, retentionDays: 365, maxRecords: 100_000, isMissionSessionActive: () => false, now });

    expect(outcome.tempFilesRemoved).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });
});
