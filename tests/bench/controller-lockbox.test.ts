/**
 * Lockbox outcome replay: 40 held-out cases driven through the
 * real host-owned control loop (`directMissionControl`, fed by the
 * production evidence source shape). No model inference is spent: this
 * measures controller dispositions — above all, zero premature COMPLETE
 * on cases constructed to violate exactly one completion requirement.
 *
 * Structural assertions prove the committed JSONL matches the production
 * request builders exactly, so future model runs measure the live shape.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import type { VerificationLedger } from "../../src/hooks/verification.js";
import type { MissionClosureEvidence } from "../../src/mission/closure.js";
import { affirmativeRequest, MISSION_CLOSURE_QUESTION } from "../../src/mission/closure.js";
import { directMissionControl } from "../../src/decision/loop.js";
import { lockboxFixtures } from "../../scripts/build-lockbox-dataset.js";
import { testLedgerForFile } from "../helpers/control-state.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const datasetPath = join(root, "bench", "datasets", "mission-completion-lockbox-v1.jsonl");

function verificationLedger(ok: boolean): VerificationLedger {
  return {
    last: { kind: "test", ok, ts: 300, command: "npm test" },
    edits_since: 0,
    byKind: { test: { kind: "test", ok, ts: 300, command: "npm test" } },
    editsSinceByKind: { test: 0 },
  };
}

function ledger(): EvidenceLedger {
  return testLedgerForFile(join(mkdtempSync(join(tmpdir(), "jev-lockbox-")), "evidence.log"));
}

describe("lockbox structural parity", () => {
  it("committed JSONL matches the production request builders exactly", () => {
    const fixtures = lockboxFixtures();
    const lines = readFileSync(datasetPath, "utf8").split("\n").filter((line) => line.trim() !== "");
    expect(lines.length).toBe(fixtures.length);
    const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
    const promptKeys = new Set<string>();
    for (const line of lines) {
      const row = JSON.parse(line) as { id: string; state: unknown; questions: unknown; expected: unknown };
      const fixture = byId.get(row.id);
      expect(fixture).toBeDefined();
      const request = affirmativeRequest(fixture!.evidence);
      expect(row.state).toEqual(request.state);
      expect(row.questions).toEqual(request.questions);
      expect(row.questions).toEqual({ closure: MISSION_CLOSURE_QUESTION });
      expect(row.expected).toEqual({ closure: { choice: fixture!.expected } });
      promptKeys.add(JSON.stringify([row.state, row.questions]));
    }
    // Repeated prompts with different IDs are not independent lockbox cases.
    expect(promptKeys.size).toBe(lines.length);
  });
});

describe("lockbox controller replay", () => {
  it("never completes a hard negative; completes the positive control", async () => {
    const fixtures = lockboxFixtures();
    let prematureComplete = 0;
    let missedComplete = 0;
    let blockedCorrect = 0;
    let blockedTotal = 0;
    for (const fixture of fixtures) {
      const led = ledger();
      const evidence: MissionClosureEvidence = fixture.evidence;
      const result = await directMissionControl({
        ledger: led,
        sessionId: `lockbox-${fixture.id}`,
        source: { load: async () => evidence, isCurrent: async () => true },
        missionId: evidence.missionId,
        verification: verificationLedger(fixture.verificationOk),
      });
      if (fixture.expected === "COMPLETE") {
        // Positive control: ready-for-closure, never terminal without the gate receipt.
        if (result.decision.action !== "READY_FOR_CLOSURE" || result.decision.complete) missedComplete += 1;
        expect(result.decision.action).toBe("READY_FOR_CLOSURE");
        expect(result.decision.complete).toBe(false);
      } else {
        if (result.decision.complete || result.decision.action === "COMPLETE") prematureComplete += 1;
        expect(result.decision.complete).toBe(false);
        expect(result.decision.action).not.toBe("READY_FOR_CLOSURE");
        expect(result.decision.action).not.toBe("COMPLETE");
      }
      if (fixture.expected === "BLOCKED") {
        blockedTotal += 1;
        if (result.decision.action === "BLOCKED" && !result.decision.complete) blockedCorrect += 1;
        expect(result.decision.action).toBe("BLOCKED");
      }
    }
    // The controller disposition replay does not spend model inference.
    expect(prematureComplete).toBe(0);
    expect(missedComplete).toBe(0);
    expect(blockedCorrect).toBe(blockedTotal);
    expect(blockedTotal).toBeGreaterThan(0);
  }, 60000);
});
