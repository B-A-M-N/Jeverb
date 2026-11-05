/**
 * Real verifier producers + adapters (Phase 4 verification).
 *
 * Each adapter states precisely what its evidence proves (see the
 * capability registry) and is exercised here with fake inputs and real
 * local persistence only — stub data, memory filesystems, and a real
 * evidence ledger on a temp dir. No metered inference, no network, no
 * command execution anywhere in this file.
 */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isValidReceipt } from "../../src/evidence/receipt-validation.js";
import { validateCriterionVerifications } from "../../src/mission/graph-binding.js";
import {
  findingReceiptCorrelationId,
  findingToVerification,
  persistVerifierFinding,
  VERIFIER_ADAPTER_VERSION,
  VERIFIER_CAPABILITIES,
  verificationReceiptIds,
  verifyBuildArtifact,
  verifyFileState,
  verifyServiceReadback,
  verifyTestExecution,
  verifyTreeBinding,
} from "../../src/mission/verifiers.js";
import { testLedger } from "../helpers/control-state.js";
import { mkdtempSync } from "../helpers/temp-directory.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jeverb-verifiers-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const R = "9".repeat(64);
const K = "b".repeat(64);
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function base(criterionId = "criterion-01"): {
  criterionId: string;
  missionRevision: string;
  candidateDigest: string;
  graphNodes: [{ runId: string; nodeId: string; attemptId: string }];
  verifiedAt: number;
} {
  return {
    criterionId,
    missionRevision: R,
    candidateDigest: K,
    graphNodes: [{ runId: "run-1", nodeId: "build", attemptId: "build/2" }],
    verifiedAt: 400,
  };
}

describe("capability registry", () => {
  it("declares exactly the supported adapters, each stating what it proves", () => {
    expect(VERIFIER_CAPABILITIES.map((entry) => entry.verifierId).sort()).toEqual(
      ["build-artifact", "file-state", "service-readback", "test-execution", "tree-binding"],
    );
    for (const entry of VERIFIER_CAPABILITIES) {
      expect(entry.adapterVersion).toBe(VERIFIER_ADAPTER_VERSION);
      expect(entry.proves.trim().length).toBeGreaterThan(0);
      expect(entry.trustBoundary.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("test execution/result validation", () => {
  it("records a passing report as satisfied and a failing report as failed", () => {
    const satisfied = verifyTestExecution({ ...base(), evidenceRef: "suite:unit", passed: true });
    expect(satisfied.result).toBe("satisfied");
    expect(satisfied.observedResult).toContain("passed");
    expect(satisfied.evidenceRef).toBe("suite:unit");
    expect(satisfied.graphNodes).toEqual([{ runId: "run-1", nodeId: "build", attemptId: "build/2" }]);
    const failed = verifyTestExecution({ ...base(), evidenceRef: "suite:unit", passed: false });
    expect(failed.result).toBe("failed");
  });

  it("throws on malformed identity instead of silently satisfying", () => {
    expect(() => verifyTestExecution({ ...base(), missionRevision: "nope", evidenceRef: "x", passed: true })).toThrow();
    expect(() => verifyTestExecution({ ...base(), criterionId: "", evidenceRef: "x", passed: true })).toThrow();
  });
});

describe("build-artifact existence+digest", () => {
  const content = Buffer.from("artifact bytes");
  const digest = sha(content);
  const fs = new Map([["/root/dist/app.bin", content]]);

  it("satisfies only on an exact digest match", () => {
    const memory = { readFile: (path: string): Buffer => {
      const hit = fs.get(path);
      if (hit === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return hit;
    } };
    const satisfied = verifyBuildArtifact({ ...base(), path: "dist/app.bin", expectedDigest: digest, root: "/root", fs: memory });
    expect(satisfied?.result).toBe("satisfied");
    expect(satisfied?.observedResult).toContain(digest);
    const mismatch = verifyBuildArtifact({ ...base(), path: "dist/app.bin", expectedDigest: "0".repeat(64), root: "/root", fs: memory });
    expect(mismatch?.result).toBe("failed");
    expect(mismatch?.observedResult).toContain(digest);
  });

  it("fails an absent artifact and abstains on unreadable input", () => {
    const missing = { readFile: (): Buffer => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } };
    const absent = verifyBuildArtifact({ ...base(), path: "dist/app.bin", expectedDigest: digest, root: "/root", fs: missing });
    expect(absent?.result).toBe("failed");
    expect(absent?.observedResult).toContain("absent");
    const broken = { readFile: (): Buffer => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
    expect(verifyBuildArtifact({ ...base(), path: "dist/app.bin", expectedDigest: digest, root: "/root", fs: broken })).toBeUndefined();
  });

  it("rejects paths escaping the declared root", () => {
    const memory = { readFile: (): Buffer => content };
    expect(() => verifyBuildArtifact({ ...base(), path: "../escape.bin", expectedDigest: digest, root: "/root", fs: memory })).toThrow();
    expect(() => verifyBuildArtifact({ ...base(), path: "/other/app.bin", expectedDigest: digest, root: "/root", fs: memory })).toThrow();
  });
});

describe("file-state assertions", () => {
  it("satisfies when every path matches and fails on the first mismatch", () => {
    const files = { "/root/a.txt": Buffer.from("aaa"), "/root/b.txt": Buffer.from("bbb") };
    const memory = { readFile: (path: string): Buffer => {
      const hit = (files as Record<string, Buffer>)[path];
      if (hit === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return hit;
    } };
    const good = verifyFileState({
      ...base(),
      files: [
        { path: "a.txt", expectedDigest: sha(files["/root/a.txt"]!) },
        { path: "b.txt", expectedDigest: sha(files["/root/b.txt"]!) },
      ],
      root: "/root",
      fs: memory,
    });
    expect(good?.result).toBe("satisfied");
    expect(good?.observedResult).toContain("2 paths match");
    const bad = verifyFileState({
      ...base(),
      files: [
        { path: "a.txt", expectedDigest: sha(files["/root/a.txt"]!) },
        { path: "b.txt", expectedDigest: "0".repeat(64) },
      ],
      root: "/root",
      fs: memory,
    });
    expect(bad?.result).toBe("failed");
    expect(bad?.observedResult).toContain("b.txt");
  });

  it("abstains when a listed file cannot be read", () => {
    const broken = { readFile: (): Buffer => { throw new Error("io"); } };
    expect(verifyFileState({ ...base(), files: [{ path: "a.txt", expectedDigest: sha("x") }], root: "/root", fs: broken })).toBeUndefined();
  });
});

describe("tree binding and service readback", () => {
  it("binds a candidate to the observed tree snapshot", () => {
    const tree = { "a.txt": sha("aaa"), "b.txt": sha("bbb") };
    const satisfied = verifyTreeBinding({ ...base(), expectedTree: tree, actualTree: { ...tree } });
    expect(satisfied.result).toBe("satisfied");
    expect(satisfied.observedResult).toContain(K.slice(0, 16));
    const changed = verifyTreeBinding({ ...base(), expectedTree: tree, actualTree: { "a.txt": sha("changed"), "b.txt": tree["b.txt"]! } });
    expect(changed.result).toBe("failed");
    expect(changed.observedResult).toContain("differs");
  });

  it("abstains without an authorized reader and records readback otherwise", () => {
    expect(verifyServiceReadback({ ...base(), evidenceRef: "svc:status" })).toBeUndefined();
    expect(verifyServiceReadback({ ...base(), evidenceRef: "svc:status", read: () => undefined })).toBeUndefined();
    const satisfied = verifyServiceReadback({ ...base(), evidenceRef: "svc:status", read: () => ({ ok: true, observation: "deployed at 12:00" }) });
    expect(satisfied?.result).toBe("satisfied");
    expect(satisfied?.observedResult).toContain("deployed at 12:00");
    const failed = verifyServiceReadback({ ...base(), evidenceRef: "svc:status", read: () => ({ ok: false, observation: "500 fringe" }) });
    expect(failed?.result).toBe("failed");
  });
});

describe("finding identity, mapping, and durable receipts", () => {
  it("derives a stable correlation id; a changed verdict is a different receipt", () => {
    const finding = verifyTestExecution({ ...base(), evidenceRef: "suite:unit", passed: true });
    expect(findingReceiptCorrelationId(finding)).toBe(findingReceiptCorrelationId({ ...finding }));
    expect(findingReceiptCorrelationId({ ...finding, result: "failed" })).not.toBe(findingReceiptCorrelationId(finding));
    expect(/^[0-9a-f]{64}$/.test(findingReceiptCorrelationId(finding))).toBe(true);
  });

  it("maps a finding to the counted verdict shape with full lineage", () => {
    const finding = verifyTestExecution({ ...base(), evidenceRef: "suite:unit", passed: true });
    const verification = findingToVerification(finding, "c".repeat(64));
    expect(verification).toMatchObject({
      criterionId: "criterion-01",
      verifierId: "test-execution",
      missionRevision: R,
      candidateDigest: K,
      result: "satisfied",
      receiptCorrelationId: "c".repeat(64),
      verifiedAt: 400,
      evidenceRef: "suite:unit",
      adapterVersion: VERIFIER_ADAPTER_VERSION,
    });
    expect(verification.observedResult).toContain("passed");
    expect(verification.graphNodes).toEqual([{ runId: "run-1", nodeId: "build", attemptId: "build/2" }]);
    expect(() => findingToVerification(finding, "not-a-digest")).toThrow();
  });

  it("persists an idempotent durable receipt that never claims execution-observed", () => {
    const dir = tempDir();
    const ledger = testLedger(dir);
    const finding = verifyTestExecution({ ...base(), evidenceRef: "suite:unit", passed: true });
    const first = persistVerifierFinding(ledger, "session-1", finding);
    expect(first.status).toBe("appended");
    const second = persistVerifierFinding(ledger, "session-1", finding);
    expect(second).toEqual({ status: "duplicate", correlationId: first.correlationId });
    const records = ledger.read().records.filter((record) => record.event === "CriterionVerification");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "CriterionVerification",
      sessionId: "session-1",
      correlationId: first.correlationId,
      policyVersion: `verifier/test-execution/${VERIFIER_ADAPTER_VERSION}`,
      enforcement: "criterion_satisfied",
    });
    expect("outcome" in records[0]! && records[0]!.outcome !== undefined).toBe(false);
    expect(isValidReceipt(records[0])).toBe(true);
    expect(records[0]?.deterministicFindings.join(" ")).toContain("result=satisfied");
  });

  it("scopes receipts by session and counts only persisted verdicts", () => {
    const dir = tempDir();
    const ledger = testLedger(dir);
    const finding = verifyTestExecution({ ...base(), evidenceRef: "suite:unit", passed: true });
    const own = persistVerifierFinding(ledger, "session-1", finding);
    const other = persistVerifierFinding(ledger, "session-2", finding);
    expect(own.status).toBe("appended");
    expect(other.status).toBe("appended");
    expect(own.correlationId).toBe(other.correlationId);
    expect(ledger.read().records.filter((record) => record.event === "CriterionVerification")).toHaveLength(2);

    const present = verificationReceiptIds(ledger.read().records);
    expect(present.has(own.correlationId)).toBe(true);
    const counted = validateCriterionVerifications({
      verifications: [
        findingToVerification(finding, own.correlationId),
        { ...findingToVerification(finding, own.correlationId), criterionId: "criterion-02" },
        { ...findingToVerification(finding, "d".repeat(64)), criterionId: "criterion-03" },
      ],
      criteria: [{ id: "criterion-01" }, { id: "criterion-02" }, { id: "criterion-03" }],
      missionRevision: R,
      candidateDigest: K,
      verifierAllowlist: ["test-execution"],
      receiptsPresent: present,
    });
    const byId = new Map(counted.assessments.map((assessment) => [assessment.criterionId, assessment.outcome]));
    expect(byId.get("criterion-01")).toBe("satisfied");
    expect(byId.get("criterion-02")).toBe("satisfied");
    // criterion-03 names a phantom receipt: fail closed to unresolved.
    expect(byId.get("criterion-03")).toBe("unresolved");
    // An unreadable ledger (empty presence set) fails every verdict closed.
    const down = validateCriterionVerifications({
      verifications: [findingToVerification(finding, own.correlationId)],
      criteria: [{ id: "criterion-01" }],
      missionRevision: R,
      candidateDigest: K,
      verifierAllowlist: ["test-execution"],
      receiptsPresent: new Set(),
    });
    expect(down.assessments[0]?.outcome).toBe("unresolved");
  });
});
