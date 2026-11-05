import { describe, expect, it } from "vitest";
import { describeError, JevConnectionError, JevError, classifyTransportFailure } from "../../src/jev/errors.js";
import { OpenRouterJevDecisionModel, probeOpenRouterJevEndpoint } from "../../src/jev/openrouter.js";
import { createFailFastDecisionModel } from "../../scripts/jev-semantic-paired-dev.js";
import type { DecisionModel } from "../../src/decision/types.js";

function systemError(code: string, message = "fixture transport failure"): Error {
  return Object.assign(new Error(message), { code });
}

describe("sanitized Jev transport diagnostics", () => {
  it.each([
    [systemError("ENOTFOUND"), { kind: "dns", code: "DNS_ENOTFOUND" }],
    [systemError("ECONNRESET"), { kind: "tcp", code: "TCP_ECONNRESET" }],
    [systemError("ERR_TLS_CERT_ALTNAME_INVALID"), { kind: "tls", code: "TLS_ERR_TLS_CERT_ALTNAME_INVALID" }],
    [systemError("ERR_TUNNEL_CONNECTION_FAILED"), { kind: "proxy", code: "ERR_TUNNEL_CONNECTION_FAILED" }],
    [systemError("ETIMEDOUT"), { kind: "timeout", code: "TIMEOUT_ETIMEDOUT" }],
  ] as const)("classifies %s", (cause, expected) => {
    expect(classifyTransportFailure(cause)).toEqual(expected);
  });

  it("preserves nested DNS cause code without exposing raw error text or credentials", async () => {
    const credential = "Bearer deliberately-secret-fixture";
    const cause = systemError("ENOTFOUND", `getaddrinfo ENOTFOUND openrouter.ai ${credential}`);
    const fetchImpl = (async () => { throw new TypeError("fetch failed", { cause }); }) as typeof fetch;
    const model = new OpenRouterJevDecisionModel({
      apiKey: "test-key", model: "typesafe/jev-latest", maxRetries: 0, fetch: fetchImpl,
    });
    let failure: unknown;
    try {
      await model.evaluate({ state: { x: 1 }, questions: { q: { type: "noul", instructions: "Is x one?" } } });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(JevConnectionError);
    expect(failure).toMatchObject({
      code: "DNS_ENOTFOUND",
      transportDiagnostic: { kind: "dns", code: "DNS_ENOTFOUND" },
    });
    expect(describeError(failure)).not.toContain(credential);
    expect((failure as Error).message).toBe("Could not reach decision provider.");
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("attaches a bounded HTTP diagnostic to provider status failures", async () => {
    const model = new OpenRouterJevDecisionModel({
      apiKey: "test-key", model: "typesafe/jev-latest", maxRetries: 0,
      fetch: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
    });
    await expect(model.evaluate({
      state: { x: 1 }, questions: { q: { type: "noul", instructions: "Is x one?" } },
    })).rejects.toMatchObject({
      status: 503,
      transportDiagnostic: { kind: "http", code: "HTTP_503", status: 503 },
    });
  });

  it("probes the Decisions URL with unauthenticated HEAD and treats method-level 404 as reachable", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const probe = await probeOpenRouterJevEndpoint((async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      requestedInit = init;
      return new Response(null, { status: 404 });
    }) as typeof fetch);
    expect(requestedUrl).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(requestedInit?.method).toBe("HEAD");
    expect(requestedInit?.body).toBeUndefined();
    expect(new Headers(requestedInit?.headers).has("authorization")).toBe(false);
    expect(probe).toEqual({ reachable: true, httpStatus: 404 });
  });

  it("aborts further model calls after the first typed transport failure", async () => {
    let underlyingCalls = 0;
    const upstream: DecisionModel = {
      name: "transport-fixture",
      evaluate: async () => {
        underlyingCalls += 1;
        throw new JevConnectionError("Could not reach decision provider.", {
          code: "DNS_ENOTFOUND",
          transportDiagnostic: { kind: "dns", code: "DNS_ENOTFOUND" },
        });
      },
      choice: async () => { throw new Error("unused"); },
      score: async () => { throw new Error("unused"); },
      probability: async () => { throw new Error("unused"); },
    };
    const failFast = createFailFastDecisionModel(upstream);
    const request = { state: { x: 1 }, questions: { q: { type: "noul" as const, instructions: "Is x one?" } } };
    await expect(failFast.model.evaluate(request)).rejects.toMatchObject({
      transportDiagnostic: { kind: "dns", code: "DNS_ENOTFOUND" },
    });
    await expect(failFast.model.evaluate(request)).rejects.toMatchObject({
      transportDiagnostic: { kind: "dns", code: "DNS_ENOTFOUND" },
    });
    expect(failFast.attemptedRequests).toBe(1);
    expect(failFast.transportFailure).toEqual({ kind: "dns", code: "DNS_ENOTFOUND" });
    expect(underlyingCalls).toBe(1);
  });
});
