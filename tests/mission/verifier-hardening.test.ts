/**
 * Verifier filesystem + identity hardening (P1-3/P2 adversarial tests).
 *
 * Filesystem: every filesystem-touching verifier refuses symlink traversal
 * (final path and ancestor directories, even in-root targets), lexical root
 * escapes, directories, and unreadable files — returning `undefined`
 * (unresolved), never a verdict over outside bytes. Reads happen at
 * verification time through the opened file descriptor, so replacements
 * before or during verification are observed, never trusted by path name.
 * All disk tests below use real temp dirs with the default (no-seam)
 * reader; no metered inference, no network, no command execution.
 *
 * Identity: compound identifiers use canonical length-delimited tuples, so
 * distinct field tuples cannot forge the same id. Each regression pair
 * below collides under the old naive join and must differ (or stay
 * unresolved) under the hardened encoding.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveCriterionGraphBindings,
  validateCriterionVerifications,
} from "../../src/mission/graph-binding.js";
import type { MissionCriterionVerification } from "../../src/mission/closure.js";
import {
  encodeTupleFields,
  FINDING_CORRELATION_ID_VERSION,
  findingReceiptCorrelationId,
  findingReceiptCorrelationIdCandidates,
  findingReceiptCorrelationIdV1,
  findingToVerification,
  persistVerifierFinding,
  verificationReceiptIds,
  verifyBuildArtifact,
  verifyFileState,
  verifyTestExecution,
  verifyTreeBinding,
  VERIFIER_ADAPTER_VERSION,
} from "../../src/mission/verifiers.js";
import { testLedger } from "../helpers/control-state.js";
import { mkdtempSync } from "../helpers/temp-directory.js";

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const R = "9".repeat(64);
const K = "b".repeat(64);

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jeverb-hardening-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function base(criterionId = "criterion-01") {
  return { criterionId, missionRevision: R, candidateDigest: K, verifiedAt: 400 };
}

describe("symlink-safe file access", () => {
  it("refuses a symlinked final path pointing outside the root, even with a matching digest", () => {
    const scratch = tempDir();
    const root = join(scratch, "root");
    const outside = join(scratch, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const secret = Buffer.from("outside secret bytes");
    writeFileSync(join(outside, "secret.bin"), secret);
    symlinkSync(join(outside, "secret.bin"), join(root, "artifact.bin"));

    const verdict = verifyBuildArtifact({
      ...base(),
      path: "artifact.bin",
      expectedDigest: sha(secret),
      root,
    });
    expect(verdict).toBeUndefined();
  });

  it("refuses traversal through a symlinked ancestor directory", () => {
    const scratch = tempDir();
    const root = join(scratch, "root");
    const outside = join(scratch, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const secret = Buffer.from("ancestor escape bytes");
    writeFileSync(join(outside, "file.bin"), secret);
    symlinkSync(outside, join(root, "sub"));

    const verdict = verifyBuildArtifact({
      ...base(),
      path: "sub/file.bin",
      expectedDigest: sha(secret),
      root,
    });
    expect(verdict).toBeUndefined();
    expect(
      verifyFileState({ ...base(), files: [{ path: "sub/file.bin", expectedDigest: sha(secret) }], root }),
    ).toBeUndefined();
  });

  it("refuses even an in-root symlink target (no symlink traversal, period)", () => {
    const scratch = tempDir();
    const root = join(scratch, "root");
    mkdirSync(root, { recursive: true });
    const content = Buffer.from("real bytes");
    writeFileSync(join(root, "real.bin"), content);
    symlinkSync(join(root, "real.bin"), join(root, "alias.bin"));

    expect(
      verifyBuildArtifact({ ...base(), path: "alias.bin", expectedDigest: sha(content), root }),
    ).toBeUndefined();
  });

  it("still throws on lexical root escapes", () => {
    const root = join(tempDir(), "root");
    mkdirSync(root, { recursive: true });
    expect(() =>
      verifyBuildArtifact({ ...base(), path: "../escape.bin", expectedDigest: sha("x"), root }),
    ).toThrow();
    expect(() =>
      verifyBuildArtifact({ ...base(), path: "/other/app.bin", expectedDigest: sha("x"), root }),
    ).toThrow();
  });

  it("reports missing files without reading outside bytes", () => {
    const root = join(tempDir(), "root");
    mkdirSync(root, { recursive: true });
    const absent = verifyBuildArtifact({ ...base(), path: "nope.bin", expectedDigest: sha("x"), root });
    expect(absent?.result).toBe("failed");
    expect(absent?.observedResult).toContain("absent");
    expect(
      verifyFileState({ ...base(), files: [{ path: "nope.bin", expectedDigest: sha("x") }], root }),
    ).toBeUndefined();
  });

  it("abstains on non-regular and unreadable files", () => {
    const scratch = tempDir();
    const root = join(scratch, "root");
    mkdirSync(join(root, "adir"), { recursive: true });
    // A directory is not a regular file: unresolved, never satisfied.
    expect(
      verifyBuildArtifact({ ...base(), path: "adir", expectedDigest: sha("x"), root }),
    ).toBeUndefined();

    const locked = join(root, "locked.bin");
    writeFileSync(locked, Buffer.from("locked bytes"));
    chmodSync(locked, 0o000);
    try {
      // Root can read through permission bits; non-root must abstain.
      const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
      if (!isRoot) {
        expect(
          verifyBuildArtifact({ ...base(), path: "locked.bin", expectedDigest: sha("locked bytes"), root }),
        ).toBeUndefined();
      }
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  it("observes replacements made before verification (freshness at read time)", () => {
    const scratch = tempDir();
    const root = join(scratch, "root");
    mkdirSync(root, { recursive: true });
    const first = Buffer.from("first bytes");
    const second = Buffer.from("second bytes");
    writeFileSync(join(root, "artifact.bin"), first);
    const staleDigest = sha(first);
    // Swap the content before verification: the stale digest must mismatch.
    writeFileSync(join(root, "artifact.bin"), second);
    const verdict = verifyBuildArtifact({ ...base(), path: "artifact.bin", expectedDigest: staleDigest, root });
    expect(verdict?.result).toBe("failed");
    expect(verdict?.observedResult).toContain(sha(second));
  });

  it("refuses a file replaced by a symlink between verifications", () => {
    const scratch = tempDir();
    const root = join(scratch, "root");
    const outside = join(scratch, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const legit = Buffer.from("legit bytes");
    writeFileSync(join(root, "artifact.bin"), legit);
    const before = verifyBuildArtifact({ ...base(), path: "artifact.bin", expectedDigest: sha(legit), root });
    expect(before?.result).toBe("satisfied");

    // Attacker swaps the legit file for a symlink to an outside file that
    // even carries the expected digest: still unresolved, never satisfied.
    const outsideBytes = Buffer.from("outside bytes with caller digest");
    writeFileSync(join(outside, "evil.bin"), outsideBytes);
    rmSync(join(root, "artifact.bin"));
    symlinkSync(join(outside, "evil.bin"), join(root, "artifact.bin"));
    const after = verifyBuildArtifact({
      ...base(),
      path: "artifact.bin",
      expectedDigest: sha(outsideBytes),
      root,
    });
    expect(after).toBeUndefined();
  });

  it("satisfies correct in-root files through the default reader", () => {
    const scratch = tempDir();
    const root = join(scratch, "root");
    mkdirSync(join(root, "dist"), { recursive: true });
    const a = Buffer.from("aaa");
    const b = Buffer.from("bbb");
    writeFileSync(join(root, "dist", "a.txt"), a);
    writeFileSync(join(root, "dist", "b.txt"), b);

    const artifact = verifyBuildArtifact({ ...base(), path: "dist/a.txt", expectedDigest: sha(a), root });
    expect(artifact?.result).toBe("satisfied");
    const state = verifyFileState({
      ...base(),
      files: [
        { path: "dist/a.txt", expectedDigest: sha(a) },
        { path: "dist/b.txt", expectedDigest: sha(b) },
      ],
      root,
    });
    expect(state?.result).toBe("satisfied");
    expect(state?.observedResult).toContain("2 paths match");
  });
});

describe("canonical compound identities", () => {
  it("encodes distinct tuples to distinct strings (space/NUL/newline/colon pairs)", () => {
    expect(encodeTupleFields(["V X", "R"])).not.toBe(encodeTupleFields(["V", "X R"]));
    expect(encodeTupleFields(["a\x00b", "c"])).not.toBe(encodeTupleFields(["a", "b\x00c"]));
    expect(encodeTupleFields(["L2:H0\nQ", "H1"])).not.toBe(encodeTupleFields(["L2:H0", "Q:H1"]));
    // Sanity: identical tuples still encode identically.
    expect(encodeTupleFields(["a", "b"])).toBe(encodeTupleFields(["a", "b"]));
  });

  it("rejects differing tree snapshots that collide under the naive path:digest join", () => {
    const h0 = sha("file-L2");
    const h1 = sha("file-Q");
    const expectedTree: Record<string, string> = { L2: h0, Q: h1 };
    const actualTree: Record<string, string> = { [`L2:${h0}\nQ`]: h1 };
    expect(Object.keys(actualTree)).not.toEqual(Object.keys(expectedTree));
    // The old naive encoding genuinely collided on this pair (regression guard).
    const naive = (tree: Record<string, string>): string =>
      sha(Object.entries(tree).map(([p, d]) => `${p}:${d}`).sort().join("\n"));
    expect(naive(expectedTree)).toBe(naive(actualTree));
    // The hardened adapter must not bind differing snapshots.
    const finding = verifyTreeBinding({ ...base(), expectedTree, actualTree });
    expect(finding.result).toBe("failed");
    expect(finding.observedResult).toContain("differs");
  });

  it("treats space-colliding verifier/receipt pairs as ambiguous, never satisfied", () => {
    const verdict = (
      verifierId: string,
      receiptCorrelationId: string,
    ): MissionCriterionVerification => ({
      criterionId: "criterion-01",
      verifierId,
      missionRevision: R,
      candidateDigest: K,
      result: "satisfied",
      receiptCorrelationId,
      verifiedAt: 400,
      evidenceRef: "ref",
      observedResult: "obs",
      adapterVersion: VERIFIER_ADAPTER_VERSION,
    });
    const assessed = validateCriterionVerifications({
      verifications: [verdict("V X", "R"), verdict("V", "X R")],
      criteria: [{ id: "criterion-01" }],
      missionRevision: R,
      candidateDigest: K,
      verifierAllowlist: ["V X", "V"],
    });
    expect(assessed.assessments[0]?.outcome).toBe("unresolved");
  });

  it("gives distinct findings distinct correlation ids across a NUL boundary", () => {
    const f = verifyTestExecution({ ...base(), evidenceRef: "e", passed: true });
    const left = { ...f, observedResult: "o\x00x", evidenceRef: "e" };
    const right = { ...f, observedResult: "o", evidenceRef: "x\x00e" };
    expect(left).not.toEqual(right);
    expect(findingReceiptCorrelationId(left)).not.toBe(findingReceiptCorrelationId(right));
  });

  it("detects divergent bound evidence that collides under the naive NUL join", () => {
    const digest = "d".repeat(64);
    const inputHash = sha("input-hash");
    const runs = [
      {
        runId: "A\x00B",
        nodes: [{ nodeId: "n", status: "succeeded" as const, inputHash, outputDigest: digest, declaredDependencies: [], attemptIds: [] }],
      },
      {
        runId: "A",
        nodes: [{ nodeId: "B\x00n", status: "succeeded" as const, inputHash, outputDigest: digest, declaredDependencies: [], attemptIds: [] }],
      },
    ];
    const evidence = resolveCriterionGraphBindings({
      bindings: [
        { criterionId: "criterion-01", runId: "A\x00B", nodeId: "n", inputHash, outputDigest: digest },
        { criterionId: "criterion-01", runId: "A", nodeId: "B\x00n", inputHash, outputDigest: digest },
      ],
      criteria: [{ id: "criterion-01" }],
      graphRuns: runs,
      candidateDigest: K,
      missionRevision: R,
    });
    // Two divergent terminal rows for one criterion: conflict, never bound.
    expect(evidence).toHaveLength(2);
    for (const entry of evidence) expect(entry.state).toBe("conflict");
  });

  it("versions the correlation id and honors pre-change receipts through the gateway", () => {
    expect(FINDING_CORRELATION_ID_VERSION).toBe("finding-correlation/v2");
    const finding = verifyTestExecution({ ...base(), evidenceRef: "suite:unit", passed: true });
    const current = findingReceiptCorrelationId(finding);
    const legacy = findingReceiptCorrelationIdV1(finding);
    // The legacy encoding is the naive NUL join it replaces (regression guard).
    const naive = sha(
      [
        finding.verifierId,
        finding.criterionId,
        finding.missionRevision,
        finding.candidateDigest,
        finding.result,
        finding.observedResult,
        finding.evidenceRef,
      ].join("\u0000"),
    );
    expect(legacy).toBe(naive);
    expect(current).not.toBe(legacy);
    expect(/^[0-9a-f]{64}$/.test(current)).toBe(true);
    const candidates = findingReceiptCorrelationIdCandidates(finding);
    expect(candidates[0]).toBe(current);
    expect(candidates).toContain(legacy);

    // A receipt persisted under the legacy id still counts when named.
    const dir = tempDir();
    const ledger = testLedger(dir);
    const persisted = persistVerifierFinding(ledger, "session-1", finding);
    expect(persisted.status).toBe("appended");
    expect(persisted.correlationId).toBe(current);
    const present = verificationReceiptIds(ledger.read().records);
    expect(present.has(current)).toBe(true);
    // A verdict naming the canonical id counts against canonical presence.
    const canonical = validateCriterionVerifications({
      verifications: [findingToVerification(finding, current)],
      criteria: [{ id: "criterion-01" }],
      missionRevision: R,
      candidateDigest: K,
      verifierAllowlist: ["test-execution"],
      receiptsPresent: present,
    });
    expect(canonical.assessments[0]?.outcome).toBe("satisfied");
    // A verdict naming the legacy id still counts when the ledger's
    // presence set holds that legacy row: old receipts are honored
    // through the gateway, not orphaned by the encoding change.
    const legacyCounted = validateCriterionVerifications({
      verifications: [findingToVerification(finding, legacy)],
      criteria: [{ id: "criterion-01" }],
      missionRevision: R,
      candidateDigest: K,
      verifierAllowlist: ["test-execution"],
      receiptsPresent: new Set<string>([legacy]),
    });
    expect(legacyCounted.assessments[0]?.outcome).toBe("satisfied");
  });
});
