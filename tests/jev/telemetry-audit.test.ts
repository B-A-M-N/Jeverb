import { describe, expect, it } from "vitest";
import { summarizeInstalledTelemetry } from "../../src/jev/telemetry-audit.js";

describe("installed telemetry audit", () => {
  it("summarizes provider failures and evidence outcomes without retaining raw error text", () => {
    const result = summarizeInstalledTelemetry({
      analyzedAt: "2026-11-03T00:00:00.000Z",
      decisionsText: [
        JSON.stringify({ event: "PreToolUse", decision: "error", tool_name: "jev_execute_graph", model: "typesafe/jev-1.14", error: "TypeSafe returned an unexpected status on /api/alpha/decisions. [httpStatus=302 backend=jev-gateway model=typesafe/jev-1.14] secret-token=DO_NOT_EXPORT" }),
        JSON.stringify({ event: "Stop", decision: "error", error: "AbortError: this operation was aborted" }),
        "not-json",
      ].join("\n"),
      evidenceText: [
        JSON.stringify({ event: "PreToolUse", enforcement: "advise", judgment: "JUDGMENT_ATTEMPTED", subject: "private prompt must not escape" }),
        JSON.stringify({ event: "Stop", enforcement: "deny", judgment: "MODEL_NOT_CONFIGURED" }),
      ].join("\n"),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("DO_NOT_EXPORT");
    expect(serialized).not.toContain("private prompt");
    expect(result).toMatchObject({
      schema: "jeverb-installed-telemetry-audit/1",
      sources: { decisions: { records: 2, malformedLines: 1 }, evidence: { records: 2 } },
      decisions: {
        errorClassCounts: { abort: 1, typed_decision_unexpected_status: 1 },
        recordedHttpStatusCounts: { "302": 1 },
        observedBackendLabels: { "jev-gateway": 1 },
        observedModelLabels: { "typesafe/jev-1.14": 1 },
        graphOrJevToolNames: { jev_execute_graph: 1 },
      },
      evidence: { judgmentOutcomeCounts: { JUDGMENT_ATTEMPTED: 1, MODEL_NOT_CONFIGURED: 1 } },
    });
  });

  it("does not infer provider or serving identity from an error family name", () => {
    const result = summarizeInstalledTelemetry({ decisionsText: JSON.stringify({ event: "PreToolUse", decision: "error", error: "TypeSafe returned an unexpected status on /api/alpha/decisions." }), evidenceText: "" });
    expect(result.decisions).toMatchObject({
      errorClassCounts: { typed_decision_unexpected_status: 1 },
      identityFieldRows: { backend: 0, model: 0, provider: 0 },
      observedBackendLabels: {},
      observedModelLabels: {},
      observedProviderLabels: {},
    });
  });
});
