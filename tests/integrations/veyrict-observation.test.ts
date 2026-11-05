import { describe, expect, it } from "vitest";
import {
  digestReceipt,
  isJeverbObservation,
  JEVERB_OBSERVATION_VERSION,
  observationFromReceipt,
  resolveObservationHost,
  validateObservationForUse,
} from "../../src/integrations/veyrict/observation.js";
import { EvidenceLedger } from "../../src/evidence/ledger.js";

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1 as const,
    id: "r1",
    ts: new Date().toISOString(),
    sessionId: "s1",
    event: "PreToolUse",
    subjectHash: "abc",
    policyVersion: "1",
    deterministicFindings: ["protected command: rm -rf /"],
    enforcement: "deny",
    reasons: ["Protected command blocked: rm -rf /"],
    latencyMs: 3,
    ...overrides,
  };
}

describe("JeverbObservation contract", () => {
  it("is versioned", () => {
    expect(JEVERB_OBSERVATION_VERSION).toBe(1);
  });

  it("projects a receipt without exposing a permission surface", () => {
    const obs = observationFromReceipt(receipt(), "muse");
    expect(obs).toBeDefined();
    expect(obs?.schema).toBe(1);
    expect(obs?.host).toBe("muse");
    expect(obs?.deterministicFindings).toEqual(["protected command: rm -rf /"]);
    expect(obs?.advice).toEqual(["Protected command blocked: rm -rf /"]);
    expect(obs?.disposition).toBe("completed");
    expect(obs?.evidence.receiptDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(isJeverbObservation(obs)).toBe(true);
    // No authorization vocabulary anywhere on the wire object.
    for (const key of Object.keys(obs ?? {})) {
      expect(["permission", "allow", "approved", "accepted", "verdict", "authorized"]).not.toContain(key);
    }
  });

  it("projects bounded host-reported token counters as diagnostic metadata", () => {
    const obs = observationFromReceipt(
      receipt({
        eventHost: "muse",
        correlationId: "a".repeat(64),
        hostUsage: { inputTokens: 224_582, outputTokens: 83 },
        hostTurnCorrelationId: "b".repeat(64),
        parentExecutionCorrelationId: "c".repeat(64),
      }),
      "mcp",
    );
    expect(obs?.host).toBe("muse");
    expect(obs?.correlationId).toBe("a".repeat(64));
    expect(obs?.hostUsage).toEqual({ inputTokens: 224_582, outputTokens: 83 });
    expect(obs?.hostTurnCorrelationId).toBe("b".repeat(64));
    expect(obs?.parentExecutionCorrelationId).toBe("c".repeat(64));
    expect(isJeverbObservation(obs)).toBe(true);
    expect(isJeverbObservation({ ...obs, hostUsage: { inputTokens: -1 } })).toBe(false);
    expect(isJeverbObservation({ ...obs, hostUsage: { inputTokens: 2, spend: 1 } })).toBe(false);
    expect(isJeverbObservation({ ...obs, hostTurnCorrelationId: "raw-turn-id" })).toBe(false);
  });

  it("redacts secrets riding in reasons and findings", () => {
    const obs = observationFromReceipt(
      receipt({
        reasons: ["saw sk-abcdefgh12345678 in the diff"],
        deterministicFindings: ["token xoxb-12345678-abcdef in subject"],
      }),
      "ci",
    );
    expect(JSON.stringify(obs)).not.toContain("sk-abcdefgh12345678");
    expect(JSON.stringify(obs)).not.toContain("xoxb-12345678");
  });

  it("marks unavailable and error dispositions from the receipt", () => {
    expect(observationFromReceipt(receipt({ enforcement: "unavailable" }), "mcp")?.disposition).toBe("unavailable");
    const err = observationFromReceipt(receipt({ error: "ledger full" }), "mcp");
    expect(err?.disposition).toBe("error");
    expect(err?.error).toBe("ledger full");
  });

  it("bands confidence instead of transferring it across providers", () => {
    const strong = observationFromReceipt(receipt({ probabilities: { q: 0.9 } }), "mcp");
    expect(strong?.uncertainty).toMatchObject({ confidence: 0.9, band: "strong" });
    const marginal = observationFromReceipt(receipt({ probabilities: { q: 0.6 } }), "mcp");
    expect(marginal?.uncertainty).toMatchObject({ band: "marginal" });
    const none = observationFromReceipt(receipt(), "mcp");
    expect(none?.uncertainty).toMatchObject({ band: "unknown" });
  });

  it("rejects non-receipts and smuggled authority fields", () => {
    expect(observationFromReceipt({ nonsense: true }, "mcp")).toBeUndefined();
    const obs = observationFromReceipt(receipt(), "muse");
    expect(isJeverbObservation({ ...obs, permission: "allow" })).toBe(false);
    expect(isJeverbObservation({ ...obs, approved: true })).toBe(false);
    expect(isJeverbObservation({ ...obs, host: "unknown-host" })).toBe(false);
    expect(isJeverbObservation({ ...obs, schema: 2 })).toBe(false);
    expect(isJeverbObservation({ ...obs, evidence: { receiptDigest: "x" } })).toBe(false);
    expect(isJeverbObservation({ ...obs, uncertainty: { band: "certain", confidence: 2 } })).toBe(false);
    expect(isJeverbObservation(null)).toBe(false);
    expect(isJeverbObservation("observation")).toBe(false);
  });

  it("digests pin the exact backing receipt", () => {
    const a = receipt();
    const b = receipt({ reasons: ["different"] });
    expect(digestReceipt(a as never)).toMatch(/^[0-9a-f]{64}$/);
    expect(digestReceipt(a as never)).not.toBe(digestReceipt(b as never));
    void EvidenceLedger;
  });
});

describe("observation host resolution", () => {
  it("lets the recorded event host win over the retrieval hint", () => {
    expect(resolveObservationHost(receipt({ eventHost: "claude" }), "muse")).toBe("claude");
  });

  it("projects legacy receipts without a host as unknown, never mcp", () => {
    expect(resolveObservationHost(receipt(), "mcp")).toBe("unknown");
    expect(observationFromReceipt(receipt(), "mcp")?.host).toBe("unknown");
  });

  it("honors a real originating-host hint for legacy receipts", () => {
    expect(observationFromReceipt(receipt(), "muse")?.host).toBe("muse");
    expect(observationFromReceipt(receipt(), "ci")?.host).toBe("ci");
  });

  it("rejects forged hosts at the contract boundary", () => {
    const obs = observationFromReceipt(receipt({ eventHost: "muse" }), "mcp");
    expect(isJeverbObservation({ ...obs, host: "unknown-host" })).toBe(false);
    expect(isJeverbObservation({ ...obs, host: "unknown" })).toBe(true);
  });
});

describe("observation uncertainty semantics", () => {
  it("keeps a single probability with its band", () => {
    const obs = observationFromReceipt(receipt({ probabilities: { q: 0.6 } }), "mcp");
    expect(obs?.uncertainty).toMatchObject({ confidence: 0.6, band: "marginal" });
  });

  it("refuses to combine multiple probabilities into a confidence", () => {
    const obs = observationFromReceipt(receipt({ probabilities: { a: 0.95, b: 0.1 } }), "mcp");
    expect(obs?.uncertainty.band).toBe("unknown");
    expect(obs?.uncertainty.confidence).toBeUndefined();
  });

  it("stays unknown with no probabilities", () => {
    const obs = observationFromReceipt(receipt(), "mcp");
    expect(obs?.uncertainty).toMatchObject({ band: "unknown" });
  });

  it("rejects out-of-range and non-finite probabilities instead of projecting them", () => {
    for (const bad of [-0.2, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const obs = observationFromReceipt(receipt({ probabilities: { q: bad } }), "mcp");
      expect(obs?.uncertainty.band).toBe("unknown");
      expect(obs?.uncertainty.confidence).toBeUndefined();
      expect(isJeverbObservation(obs)).toBe(true);
    }
  });
});

describe("observation candidate correlation", () => {
  it("prefers caller-supplied correlation, falls back to the receipt's", () => {
    const withReceipt = observationFromReceipt(receipt({ candidate: "sha-from-harness" }), "mcp");
    expect(withReceipt?.candidate).toBe("sha-from-harness");
    const overridden = observationFromReceipt(receipt({ candidate: "sha-from-harness" }), "mcp", {
      candidate: "sha-from-caller",
      operation: "graph-1:node-3",
    });
    expect(overridden?.candidate).toBe("sha-from-caller");
    expect(overridden?.operation).toBe("graph-1:node-3");
  });
});

describe("graph operation correlation", () => {
  it("projects the graph run and opaque full receipt correlation", () => {
    const obs = observationFromReceipt(receipt({
      turnId: "run-123",
      correlationId: "a".repeat(64),
      outputDigest: "c".repeat(64),
      executionStatus: "failed",
    }), "muse");
    expect(obs).toMatchObject({ operationId: "run-123", correlationId: "a".repeat(64), outputDigest: "c".repeat(64), executionStatus: "failed" });
    expect(isJeverbObservation(obs)).toBe(true);
    expect(isJeverbObservation({ ...obs, correlationId: "truncated" })).toBe(false);
  });

  it("validates operation and receipt correlation independently of digest integrity", () => {
    const obs = observationFromReceipt(receipt({
      turnId: "run-123",
      correlationId: "a".repeat(64),
    }), "muse");
    expect(validateObservationForUse(obs, { operationId: "run-123", correlationId: "a".repeat(64) }).ok).toBe(true);
    expect(validateObservationForUse(obs, { operationId: "run-other" })).toEqual({ ok: false, reason: "operation-mismatch" });
    expect(validateObservationForUse(obs, { correlationId: "b".repeat(64) })).toEqual({ ok: false, reason: "correlation-mismatch" });
  });
});

describe("validateObservationForUse", () => {
  it("accepts a schema-valid observation with matching correlation", () => {
    const obs = observationFromReceipt(receipt({ candidate: "sha-1" }), "muse");
    const result = validateObservationForUse(obs, { candidate: "sha-1", sessionId: "s1" });
    expect(result.ok).toBe(true);
  });

  it("rejects wrong-candidate, wrong-session, and digest mismatches", () => {
    const obs = observationFromReceipt(receipt({ candidate: "sha-1" }), "muse");
    expect(validateObservationForUse(obs, { candidate: "sha-2" })).toEqual({
      ok: false,
      reason: "candidate-mismatch",
    });
    expect(validateObservationForUse(obs, { sessionId: "other" })).toEqual({
      ok: false,
      reason: "session-mismatch",
    });
    expect(validateObservationForUse(obs, { receiptDigest: "0".repeat(64) })).toEqual({
      ok: false,
      reason: "receipt-digest-mismatch",
    });
    const digest = obs?.evidence.receiptDigest;
    expect(validateObservationForUse(obs, digest === undefined ? {} : { receiptDigest: digest }).ok).toBe(true);
  });

  it("rejects non-observations without throwing", () => {
    expect(validateObservationForUse({ nonsense: true })).toEqual({ ok: false, reason: "invalid-observation" });
    expect(validateObservationForUse(null)).toEqual({ ok: false, reason: "invalid-observation" });
  });
});
