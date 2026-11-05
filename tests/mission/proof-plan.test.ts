import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildHostProofPlanPayload, hostProofPlanContentDigest } from "../../src/mission/proof-plan.js";
import { parseMissionContract } from "../../src/mission/contract.js";

describe("host proof-plan proposal", () => {
  it("binds every user-authored requirement to explicit graph producers and source paths", () => {
    const root = mkdtempSync(join(tmpdir(), "jeverb-proof-plan-"));
    try {
      const contract = parseMissionContract("session-proof-plan",
        "Implement discounts.\nObjective coverage: exhaustive\nAcceptance criteria:\n- 10 percent discount returns 90.\n- Zero percent discount preserves total.", 1);
      if (contract === undefined) throw new Error("contract fixture failed to parse");
      const plan = buildHostProofPlanPayload(contract, {
        schema: "jeverb-host-proof-plan-input/1",
        workspaceRoot: root,
        criteria: [
          { criterionId: "criterion-01", testCommand: "npm test -- discount", producers: [{ runId: "run-01", nodeId: "test-discount", attemptId: "test-discount/1" }], codeFiles: ["src/discount.ts", "tests/discount.test.ts"] },
          { criterionId: "criterion-02", testCommand: "npm test -- discount", producers: [{ runId: "run-01", nodeId: "test-zero" }], codeFiles: ["src/discount.ts", "tests/discount.test.ts"] },
        ],
      });
      expect(plan.criteria.map(({ criterionId }) => criterionId)).toEqual(contract.criteria.map(({ id }) => id));
      expect(plan.criteria[0]?.requirementSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(hostProofPlanContentDigest(plan)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing criteria, unknown criteria, producer omissions, and escaping source paths", () => {
    const root = mkdtempSync(join(tmpdir(), "jeverb-proof-plan-"));
    try {
      const contract = parseMissionContract("session-proof-plan-negative",
        "Implement discounts.\nObjective coverage: exhaustive\nAcceptance criteria:\n- 10 percent discount returns 90.", 1);
      if (contract === undefined) throw new Error("contract fixture failed to parse");
      const base = {
        schema: "jeverb-host-proof-plan-input/1" as const,
        workspaceRoot: root,
        criteria: [{ criterionId: "criterion-01", testCommand: "npm test", producers: [{ runId: "run-01", nodeId: "test" }], codeFiles: ["src/discount.ts"] }],
      };
      expect(() => buildHostProofPlanPayload(contract, { ...base, criteria: [] })).toThrow(/complete mission contract/);
      expect(() => buildHostProofPlanPayload(contract, { ...base, criteria: [{ ...base.criteria[0]!, criterionId: "criterion-99" }] })).toThrow(/exactly match/);
      expect(() => buildHostProofPlanPayload(contract, { ...base, criteria: [{ ...base.criteria[0]!, producers: [] }] })).toThrow(/assignment/);
      expect(() => buildHostProofPlanPayload(contract, { ...base, criteria: [{ ...base.criteria[0]!, codeFiles: ["../outside.ts"] }] })).toThrow(/source paths/);
      expect(() => buildHostProofPlanPayload(contract, { ...base, criteria: [{ ...base.criteria[0]!, extra: true }] })).toThrow(/unknown or missing fields/);
      expect(() => buildHostProofPlanPayload(contract, {
        ...base,
        criteria: [{ ...base.criteria[0]!, producers: [{ nodeId: "test" }] }],
      })).toThrow(/producer identity/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches the control-service v3 canonical digest fixture", () => {
    const digest = hostProofPlanContentDigest({
      schema: "jeverb-host-proof-plan/3",
      missionId: "a".repeat(32), missionRevision: "b".repeat(64), objectiveSha256: "c".repeat(64),
      workspaceRoot: "/tmp",
      criteria: [{
        criterionId: "criterion-01", requirementSha256: "d".repeat(64), testCommandSha256: "e".repeat(64),
        producers: [{ runId: "run-01", nodeId: "verify", attemptId: "verify/1" }], codeFiles: ["src/discount.ts"],
        probeActions: [{
          id: "revoked-membership", description: "Exercise revoked membership access",
          command: "node tests/access-probe.cjs", commandSha256: "8cd3398705dfbeb6c8be09238c75d8915ffe2d904d550a1fbda66ff47b0791bd",
          producers: [{ runId: "run-01", nodeId: "verify", attemptId: "verify/1" }],
          nodeId: "probe-revoked", maxExecutions: 2,
        }],
      }],
    });
    expect(digest).toBe("8aa45f51836f581957675e58559b2118d0d68f535bbf8ae4be77af5227d5bb23");
  });

  it("binds supplemental probe IDs, commands, exact graph attempts, and execution budgets into v3 digest", () => {
    const root = mkdtempSync(join(tmpdir(), "jeverb-proof-plan-v2-"));
    try {
      const contract = parseMissionContract("session-proof-plan-v2",
        "Implement workspace authorization.\nObjective coverage: exhaustive\nAcceptance criteria:\n- Revoked members are denied.", 1);
      if (contract === undefined) throw new Error("contract fixture failed to parse");
      const input = {
        schema: "jeverb-host-proof-plan-input/3" as const,
        workspaceRoot: root,
        criteria: [{
          criterionId: "criterion-01",
          testCommand: "npm test -- authorization",
          producers: [{ runId: "run-01", nodeId: "baseline-test", attemptId: "baseline-test/1" }],
          codeFiles: ["src/access.ts"],
          probeActions: [{
            id: "revoked-membership",
            description: "Exercise a revoked membership against the original access requirement",
            command: "node tests/probes/revoked-membership.cjs",
            producers: [{ runId: "run-01", nodeId: "baseline-test", attemptId: "baseline-test/1" }],
            nodeId: "probe-revoked-membership",
            maxExecutions: 2,
          }],
        }],
      };
      const plan = buildHostProofPlanPayload(contract, input);
      expect(plan.schema).toBe("jeverb-host-proof-plan/3");
      expect(plan.criteria[0]?.probeActions?.[0]).toMatchObject({
        id: "revoked-membership", command: input.criteria[0]!.probeActions[0]!.command,
        commandSha256: expect.stringMatching(/^[0-9a-f]{64}$/), nodeId: "probe-revoked-membership", maxExecutions: 2,
        producers: [{ runId: "run-01", nodeId: "baseline-test", attemptId: "baseline-test/1" }],
      });
      const initialDigest = hostProofPlanContentDigest(plan);
      expect(initialDigest).toMatch(/^[0-9a-f]{64}$/);
      const legacyV2 = {
        ...input,
        schema: "jeverb-host-proof-plan-input/2" as const,
        criteria: input.criteria.map((criterion) => ({
          ...criterion,
          probeActions: criterion.probeActions.map((action) => {
            const { producers: _producerScope, ...legacyAction } = action;
            return legacyAction;
          }),
        })),
      };
      const legacyPlan = buildHostProofPlanPayload(contract, legacyV2);
      expect(legacyPlan.schema).toBe("jeverb-host-proof-plan/2");
      expect(legacyPlan.criteria[0]?.probeActions?.[0]?.producers).toBeUndefined();
      expect(hostProofPlanContentDigest({
        ...plan,
        criteria: [{ ...plan.criteria[0]!, probeActions: [{ ...plan.criteria[0]!.probeActions![0]!, command: "node other.cjs", commandSha256: "0".repeat(64) }] }],
      })).not.toBe(initialDigest);
      expect(hostProofPlanContentDigest({
        ...plan,
        criteria: [{ ...plan.criteria[0]!, probeActions: [{ ...plan.criteria[0]!.probeActions![0]!, producers: [{
          runId: "different-run", nodeId: "baseline-test", attemptId: "baseline-test/1",
        }] }] }],
      })).not.toBe(initialDigest);
      for (const mutate of [
        (row: typeof input.criteria[number]) => { row.probeActions[0]!.maxExecutions = 4; },
        (row: typeof input.criteria[number]) => { row.probeActions[0]!.command = "node probe.cjs\nsudo rm -rf /"; },
        (row: typeof input.criteria[number]) => { row.probeActions[0]!.nodeId = row.producers[0]!.nodeId; },
        (row: typeof input.criteria[number]) => { row.probeActions[0]!.producers[0]!.runId = "other-run"; },
      ]) {
        const invalid = structuredClone(input);
        mutate(invalid.criteria[0]!);
        expect(() => buildHostProofPlanPayload(contract, invalid)).toThrow(/probe/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds one bounded repair command and the full post-repair test command into v4", () => {
    const root = mkdtempSync(join(tmpdir(), "jeverb-proof-plan-v4-"));
    try {
      const contract = parseMissionContract("session-proof-plan-v4",
        "Implement workspace authorization.\nObjective coverage: exhaustive\nAcceptance criteria:\n- Revoked members are denied.", 1);
      if (contract === undefined) throw new Error("contract fixture failed to parse");
      const input = {
        schema: "jeverb-host-proof-plan-input/4" as const,
        workspaceRoot: root,
        criteria: [{
          criterionId: "criterion-01", testCommand: "npm test -- access.test.ts",
          producers: [{ runId: "run-01", nodeId: "access-test", attemptId: "access-test/1" }],
          codeFiles: ["src/access.ts"], probeActions: [{ id: "revoked-membership", description: "Probe a revoked member",
            command: "npm test -- access.test.ts -t revoked", producers: [{ runId: "run-01", nodeId: "access-test", attemptId: "access-test/1" }],
            nodeId: "probe-revoked", maxExecutions: 1 }],
          repairActions: [{ id: "repair-revoked", description: "Apply one authorized repair",
            command: "node repair.mjs", producers: [{ runId: "run-01", nodeId: "access-test", attemptId: "access-test/1" }],
            nodeId: "repair-revoked", maxExecutions: 1 as const }],
        }],
      };
      const plan = buildHostProofPlanPayload(contract, input);
      expect(plan.schema).toBe("jeverb-host-proof-plan/4");
      expect(plan.criteria[0]?.testCommand).toBe(input.criteria[0]!.testCommand);
      expect(plan.criteria[0]?.repairActions?.[0]).toMatchObject({
        id: "repair-revoked", command: "node repair.mjs", commandSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        nodeId: "repair-revoked", maxExecutions: 1,
      });
      const digest = hostProofPlanContentDigest(plan);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(hostProofPlanContentDigest({ ...plan, criteria: [{ ...plan.criteria[0]!, repairActions: [{
        ...plan.criteria[0]!.repairActions![0]!, command: "node other.mjs",
      }] }] })).not.toBe(digest);
      expect(() => buildHostProofPlanPayload(contract, { ...input, criteria: input.criteria.map((criterion) => ({
        ...criterion, repairActions: [...criterion.repairActions, ...criterion.repairActions],
      })) })).toThrow(/repair actions/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
