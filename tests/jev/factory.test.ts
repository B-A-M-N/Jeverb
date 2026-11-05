import { describe, expect, it } from "vitest";
import { hashQuestions } from "../../src/decision/provenance.js";
import { loadHookConfig } from "../../src/hooks/config.js";
import { JevDecisionModel } from "../../src/jev/client.js";
import { assertModelBackendMatch, buildDecisionModel, isOpenRouterBaseUrl } from "../../src/jev/factory.js";
import { OpenRouterDecisionModel, OpenRouterJevDecisionModel } from "../../src/jev/openrouter.js";

const base = { apiKey: "secret-key", model: "m", timeoutMs: 1000, maxRetries: 0 };

describe("buildDecisionModel", () => {
  it("selects the OpenRouter adapter for the OpenRouter base URL", () => {
    expect(isOpenRouterBaseUrl("https://openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouterBaseUrl("https://openrouter.ai/api/v1/")).toBe(true);
    const model = buildDecisionModel({
      ...base,
      backend: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(model).toBeInstanceOf(OpenRouterDecisionModel);
  });

  it("selects the OpenRouter adapter for an approved relay, not the native client", () => {
    const model = buildDecisionModel({
      ...base,
      backend: "openrouter",
      baseUrl: "http://127.0.0.1:18789",
      allowCustomRelay: true,
    });
    expect(model).toBeInstanceOf(OpenRouterDecisionModel);
  });

  it("selects OpenRouter's native Decisions protocol for Jev model IDs", () => {
    const model = buildDecisionModel({
      ...base,
      backend: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "typesafe/jev-latest",
    });
    expect(model).toBeInstanceOf(OpenRouterJevDecisionModel);
  });

  it("refuses an unapproved relay instead of silently using the native client", () => {
    expect(() =>
      buildDecisionModel({ ...base, backend: "openrouter", baseUrl: "http://127.0.0.1:18789" }),
    ).toThrow(/relay/);
  });

  it("keeps the native client for TypeSafe and unknown hosts", () => {
    expect(isOpenRouterBaseUrl("https://api.typesafe.ai")).toBe(false);
    expect(
      buildDecisionModel({ ...base, backend: "typesafe", baseUrl: "https://api.typesafe.ai" }),
    ).toBeInstanceOf(JevDecisionModel);
    expect(
      buildDecisionModel({ ...base, backend: "typesafe", baseUrl: "https://proxy.internal/v1" }),
    ).toBeInstanceOf(JevDecisionModel);
  });
});

describe("assertModelBackendMatch", () => {
  it("accepts the pinned native and OpenRouter pairs", () => {
    expect(() => assertModelBackendMatch("https://api.typesafe.ai", "jev-1.14.0")).not.toThrow();
    expect(() =>
      assertModelBackendMatch("https://openrouter.ai/api/v1", "typesafe/jev-router"),
    ).not.toThrow();
  });

  it("requires OpenRouter's vendor namespace for native Jev IDs", () => {
    expect(() => assertModelBackendMatch("https://openrouter.ai/api/v1/", "jev-1.14.0")).toThrow(
      /missing OpenRouter's provider namespace/,
    );
    expect(() =>
      buildDecisionModel({
        ...base,
        backend: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "jev-1.14.0",
      }),
    ).toThrow(/missing OpenRouter's provider namespace/);
  });

  it("rejects a vendor-namespaced id on the native backend", () => {
    expect(() => assertModelBackendMatch("https://api.typesafe.ai", "typesafe/jev-router")).toThrow(
      /vendor-namespaced/,
    );
  });
});

describe("hashQuestions", () => {
  const questions = { q: { type: "noul" as const, instructions: "urgent?" } };

  it("is stable and looks like a sha256 hex digest", () => {
    expect(hashQuestions(questions)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashQuestions(questions)).toBe(hashQuestions(structuredClone(questions)));
  });

  it("changes when instructions, criteria, or option order change", () => {
    const edited = { q: { type: "noul" as const, instructions: "urgent! " } };
    const choice = (criteria: Record<string, null>) => ({
      q: { type: "choice" as const, instructions: "pick", criteria },
    });
    expect(hashQuestions(edited)).not.toBe(hashQuestions(questions));
    expect(hashQuestions(choice({ a: null, b: null }))).not.toBe(hashQuestions(choice({ b: null, a: null })));
  });
});

describe("loadHookConfig backend selection", () => {
  it("stays native by default", () => {
    const config = loadHookConfig({});
    expect(config.baseUrl).toBe("https://api.typesafe.ai");
    expect(config.model).toBe("jev-1.14.0");
  });

  it("switches defaults to OpenRouter with JEV_BACKEND=openrouter", () => {
    const config = loadHookConfig({ JEV_BACKEND: "openrouter", OPENROUTER_API_KEY: "sk-or-test-key" });
    expect(config.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.model).toBe("typesafe/jev-latest");
    expect(config.apiKey).toBe("sk-or-test-key");
    expect(config.warnings).toEqual([]);
    const model = buildDecisionModel({
      apiKey: config.apiKey!,
      backend: "openrouter",
      baseUrl: config.baseUrl,
      model: config.model,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
    });
    expect(model).toBeInstanceOf(OpenRouterJevDecisionModel);
  });

  it("prefers the backend-matching key and honors explicit overrides", () => {
    const both = loadHookConfig({
      JEV_BACKEND: "openrouter",
      OPENROUTER_API_KEY: "sk-or-test-key",
      TYPESAFE_API_KEY: "ts-key",
    });
    expect(both.apiKey).toBe("sk-or-test-key");
    // A key from the other backend is ignored with a warning, never silently
    // forwarded to the wrong provider (where it would only produce 401s).
    const fallback = loadHookConfig({ JEV_BACKEND: "openrouter", TYPESAFE_API_KEY: "ts-key" });
    expect(fallback.apiKey).toBeNull();
    expect(fallback.warnings.join("\n")).toMatch(/ignoring TYPESAFE_API_KEY/);
    const nativeWithWrongKey = loadHookConfig({ OPENROUTER_API_KEY: "sk-or-abc" });
    expect(nativeWithWrongKey.apiKey).toBeNull();
    expect(nativeWithWrongKey.warnings.join("\n")).toMatch(/ignoring OPENROUTER_API_KEY/);
    const shape = loadHookConfig({ JEV_BACKEND: "openrouter", OPENROUTER_API_KEY: "not-an-or-key" });
    expect(shape.apiKey).toBe("not-an-or-key");
    expect(shape.warnings.join("\n")).toMatch(/sk-or- prefix/);
    const explicit = loadHookConfig({
      JEV_BACKEND: "openrouter",
      JEV_MODEL: "typesafe/other",
      TYPESAFE_BASE_URL: "https://api.typesafe.ai",
    });
    expect(explicit.model).toBe("typesafe/other");
    expect(explicit.baseUrl).toBe("https://api.typesafe.ai");
  });

  it("warns on an unknown backend and stays native", () => {
    const config = loadHookConfig({ JEV_BACKEND: "quantum" });
    expect(config.baseUrl).toBe("https://api.typesafe.ai");
    expect(config.warnings.length).toBeGreaterThan(0);
  });
});
