import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config.js";
import type { DecisionModel, EvaluateRequest, EvaluateResult, Question } from "../../src/decision/types.js";
import { hashQuestions } from "../../src/decision/provenance.js";
import { JEV_DEMO_CASES, questionForDemoCase } from "../../scripts/jev-demo-fixtures.js";
import { FixtureDecisionModel, liveDemoPreflight, loadDemoConfig, modelVisibleState, replayHistoricalLiveRun, runJevDemo, SerialDecisionModel } from "../../scripts/jev-demo.js";

describe("dual-mode Jev demo", () => {
  it("keeps live mode at eight cases and zero requests until explicit authorization", () => {
    const config = loadConfig({ JEV_BACKEND: "typesafe", JEV_MODEL: "jev-1.14.0" });
    const preflight = liveDemoPreflight(config);
    expect(JEV_DEMO_CASES).toHaveLength(8);
    expect(preflight).toMatchObject({
      configuredProvider: "typesafe",
      configuredModel: "jev-1.14.0",
      status: "blocked-provider-unavailable",
      providerConfigured: false,
      providerAvailability: "not-probed",
      credentialStatus: "missing",
      requestCeiling: 8,
      maximumConcurrency: 1,
      perRequestTimeoutMs: 8_000,
      maximumWallTimeMs: 100_000,
      retries: 0,
      fallback: "none",
      inferenceRequests: 0,
    });
    expect(preflight.providerBudget).toMatch(/operator must attest/);
  });

  it("loads installed Muse provider config from a source checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-demo-config-test-"));
    try {
      const dataDir = join(root, "muse", "plugins", "data", "jeverb");
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ backend: "jev-gateway", base_url: "http://127.0.0.1:18769/jev", model: "typesafe/jev-1.14" }), { mode: 0o600 });
      const config = loadDemoConfig({ HOME: root, XDG_DATA_HOME: root });
      expect(config).toMatchObject({ backend: "jev-gateway", baseUrl: "http://127.0.0.1:18769/jev", model: "typesafe/jev-1.14" });
      expect(liveDemoPreflight(config)).toMatchObject({ status: "awaiting-operator-authorization", providerConfigured: true, inferenceRequests: 0 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps IDs, reference labels, and host transitions out of model-visible questions and state", () => {
    for (const demoCase of JEV_DEMO_CASES) {
      const prompt = JSON.stringify(questionForDemoCase(demoCase));
      expect(prompt).not.toContain(demoCase.id);
      expect(prompt).not.toContain(demoCase.hostTransition);
      expect(prompt).not.toMatch(/expected\s*(?:answer|decision|label)\s*:/i);
    }
    const state = modelVisibleState({ node: "advice-01", depOutputs: { "prepare-source": { output: "ready" } }, objective: "local task" });
    expect(state).not.toHaveProperty("node");
    expect(JSON.stringify(state)).not.toContain("advice-01");
    expect(JSON.stringify(state)).not.toContain("prepare-source");
    expect((state as Record<string, unknown>).depOutputs).toHaveProperty("dependency-1");
  });

  it("replays the original historical raw artifact offline and retains provenance distinctions", () => {
    const path = "/tmp/jev-demo-live-advisory-2026-11-03.json";
    const raw = readFileSync(path);
    const result = replayHistoricalLiveRun(path) as Record<string, any>;
    expect(result).toMatchObject({
      mode: "historical-live-run-replay",
      sourceSha256: createHash("sha256").update(raw).digest("hex"),
      sourceArtifactPreserved: true,
      inferenceRequestsDuringReplay: 0,
      replayInferenceUsage: "none",
      actualUpstreamModel: null,
      deployedVersion: null,
      qualification: "replay of a historical live result; not current-provider qualification",
    });
    expect(result.recordedInferenceUsage).toMatchObject({ requests: 8, inputTokens: 4427, outputTokens: 444 });
    expect(result.returnedModelIds).toContain("typesafe/jev-1.14-20261014");
    expect(JSON.stringify(result)).toContain("requestedModel");
  });

  it("runs the real deterministic task, verifier, closure, false-claim, and uncertain-resume paths", async () => {
    const result = await runJevDemo("deterministic", new FixtureDecisionModel(), "jev-demo-fixture-v1", "deterministic-fixture");
    expect(result.status).toBe("passed");
    expect(result.summary).toMatchObject({
      casesEvaluated: 8,
      correctDecisions: 8,
      incorrectDecisions: 0,
      inconclusiveDecisions: 0,
      unauthorizedExecutions: 0,
      objectiveAcceptance: "accepted-by-independent-checks",
      missionCompletion: "rejected",
      inferenceUsage: "none",
    });
    expect(Object.values(result.workflow.taskGraphNodeStatuses).every((status) => status === "succeeded")).toBe(true);
    expect(result.workflow.verification.status).toBe("satisfied");
    expect(result.workflow.verification.observedDigest).toBe(result.workflow.verification.expectedDigest);
    expect(result.workflow.verification.receiptCorrelationId).toBeTruthy();
    expect(result.workflow.closure).toMatchObject({ semanticDecision: "INCOMPLETE", terminalDisposition: "blocked", qualification: "unqualified" });
    expect(result.workflow.falseCompletion).toMatchObject({ verification: "failed", closure: "INCOMPLETE", stopDisposition: "blocked" });
    expect(result.workflow.uncertainExecution).toMatchObject({ initialStatus: "outcome_unknown", reconciledStatus: "outcome_unknown", replayStatus: "blocked", replayAttempts: 0, stopDisposition: "blocked-until-explicit-reconciliation" });
    expect(result.workflow.refusedAction).toMatchObject({ status: "blocked", attempts: 0 });
  }, 60_000);

  it("serializes provider evaluations and records returned metadata", async () => {
    let active = 0;
    let maximumActive = 0;
    let seenState: unknown;
    const inner: DecisionModel = {
      name: "live-provider-test-double",
      async evaluate<Q extends Record<string, Question>>(request: EvaluateRequest<Q>): Promise<EvaluateResult<Q>> {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        seenState = request.state;
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return {
          model: "jev-test-version", provider: "test-provider",
          questionHash: hashQuestions(request.questions as Record<string, Question>),
          answers: { classification: { type: "choice", choice: "ALLOW", confidence: 0.9, probabilities: { ALLOW: 0.9, DENY: 0.1 } } } as EvaluateResult<Q>["answers"],
          usage: { input_tokens: 17, output_tokens: 3 }, latency_ms: 2,
        };
      },
      async choice() { throw new Error("not used"); },
      async score() { throw new Error("not used"); },
      async probability() { throw new Error("not used"); },
    };
    const serial = new SerialDecisionModel(inner);
    const calls = Array.from({ length: 8 }, (_, index) => serial.evaluate({
      state: { node: `advice-${String(index + 1).padStart(2, "0")}`, depOutputs: { secretNodeId: "value" } },
      questions: { classification: questionForDemoCase(JEV_DEMO_CASES[index]!) },
    }));
    await Promise.all(calls);
    expect(maximumActive).toBe(1);
    expect(JSON.stringify(seenState)).not.toContain("advice-");
    expect(JSON.stringify(seenState)).not.toContain("secretNodeId");
    expect(serial.evaluations).toHaveLength(8);
    expect(serial.evaluations.every((entry) => entry.provider === "test-provider" && entry.model === "jev-test-version")).toBe(true);
    expect(serial.evaluations.every((entry) => entry.inputTokens === 17 && entry.outputTokens === 3)).toBe(true);
  });
});
