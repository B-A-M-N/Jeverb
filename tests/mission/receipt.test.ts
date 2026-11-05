import { appendFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceLedger, isValidReceipt } from "../../src/evidence/ledger.js";
import type { MissionClosureDecision } from "../../src/mission/closure.js";
import { persistMissionClosureReceipt } from "../../src/mission/receipt.js";
import * as publicLibrary from "../../src/lib.js";
import { testLedgerForFile } from "../helpers/control-state.js";

const decision: MissionClosureDecision = {
  status: "COMPLETE",
  complete: true,
  missionId: "m-1",
  missionRevision: "m-r1",
  evidenceRevision: "e-r2",
  policyVersion: "mission-closure/1",
  checks: {
    objectivePresent: true,
    objectiveCoverageEstablished: true,
    revisionsMatch: true,
    criteriaPresent: true,
    allCriteriaVerified: true,
    testsPassed: true,
    independentVerificationPassed: true,
    noPendingOperations: true,
    noUncertainOperations: true,
    noUnresolvedBlockers: true,
    calibrationBound: true,
  },
  reasons: ["verified"],
  model: "jev-1.14.0",
  modelVersion: "jev-1.14.0",
  provider: "typesafe",
  questionHash: "a".repeat(64),
  calibrationVersion: "fixture-calibration-1",
  confidence: 1,
  probabilities: { COMPLETE: 1, INCOMPLETE: 0, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 },
  confidenceIsProof: false,
};

describe("durable mission closure receipts", () => {
  it("does not expose the low-level receipt minting function through the public library", () => {
    expect("persistMissionClosureReceipt" in publicLibrary).toBe(false);
  });

  it("appends once and treats an identical retry as an idempotent duplicate", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-receipt-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    expect(persistMissionClosureReceipt(ledger, "session-1", decision).status).toBe("appended");
    expect(persistMissionClosureReceipt(ledger, "session-1", decision).status).toBe("duplicate");
    const read = ledger.read();
    expect(read.corrupt).toBeUndefined();
    expect(read.records).toHaveLength(1);
    expect(read.records[0]?.missionClosure?.confidenceIsProof).toBe(false);
    expect(read.records[0]?.missionClosure).toMatchObject({
      modelVersion: "jev-1.14.0",
      calibrationVersion: "fixture-calibration-1",
    });
  });

  it("retains the gateway request id alongside the stable mission correlation", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-receipt-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const gatewayDecision: MissionClosureDecision = {
      ...decision,
      model: "typesafe/jev-1.14-20261014",
      modelVersion: "typesafe/jev-1.14-20261014",
      provider: "jev-gateway",
      providerRequestId: "gateway-request-123",
    };
    expect(persistMissionClosureReceipt(ledger, "session-1", gatewayDecision).status).toBe("appended");
    expect(persistMissionClosureReceipt(ledger, "session-1", {
      ...gatewayDecision,
      providerRequestId: "gateway-request-retry-456",
    }).status).toBe("duplicate");
    const receipt = ledger.read().records[0]!;
    expect(receipt.correlationId).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.missionClosure?.providerRequestId).toBe("gateway-request-123");
  });

  it("persists a qualified OpenRouter completion with its serving id and request id", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-receipt-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const openRouterDecision: MissionClosureDecision = {
      ...decision,
      model: "typesafe/jev-latest-20261103",
      modelVersion: "typesafe/jev-latest-20261103",
      provider: "openrouter",
      providerRequestId: "gen-openrouter-123",
    };
    expect(persistMissionClosureReceipt(ledger, "session-1", openRouterDecision).status).toBe("appended");
    expect(ledger.read().records[0]?.missionClosure).toMatchObject({
      provider: "openrouter",
      modelVersion: "typesafe/jev-latest-20261103",
      providerRequestId: "gen-openrouter-123",
    });
  });

  it("rejects a forged COMPLETE ledger record claiming certainty on a non-degenerate distribution", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-receipt-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    persistMissionClosureReceipt(ledger, "session-1", decision);
    const forged = structuredClone(ledger.read().records[0]!);
    forged.missionClosure!.confidence = 1;
    forged.missionClosure!.probabilities = { COMPLETE: 0.8, INCOMPLETE: 0.2, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 };
    expect(isValidReceipt(forged)).toBe(false);
  });

  it("rejects legacy terminal receipts that lack the objective coverage gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-receipt-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    persistMissionClosureReceipt(ledger, "session-1", decision);
    const legacy = structuredClone(ledger.read().records[0]!);
    delete legacy.missionClosure!.checks.objectiveCoverageEstablished;
    expect(isValidReceipt(legacy)).toBe(false);
  });

  it("refuses a different verdict for the same mission and evidence revision", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-receipt-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    persistMissionClosureReceipt(ledger, "session-1", decision);
    const conflict: MissionClosureDecision = {
      ...decision,
      status: "INCOMPLETE",
      complete: false,
      reasons: ["semantic challenge disagreed"],
    };
    expect(persistMissionClosureReceipt(ledger, "session-1", conflict).status).toBe("conflict");
    expect(ledger.read().records).toHaveLength(1);
  });

  it("refuses to append when the existing ledger is corrupt", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-receipt-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    ledger.append({
      schema: 1,
      id: "bad",
      ts: new Date().toISOString(),
      sessionId: "session-1",
      event: "broken",
      subjectHash: "x",
      policyVersion: "1",
      deterministicFindings: [],
      enforcement: "allow",
      reasons: [],
      latencyMs: 0,
    });
    // Simulate a torn tail so the evidence source fails closed.
    appendFileSync(ledger.path, "{broken", "utf8");
    const outcome = persistMissionClosureReceipt(ledger, "session-1", decision);
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.reason).toMatch(/corrupt-truncated at byte \d+/);
    } else {
      throw new Error("expected unavailable");
    }
  });

  it("refuses a COMPLETE receipt unless every mechanical check and semantic pin is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-receipt-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const unchecked: MissionClosureDecision = {
      ...decision,
      checks: { ...decision.checks, independentVerificationPassed: false },
    };
    expect(persistMissionClosureReceipt(ledger, "session-1", unchecked).status).toBe("unavailable");
    expect(ledger.read().records).toHaveLength(0);
  });

  it("refuses receipts with omitted checks or malformed probability distributions", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-receipt-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const omittedCheck: MissionClosureDecision = { ...decision, checks: { calibrationBound: true } as MissionClosureDecision["checks"] };
    const malformedProbabilities: MissionClosureDecision = {
      ...decision,
      probabilities: { COMPLETE: 0.9, INCOMPLETE: 0, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 },
    };
    const invalidConfidence: MissionClosureDecision = { ...decision, confidence: 1.1 };
    const overstatedConfidence: MissionClosureDecision = {
      ...decision,
      probabilities: { COMPLETE: 0.8, INCOMPLETE: 0.2, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 },
    };
    expect(persistMissionClosureReceipt(ledger, "session-1", omittedCheck).status).toBe("unavailable");
    expect(persistMissionClosureReceipt(ledger, "session-1", malformedProbabilities).status).toBe("unavailable");
    expect(persistMissionClosureReceipt(ledger, "session-1", invalidConfidence).status).toBe("unavailable");
    expect(persistMissionClosureReceipt(ledger, "session-1", overstatedConfidence).status).toBe("unavailable");
    expect(ledger.read().records).toHaveLength(0);
  });
});
