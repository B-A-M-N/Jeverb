/**
 * Host producer tree-scan hardening (runtime.ts via the shared verifier seam).
 *
 * The tree observation scan in `produceHostVerificationInputs`
 * (`src/mission/runtime.ts`) reads through `readVerifierFileBytes`
 * (`src/mission/verifiers.ts`) — the same hardened reader the
 * file-touching adapters use — so symlink/ancestor escapes, TOCTOU swaps,
 * and non-regular files refuse exactly as they do for `build-artifact`
 * and `file-state`, and any refusal abstains (`unobserved`), never a
 * verdict over outside bytes. Legitimate in-root trees behave exactly as
 * before (`satisfied` + persisted receipt, read back).
 *
 * All disk tests use real temp dirs with the default (no-seam) reader;
 * one test pins the injected memory seam for virtual paths. No metered
 * inference, no network, no command execution.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashQuestions } from "../../src/decision/provenance.js";
import type { DecisionModel } from "../../src/decision/types.js";
import { FileJournal } from "../../src/graph/journal.js";
import {
  addMissionAttestations,
  parseMissionAttestation,
  parseMissionContract,
} from "../../src/mission/contract.js";
import {
  MISSION_CLOSURE_QUESTION_V2,
  type MissionClosurePolicy,
} from "../../src/mission/closure.js";
import { createSessionMissionClosureSource } from "../../src/mission/session-source.js";
import {
  createSessionMissionClosureRunner,
  produceHostVerificationInputs,
} from "../../src/mission/runtime.js";
import { verificationReceiptIds } from "../../src/mission/verifiers.js";
import { testLedger, testStore } from "../helpers/control-state.js";
import { mkdtempSync } from "../helpers/temp-directory.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const C = "c".repeat(64);
const D = "d".repeat(64);
const V2_HASH = hashQuestions({ closure: MISSION_CLOSURE_QUESTION_V2 });
const POLICY_V2: MissionClosurePolicy = {
  policyVersion: "mission-closure/1",
  minConfidence: 0.8,
  calibrated: true,
  backend: "typesafe",
  model: "jev-1.14.0",
  modelVersion: "jev-1.14.0",
  questionHash: V2_HASH,
  calibrationVersion: "runtime-tree-scan-fixture-1",
};

function stubComplete(): DecisionModel {
  return {
    evaluate: async (input: Parameters<DecisionModel["evaluate"]>[0]) => ({
      provider: "typesafe",
      model: "jev-1.14.0",
      questionHash: hashQuestions(input.questions),
      answers: {
        closure: {
          type: "choice",
          choice: "COMPLETE",
          confidence: 1,
          probabilities: { COMPLETE: 1, INCOMPLETE: 0, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 },
        },
      },
    }),
  } as unknown as DecisionModel;
}

interface ScanFixture {
  dataDir: string;
  evidenceRoot: string;
  store: ReturnType<typeof testStore>;
  contract: NonNullable<ReturnType<typeof parseMissionContract>>;
  candidateDigest: string;
}

async function setupScan(sessionId: string): Promise<ScanFixture> {
  const dataDir = tempDir("jeverb-tree-scan-");
  const evidenceRoot = tempDir("jeverb-tree-scan-evidence-");
  const store = testStore(dataDir);
  const contract = parseMissionContract(sessionId, "Ship the parser change.\n\nObjective coverage: exhaustive\n\nAcceptance criteria:\n- Parser handles the new syntax.", 100);
  if (contract === undefined) throw new Error("contract fixture failed to parse");
  store.updateSession(sessionId, (state) => ({ ...state, mission_contract: contract }));
  mkdirSync(join(dataDir, "graph-journals"), { recursive: true, mode: 0o700 });
  const journal = new FileJournal("run-1", join(dataDir, "graph-journals"), sessionId);
  journal.record({ type: "run-started", runId: "run-1", ts: "2026-01-01T00:00:00.000Z", graphHash: "a".repeat(64), policyHash: "b".repeat(64) });
  journal.record({ type: "node-authorized", runId: "run-1", ts: "2026-01-01T00:00:01.000Z", nodeId: "build", attemptId: "build/1", allowed: true, inputHash: C });
  journal.record({ type: "node-running", runId: "run-1", ts: "2026-01-01T00:00:02.000Z", nodeId: "build", attemptId: "build/1", inputHash: C });
  journal.record({ type: "node-terminal", runId: "run-1", ts: "2026-01-01T00:00:03.000Z", nodeId: "build", attemptId: "build/1", declaredDependencies: [], status: "succeeded", inputHash: C, outputDigest: D });
  store.updateSession(sessionId, (state) => ({
    ...state,
    verification: { last: { kind: "test" as const, ok: true, ts: 300, command: "npm test" }, edits_since: 0 },
  }));
  const probe = await createSessionMissionClosureSource({ store, dataDir, now: () => 400 }).load(sessionId, contract.missionId);
  if (probe.candidateDigest === undefined) throw new Error("probe lacks candidate identity");
  const userPrompt =
    `Acceptance verification:\nmission_id: ${contract.missionId}\nmission_revision: ${contract.missionRevision}\nverified:\n` +
    `- criterion-01: parser handles the new syntax`;
  const attestations = parseMissionAttestation(sessionId, userPrompt, contract, 200);
  if (attestations === undefined) throw new Error("attestation fixture failed to parse");
  store.updateSession(sessionId, (state) => ({
    ...state,
    mission_contract: addMissionAttestations(state.mission_contract as typeof contract, attestations),
    independentVerifications: undefined,
  }));
  store.updateSession(sessionId, (state) => ({
    ...state,
    mission_contract: {
      ...(state.mission_contract as typeof contract),
      independentVerifications: [{
        verifierId: "mission-verifier-1",
        missionRevision: contract.missionRevision,
        evidenceRevision: probe.candidateRevision as string,
        candidate: probe.candidateDigest as string,
        verificationResult: "pass" as const,
        receiptCorrelationId: "mission-receipt-1",
        verifiedAt: 350,
      }],
    },
  }));
  return { dataDir, evidenceRoot, store, contract, candidateDigest: probe.candidateDigest };
}

async function scanTree(
  fixture: ScanFixture,
  sessionId: string,
  expected: Record<string, string>,
  evidenceRoot?: string,
  fs?: { readFile: (path: string) => Buffer },
) {
  return produceHostVerificationInputs({
    store: fixture.store,
    dataDir: fixture.dataDir,
    sessionId,
    missionId: fixture.contract.missionId,
    ledger: testLedger(fixture.dataDir),
    evidenceRoot: evidenceRoot ?? fixture.evidenceRoot,
    specs: [{
      criterionId: "criterion-01",
      producers: [{ runId: "run-1", nodeId: "build" }],
      tree: { expected },
    }],
    ...(fs === undefined ? {} : { fs }),
    now: () => 400,
  });
}

describe("host producer tree-scan filesystem hardening", () => {
  it("observes legitimate in-root trees exactly as before (satisfied + durable receipt)", async () => {
    const sessionId = "session-tree-scan-legit";
    const fixture = await setupScan(sessionId);
    writeFileSync(join(fixture.evidenceRoot, "tree-a.txt"), "tree content a");
    writeFileSync(join(fixture.evidenceRoot, "tree-b.txt"), "tree content b");
    const expected = { "tree-a.txt": sha("tree content a"), "tree-b.txt": sha("tree content b") };

    const produced = await scanTree(fixture, sessionId, expected);
    expect(produced.reports).toHaveLength(1);
    expect(produced.reports[0]?.status).toBe("satisfied");
    expect(produced.reports[0]?.verifierId).toBe("tree-binding");
    expect(produced.verifications).toHaveLength(1);
    expect(produced.verifications[0]?.candidateDigest).toBe(fixture.candidateDigest);
    const rows = testLedger(fixture.dataDir).read().records;
    expect(verificationReceiptIds(rows).has(produced.verifications[0]?.receiptCorrelationId as string)).toBe(true);

    const runner = createSessionMissionClosureRunner({
      model: stubComplete(),
      config: { dataDir: fixture.dataDir, missionClosurePolicy: POLICY_V2, timeoutMs: 1500 },
      store: fixture.store,
      ledger: testLedger(fixture.dataDir),
      now: () => 400,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: produced.associations,
      criterionVerifications: produced.verifications,
      trustedVerifierIds: ["tree-binding"],
    });
    const result = await runner(sessionId);
    if ("outcome" in result) throw new Error(`runner not applicable: ${result.reason}`);
    expect(result.decision.complete).toBe(true);
    expect(result.terminalComplete).toBe(true);
  });

  it("refuses a symlinked tree file pointing outside the root (unobserved, no verdict)", async () => {
    const sessionId = "session-tree-scan-symlink";
    const fixture = await setupScan(sessionId);
    const outside = tempDir("jeverb-tree-scan-outside-");
    const secret = Buffer.from("outside secret bytes");
    writeFileSync(join(outside, "secret.bin"), secret);
    symlinkSync(join(outside, "secret.bin"), join(fixture.evidenceRoot, "artifact.bin"));

    const produced = await scanTree(fixture, sessionId, { "artifact.bin": sha(secret) });
    expect(produced.verifications).toHaveLength(0);
    expect(produced.reports[0]?.status).toBe("unobserved");
  });

  it("refuses traversal through a symlinked ancestor directory", async () => {
    const sessionId = "session-tree-scan-ancestor";
    const fixture = await setupScan(sessionId);
    const outside = tempDir("jeverb-tree-scan-outside-");
    const secret = Buffer.from("ancestor escape bytes");
    writeFileSync(join(outside, "file.bin"), secret);
    symlinkSync(outside, join(fixture.evidenceRoot, "sub"));

    const produced = await scanTree(fixture, sessionId, { "sub/file.bin": sha(secret) });
    expect(produced.verifications).toHaveLength(0);
    expect(produced.reports[0]?.status).toBe("unobserved");
  });

  it("refuses even an in-root symlink target (no symlink traversal, period)", async () => {
    const sessionId = "session-tree-scan-inroot";
    const fixture = await setupScan(sessionId);
    const content = Buffer.from("real bytes");
    writeFileSync(join(fixture.evidenceRoot, "real.bin"), content);
    symlinkSync(join(fixture.evidenceRoot, "real.bin"), join(fixture.evidenceRoot, "alias.bin"));

    const produced = await scanTree(fixture, sessionId, { "alias.bin": sha(content) });
    expect(produced.verifications).toHaveLength(0);
    expect(produced.reports[0]?.status).toBe("unobserved");
  });

  it("maps a lexical root escape to unobserved instead of reading outside bytes", async () => {
    const sessionId = "session-tree-scan-escape";
    const fixture = await setupScan(sessionId);
    const outside = tempDir("jeverb-tree-scan-outside-");
    const secret = Buffer.from("lexical escape bytes");
    writeFileSync(join(outside, "secret.bin"), secret);

    const produced = await scanTree(fixture, sessionId, { "../outside-secret.bin": sha(secret) });
    expect(produced.verifications).toHaveLength(0);
    expect(produced.reports[0]?.status).toBe("unobserved");
  });

  it("maps a non-regular tree file (directory) to unobserved", async () => {
    const sessionId = "session-tree-scan-dir";
    const fixture = await setupScan(sessionId);
    mkdirSync(join(fixture.evidenceRoot, "subdir"));

    const produced = await scanTree(fixture, sessionId, { subdir: sha("whatever") });
    expect(produced.verifications).toHaveLength(0);
    expect(produced.reports[0]?.status).toBe("unobserved");
  });

  it("still reports missing tree files as unobserved (no verdict, no receipt)", async () => {
    const sessionId = "session-tree-scan-missing";
    const fixture = await setupScan(sessionId);

    const produced = await scanTree(fixture, sessionId, { "never-observed.txt": D });
    expect(produced.verifications).toHaveLength(0);
    expect(produced.reports[0]?.status).toBe("unobserved");
  });

  it("still yields an observed failed verdict when content drifts (never closure)", async () => {
    const sessionId = "session-tree-scan-tamper";
    const fixture = await setupScan(sessionId);
    writeFileSync(join(fixture.evidenceRoot, "tree-a.txt"), "tree content a");
    writeFileSync(join(fixture.evidenceRoot, "tree-b.txt"), "tree content TAMPERED");

    const produced = await scanTree(fixture, sessionId, {
      "tree-a.txt": sha("tree content a"),
      "tree-b.txt": sha("tree content b"),
    });
    expect(produced.reports[0]?.status).toBe("failed");
    expect(produced.verifications).toHaveLength(1);
    expect(produced.verifications[0]?.result).toBe("failed");
  });

  it("keeps the injected memory seam working for virtual paths", async () => {
    const sessionId = "session-tree-scan-memory";
    const fixture = await setupScan(sessionId);
    const content = Buffer.from("memory bytes");
    const memory = new Map([[join(fixture.evidenceRoot, "virtual.bin"), content]]);

    const produced = await scanTree(
      fixture,
      sessionId,
      { "virtual.bin": sha(content) },
      fixture.evidenceRoot,
      { readFile: (path: string) => {
        const bytes = memory.get(path);
        if (bytes === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return bytes;
      } },
    );
    expect(produced.reports[0]?.status).toBe("satisfied");
    expect(produced.verifications).toHaveLength(1);
  });
});
