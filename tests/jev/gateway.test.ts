import { describe, expect, it } from "vitest";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDecisionModel } from "../../src/jev/factory.js";
import { JevGatewayDecisionModel } from "../../src/jev/gateway.js";
import { JevQuotaError, JevTimeoutError } from "../../src/jev/errors.js";
import { EvidenceLedger, hashSubject } from "../../src/evidence/ledger.js";
import { testLedgerForFile } from "../helpers/control-state.js";

describe("local gateway Jev slot", () => {
  it("classifies a gateway 403 quota refusal instead of reporting an unexpected status", async () => {
    const model = new JevGatewayDecisionModel({
      baseUrl: "http://127.0.0.1:18769/jev",
      model: "typesafe/jev-latest",
      timeoutMs: 1000,
      maxRetries: 0,
      fetch: (async () => new Response(JSON.stringify({
        error: { code: "quota_exhausted", message: "quota exhausted" },
      }), { status: 403, headers: { "Content-Type": "application/json" } })) as typeof fetch,
    });

    await expect(model.evaluate({
      state: { objective: "check" },
      questions: { q: { type: "noul", instructions: "Is the quota available?" } },
    })).rejects.toMatchObject({
      name: "JevQuotaError",
      status: 403,
      message: expect.stringContaining("quota/entitlement policy (HTTP 403"),
    });
  });

  it("sends typed questions to the named slot without forwarding an upstream key", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const model = new JevGatewayDecisionModel({
      baseUrl: "http://127.0.0.1:18769/jev",
      model: "typesafe/jev-latest",
      timeoutMs: 1000,
      maxRetries: 0,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        seenUrl = String(url);
        seenInit = init;
        return new Response(JSON.stringify({
          id: "jev-response-fixture-001",
          provider: "TypeSafe",
          model: "typesafe/jev-1.14-20261014",
          answers: { closure: { type: "choice", choice: "COMPLETE", probabilities: { COMPLETE: 0.7, INCOMPLETE: 0.1, BLOCKED: 0.1, INSUFFICIENT_EVIDENCE: 0.1 }, confidence: 0.7 } },
          usage: { input_tokens: 8, output_tokens: 3, cost: 0.001 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });

    const result = await model.evaluate({
      state: { objective: "finish", checks: ["build"] },
      correlationId: "jev-gateway-fixture-correlation-001",
      questions: { closure: { type: "choice", instructions: "Is it done?", criteria: { COMPLETE: null, INCOMPLETE: null, BLOCKED: null, INSUFFICIENT_EVIDENCE: null } } },
    });

    expect(seenUrl).toBe("http://127.0.0.1:18769/jev/api/alpha/decisions");
    expect((seenInit?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect((seenInit?.headers as Record<string, string>)["X-Locus-Local-Client"]).toBe("muse-code");
    expect((seenInit?.headers as Record<string, string>)["X-FI-Local-Client"]).toBeUndefined();
    expect((seenInit?.headers as Record<string, string>)["X-Request-ID"]).toBe("jev-gateway-fixture-correlation-001");
    const body = JSON.parse(String(seenInit?.body));
    expect(body.model).toBe("typesafe/jev-latest");
    expect(body.state).toEqual({ objective: "finish", checks: ["build"] });
    expect(body.questions).toEqual([{ id: "closure", type: "choice", instructions: "Is it done?", criteria: { COMPLETE: null, INCOMPLETE: null, BLOCKED: null, INSUFFICIENT_EVIDENCE: null } }]);
    expect(result.provider).toBe("jev-gateway");
    expect(result.correlationId).toBe("jev-gateway-fixture-correlation-001");
    expect(result.answers.closure.choice).toBe("COMPLETE");
    expect(result.answers.closure.probabilities).toEqual({ COMPLETE: 0.7, INCOMPLETE: 0.1, BLOCKED: 0.1, INSUFFICIENT_EVIDENCE: 0.1 });
    expect(result.model).toBe("typesafe/jev-1.14-20261014");
    expect(result.usage).toEqual({ input_tokens: 8, output_tokens: 3, cost_usd: 0.001 });

    const correlationId = result.correlationId!;
    const ledger = testLedgerForFile(join(mkdtempSync(join(tmpdir(), "jev-gateway-receipt-")), "evidence.log"));
    expect(ledger.appendDetailed({
      schema: 1, id: "", ts: new Date().toISOString(), sessionId: "muse-fixture-session",
      correlationId, event: "JevDecision", subjectHash: hashSubject("finish|build"), policyVersion: "jev-decision/1",
      model: result.model, probabilities: result.answers.closure.probabilities, judgment: result.answers.closure.choice,
      deterministicFindings: [], enforcement: "recorded", reasons: [], latencyMs: result.latency_ms,
    }, { durable: true }).ok).toBe(true);
    expect(ledger.read().records[0]).toMatchObject({
      correlationId, model: "typesafe/jev-1.14-20261014", judgment: "COMPLETE",
      probabilities: { COMPLETE: 0.7, INCOMPLETE: 0.1, BLOCKED: 0.1, INSUFFICIENT_EVIDENCE: 0.1 },
    });
  });

  it("wraps scalar state for the gateway object-state contract", async () => {
    let body: Record<string, unknown> = {};
    const model = new JevGatewayDecisionModel({
      baseUrl: "http://127.0.0.1:18769/jev", model: "typesafe/jev-1.14", timeoutMs: 1000, maxRetries: 0,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.2 } } }), { status: 200 });
      }) as typeof fetch,
    });
    await model.evaluate({ state: "scalar input", questions: { q: { type: "noul", instructions: "true?" } } });
    expect(body.state).toEqual({ input: "scalar input" });
  });

  it("bounds one failed gateway call without retry, then allows a fresh call to recover", async () => {
    let calls = 0;
    const model = new JevGatewayDecisionModel({
      baseUrl: "http://127.0.0.1:18769/jev",
      model: "typesafe/jev-1.14",
      timeoutMs: 25,
      maxRetries: 0,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          const signal = init?.signal as AbortSignal;
          return await new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("request timed out", "AbortError")), { once: true });
          });
        }
        return new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.2 } } }), { status: 200 });
      }) as typeof fetch,
    });
    const request = { state: { task: "bounded" }, questions: { q: { type: "noul" as const, instructions: "Is it safe?" } } };

    await expect(model.evaluate(request)).rejects.toBeInstanceOf(JevTimeoutError);
    expect(calls).toBe(1);
    const recovered = await model.evaluate(request);
    expect(recovered.answers.q).toMatchObject({ type: "noul", noul: 0.2 });
    expect(calls).toBe(2);
  });

  it("factory selects this backend only for the exact loopback Jev slot", () => {
    expect(buildDecisionModel({
      backend: "jev-gateway", baseUrl: "http://127.0.0.1:18769/jev", model: "typesafe/jev-1.14",
      timeoutMs: 1000, maxRetries: 0,
    })).toBeInstanceOf(JevGatewayDecisionModel);
    expect(buildDecisionModel({
      backend: "jev-gateway", baseUrl: "http://127.0.0.1:18769/jev", model: "typesafe/jev-latest",
      timeoutMs: 1000, maxRetries: 0,
    })).toBeInstanceOf(JevGatewayDecisionModel);
    expect(() => buildDecisionModel({
      backend: "jev-gateway", baseUrl: "https://example.invalid/jev", model: "typesafe/jev-1.14",
      timeoutMs: 1000, maxRetries: 0,
    })).toThrow(/local Jev slot/);
    expect(() => buildDecisionModel({
      backend: "jev-gateway", baseUrl: "http://127.0.0.1:18769/jev", model: "typesafe/jev-other",
      timeoutMs: 1000, maxRetries: 0,
    })).toThrow(/requires the Jev Decisions model/);
  });
});
