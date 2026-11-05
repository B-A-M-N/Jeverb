import { describe, expect, it } from "vitest";
import {
  mergeServiceAttestations,
  readServiceAttestations,
} from "../../src/control/attestations.js";
import type { ServiceAttestation } from "../../src/control/client.js";
import {
  parseMissionContract,
  readMissionContract,
  type MissionContract,
} from "../../src/mission/contract.js";

function contract(): MissionContract {
  const parsed = parseMissionContract(
    "s1",
    "Objective: ship the parser change\nAcceptance criteria:\n- Parser handles the new syntax\n- Tests pass",
    1,
  );
  if (parsed === undefined) throw new Error("mission contract fixture failed to parse");
  return parsed;
}

function entry(overrides: Partial<ServiceAttestation> = {}): ServiceAttestation {
  const base = contract();
  return {
    missionId: base.missionId,
    missionRevision: base.missionRevision,
    evidenceRevision: "e".repeat(64),
    candidate: "c".repeat(64),
    result: "pass",
    receiptCorrelationId: "1".repeat(32),
    verifiedAt: 1700000000,
    verifierUid: 0,
    ...overrides,
  };
}

describe("mergeServiceAttestations", () => {
  it("adds operator entries for the contract's own mission revision", () => {
    const merged = mergeServiceAttestations(contract(), [entry()]);
    expect(merged?.independentVerifications).toHaveLength(1);
    expect(merged?.independentVerifications?.[0]).toMatchObject({
      verifierId: "operator-control-service",
      verificationResult: "pass",
      receiptCorrelationId: "1".repeat(32),
    });
  });

  it("ignores entries for other missions or revisions", () => {
    const base = contract();
    expect(mergeServiceAttestations(base, [entry({ missionId: "0".repeat(32) })])).toBeUndefined();
    expect(mergeServiceAttestations(base, [entry({ missionRevision: "f".repeat(64) })])).toBeUndefined();
    expect(base.independentVerifications).toBeUndefined();
  });

  it("a later verdict for the same candidate supersedes", () => {
    const base = contract();
    const first = mergeServiceAttestations(base, [entry({ result: "fail", receiptCorrelationId: "2".repeat(32) })]);
    if (first === undefined) throw new Error("expected a merge");
    const second = mergeServiceAttestations(first, [entry({ result: "pass", receiptCorrelationId: "3".repeat(32) })]);
    expect(second?.independentVerifications).toHaveLength(1);
    expect(second?.independentVerifications?.[0]?.verificationResult).toBe("pass");
  });

  it("returns undefined when nothing new would be recorded", () => {
    const base = contract();
    const merged = mergeServiceAttestations(base, [entry()]);
    if (merged === undefined) throw new Error("expected a merge");
    expect(mergeServiceAttestations(merged, [entry()])).toBeUndefined();
    expect(mergeServiceAttestations(base, [])).toBeUndefined();
  });

  it("caps merged attestations at the contract maximum", () => {
    const base = contract();
    const many = Array.from({ length: 40 }, (_, index) =>
      entry({ evidenceRevision: `e${index}`.padEnd(64, "0"), receiptCorrelationId: index.toString(16).padStart(32, "0") }),
    );
    const merged = mergeServiceAttestations(base, many);
    expect(merged?.independentVerifications).toHaveLength(32);
  });

  it("merged output round-trips through contract validation", () => {
    const merged = mergeServiceAttestations(contract(), [entry()]);
    if (merged === undefined) throw new Error("expected a merge");
    const revived = readMissionContract(JSON.parse(JSON.stringify(merged)), "s1");
    expect(revived?.independentVerifications).toHaveLength(1);
    expect(revived?.independentVerifications?.[0]?.verificationResult).toBe("pass");
  });
});

describe("readServiceAttestations", () => {
  it("fails open to no attestations when no service answers", async () => {
    // No control socket in a temp data dir: the merge path must be a no-op.
    await expect(readServiceAttestations("0".repeat(32), 50)).resolves.toEqual([]);
  });
});
