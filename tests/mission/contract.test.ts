import { describe, expect, it } from "vitest";
import { addMissionAttestations, parseMissionAttestation, parseMissionContract, readMissionContract } from "../../src/mission/contract.js";

const PROMPT = `Implement parser recovery without changing command authorization.

Objective coverage: exhaustive

Acceptance criteria:
- Interrupted retries remain blocked until reconciled.
- Add regression tests for stale terminal records.`;

describe("user-authored mission contracts", () => {
  it("captures only the explicit objective and acceptance list with stable revisions", () => {
    const first = parseMissionContract("session-1", PROMPT, 1234);
    const retry = parseMissionContract("session-1", PROMPT, 9876);
    expect(first).toBeDefined();
    expect(first).toMatchObject({
      objective: "Implement parser recovery without changing command authorization.",
      objectiveCoverage: { source: "user-prompt-objective-coverage" },
      criteria: [
        { id: "criterion-01", statement: "Interrupted retries remain blocked until reconciled." },
        { id: "criterion-02", statement: "Add regression tests for stale terminal records." },
      ],
      source: "user-prompt-acceptance-section",
      createdAt: 1234,
    });
    expect(retry?.missionId).toBe(first?.missionId);
    expect(retry?.missionRevision).toBe(first?.missionRevision);
  });

  it("does not infer a contract from ordinary prose or malformed criteria", () => {
    expect(parseMissionContract("session-1", "Implement parser recovery and tests.", 1)).toBeUndefined();
    expect(parseMissionContract("session-1", "An objective.\n\nAcceptance criteria:\nDo the right thing.", 1)).toBeUndefined();
    expect(parseMissionContract("session-1", `${PROMPT}\n\nAcceptance criteria:\n- Another list`, 1)).toBeUndefined();
  });

  it("loads legacy criteria without claiming objective coverage", () => {
    const legacy = PROMPT.replace("Objective coverage: exhaustive\n\n", "");
    const contract = parseMissionContract("session-legacy", legacy, 1234);
    expect(contract?.objectiveCoverage).toBeUndefined();
    expect(readMissionContract(contract, "session-legacy")?.objectiveCoverage).toBeUndefined();
  });

  it("rejects a coverage declaration rebound to another prompt", () => {
    const contract = parseMissionContract("session-coverage-binding", PROMPT, 1)!;
    expect(readMissionContract({
      ...contract,
      objectiveCoverage: { ...contract.objectiveCoverage!, promptHash: "0".repeat(64) },
    }, "session-coverage-binding")).toBeUndefined();
  });

  it("rejects duplicate criteria, anonymous sessions, and oversized prompts", () => {
    const duplicate = "Fix parser behavior.\n\nAcceptance criteria:\n- Tests pass.\n- Tests   pass.";
    expect(parseMissionContract("session-1", duplicate, 1)).toBeUndefined();
    expect(parseMissionContract("unknown", PROMPT, 1)).toBeUndefined();
    expect(parseMissionContract("session-1", "x".repeat(8001), 1)).toBeUndefined();
  });

  it("redacts secrets and rejects tampered or cross-session persisted contracts", () => {
    const contract = parseMissionContract(
      "session-1",
      `Use token sk-abcdefghijklmnopqrstuvwxyz123456 for setup.\n\nAcceptance criteria:\n- Add tests and verify the implementation.`,
      1,
    );
    expect(contract?.objective).toContain("[REDACTED]");
    expect(JSON.stringify(contract)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(readMissionContract(contract, "session-1")).toEqual(contract);
    expect(readMissionContract(contract, "session-2")).toBeUndefined();
    expect(readMissionContract({ ...contract, objective: "tampered" }, "session-1")).toBeUndefined();
  });

  it("binds direct user verification to the exact mission revision and prompt hash", () => {
    const contract = parseMissionContract("session-1", PROMPT, 1234);
    expect(contract).toBeDefined();
    const verification = `I checked the requested results.\n\nAcceptance verification:\nmission_id: ${contract!.missionId}\nmission_revision: ${contract!.missionRevision}\nverified:\n- criterion-01: interrupted retries remain blocked until reconciliation`;
    const attestation = parseMissionAttestation("session-1", verification, contract, 4567);
    expect(attestation).toHaveLength(1);
    expect(attestation?.[0]).toMatchObject({
      criterionId: "criterion-01",
      missionRevision: contract?.missionRevision,
      outcome: "interrupted retries remain blocked until reconciliation",
      attestedAt: 4567,
      source: "user-prompt-verification",
    });
    expect(attestation?.[0]?.promptHash).toMatch(/^[0-9a-f]{64}$/);
    const updated = addMissionAttestations(contract!, attestation!);
    expect(readMissionContract(updated, "session-1")).toEqual(updated);
  });

  it("rejects stale missions, unknown criteria, duplicate criteria, and forged persisted attestations", () => {
    const contract = parseMissionContract("session-1", PROMPT, 1234);
    expect(contract).toBeDefined();
    const block = (ids: string[], missionId = contract!.missionId, revision = contract!.missionRevision): string =>
      `Acceptance verification:\nmission_id: ${missionId}\nmission_revision: ${revision}\nverified:\n${ids.map((id) => `- ${id}`).join("\n")}`;
    expect(parseMissionAttestation("session-1", block(["criterion-01"], "0".repeat(32)), contract, 1)).toBeUndefined();
    expect(parseMissionAttestation("session-1", block(["criterion-99"]), contract, 1)).toBeUndefined();
    expect(parseMissionAttestation("session-1", block(["criterion-01", "criterion-01"]), contract, 1)).toBeUndefined();
    const attestation = parseMissionAttestation("session-1", block(["criterion-01"]), contract, 1)!;
    const updated = addMissionAttestations(contract!, attestation);
    const forged = { ...updated, attestations: updated.attestations?.map((item) => ({ ...item, missionRevision: "0".repeat(64) })) };
    expect(readMissionContract(forged, "session-1")).toBeUndefined();
  });

  it("redacts and bounds outcome summaries while allowing legacy bare attestations to fail closed", () => {
    const contract = parseMissionContract("session-1", PROMPT, 1234)!;
    const summary = `Acceptance verification:\nmission_id: ${contract.missionId}\nmission_revision: ${contract.missionRevision}\nverified:\n- criterion-01: output token sk-abcdefghijklmnopqrstuvwxyz123456 is still blocked`;
    const attestation = parseMissionAttestation("session-1", summary, contract, 4567);
    expect(attestation?.[0]?.outcome).toContain("[REDACTED]");
    expect(attestation?.[0]?.outcome).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    const bare = summary.replace(/: output token .* is still blocked/, "");
    expect(parseMissionAttestation("session-1", bare, contract, 4567)?.[0]?.outcome).toBeUndefined();
  });
});
