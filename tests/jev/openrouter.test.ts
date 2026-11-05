import { describe, expect, it } from "vitest";
import { OpenRouterDecisionModel } from "../../src/jev/openrouter.js";
import { JevAuthError, JevOverloadedError, JevRateLimitError, JevValidationError } from "../../src/jev/errors.js";

function stubFetch(content: unknown, init: { status?: number; usage?: unknown; servedModel?: unknown } = {}) {
  const status = init.status ?? 200;
  return (async () => {
    if (init.status === 429) {
      return new Response("rate limited", { status });
    }
    if (status !== 200) {
      return new Response("no", { status });
    }
    return new Response(
      JSON.stringify({
        id: "gen-test-1",
        model: init.servedModel ?? "typesafe/jev-router",
        choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
        usage: init.usage ?? { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

const base = { apiKey: "test-key", model: "typesafe/jev-router" };

describe("OpenRouterDecisionModel", () => {
  function sequenceFetch(script: Array<Response | Error>) {
    let calls = 0;
    const fetchImpl = (async () => {
      const next = script[Math.min(calls, script.length - 1)];
      calls += 1;
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }

  it("maps a noul answer", async () => {
    const model = new OpenRouterDecisionModel({ ...base, fetch: stubFetch({ q: { p: 0.97 } }) });
    const result = await model.evaluate({
      state: "s",
      questions: { q: { type: "noul", instructions: "urgent?" } },
    });
    expect(result.answers.q).toEqual({ type: "noul", noul: 0.97 });
    expect(result.model).toBe("typesafe/jev-router");
    expect(result.provider).toBe("openrouter");
    expect(result.questionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("records the serving model returned by OpenRouter instead of the requested alias", async () => {
    const model = new OpenRouterDecisionModel({
      ...base,
      fetch: stubFetch({ q: { p: 0.97 } }, { servedModel: "typesafe/jev-1.14-20261014" }),
    });
    const result = await model.evaluate({
      state: "s",
      questions: { q: { type: "noul", instructions: "urgent?" } },
    });
    expect(result.model).toBe("typesafe/jev-1.14-20261014");
    expect(result.correlationId).toBe("gen-test-1");
  });

  it("rejects a successful response without a valid provider request id", async () => {
    const fetchWithoutId = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await stubFetch({ q: { p: 0.97 } })(input, init);
      const body = await response.json() as Record<string, unknown>;
      delete body.id;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const model = new OpenRouterDecisionModel({ ...base, fetch: fetchWithoutId });
    await expect(model.evaluate({
      state: "s",
      questions: { q: { type: "noul", instructions: "urgent?" } },
    })).rejects.toBeInstanceOf(JevValidationError);
  });

  it("rejects a successful response without a serving model identity", async () => {
    const fetchWithoutIdentity = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await stubFetch({ q: { p: 0.97 } })(input, init);
      const body = await response.json() as Record<string, unknown>;
      delete body.model;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const model = new OpenRouterDecisionModel({ ...base, fetch: fetchWithoutIdentity });
    await expect(model.evaluate({
      state: "s",
      questions: { q: { type: "noul", instructions: "urgent?" } },
    })).rejects.toBeInstanceOf(JevValidationError);
  });

  it("maps a choice answer with normalized probabilities", async () => {
    const model = new OpenRouterDecisionModel({
      ...base,
      fetch: stubFetch({ q: { pick: "b", probabilities: { a: 0.25, b: 0.75 } } }),
    });
    const result = await model.evaluate({
      state: "s",
      questions: { q: { type: "choice", instructions: "pick", criteria: { a: null, b: null } } },
    });
    expect(result.answers.q).toEqual({
      type: "choice",
      choice: "b",
      probabilities: { a: 0.25, b: 0.75 },
      confidence: 0.75,
    });
  });

  it("maps a score answer to the expected level index", async () => {
    const model = new OpenRouterDecisionModel({
      ...base,
      fetch: stubFetch({ q: { index: 0, probabilities: [0.2, 0.8] } }),
    });
    const result = await model.evaluate({
      state: "s",
      questions: { q: { type: "score", instructions: "rate", criteria: ["low", "high"] } },
    });
    const answer = result.answers.q;
    expect(answer.type).toBe("score");
    if (answer.type === "score") {
      expect(answer.score).toBeCloseTo(0.8, 5);
      expect(answer.confidence).toBeCloseTo(0.8, 5);
    }
  });

  it("accepts a bare number for a noul answer", async () => {
    // Live models sometimes emit `{"destructive": 0.12}` despite the
    // `{p: ...}` schema in the prompt. A bare number is unambiguous P(yes).
    const model = new OpenRouterDecisionModel({ ...base, fetch: stubFetch({ q: 0.12 }) });
    const result = await model.evaluate({
      state: "s",
      questions: { q: { type: "noul", instructions: "urgent?" } },
    });
    expect(result.answers.q).toEqual({ type: "noul", noul: 0.12 });
  });

  it("still rejects a bare string for a noul answer", async () => {
    const model = new OpenRouterDecisionModel({ ...base, fetch: stubFetch({ q: "destructive" }) });
    await expect(
      model.evaluate({ state: "s", questions: { q: { type: "noul", instructions: "x" } } }),
    ).rejects.toThrow(/not an object/);
  });

  it("rejects unknown picks and missing questions", async () => {
    const badPick = new OpenRouterDecisionModel({ ...base, fetch: stubFetch({ q: { pick: "zzz" } }) });
    await expect(
      badPick.evaluate({
        state: "s",
        questions: { q: { type: "choice", instructions: "pick", criteria: { a: null } } },
      }),
    ).rejects.toBeInstanceOf(JevValidationError);

    const missing = new OpenRouterDecisionModel({ ...base, fetch: stubFetch({ other: { p: 1 } }) });
    await expect(
      missing.evaluate({ state: "s", questions: { q: { type: "noul", instructions: "x" } } }),
    ).rejects.toBeInstanceOf(JevValidationError);
  });

  it("rejects non-JSON content and HTTP errors", async () => {
    const garbage = new OpenRouterDecisionModel({ ...base, fetch: stubFetch("hello world") });
    await expect(
      garbage.evaluate({ state: "s", questions: { q: { type: "noul", instructions: "x" } } }),
    ).rejects.toBeInstanceOf(JevValidationError);

    const denied = new OpenRouterDecisionModel({ ...base, fetch: stubFetch({}, { status: 401 }) });
    await expect(
      denied.evaluate({ state: "s", questions: { q: { type: "noul", instructions: "x" } } }),
    ).rejects.toBeInstanceOf(JevAuthError);

    const sleeps: number[] = [];
    const noSleep = { sleep: async (ms: number) => void sleeps.push(ms) };
    const { fetchImpl: limitedFetch, calls: limitedCalls } = sequenceFetch([
      new Response("rate limited", { status: 429 }),
    ]);
    const limited = new OpenRouterDecisionModel({ ...base, ...noSleep, fetch: limitedFetch });
    await expect(
      limited.evaluate({ state: "s", questions: { q: { type: "noul", instructions: "x" } } }),
    ).rejects.toBeInstanceOf(JevRateLimitError);
    // A 429 is terminal: exactly one request, no backoff sleep.
    expect(limitedCalls()).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  describe("bounded retries", () => {
    const ok = (content: unknown) =>
      new Response(JSON.stringify({ id: "gen-test-1", model: "typesafe/jev-router", choices: [{ message: { content: JSON.stringify(content) } }] }), {
        status: 200,
      });

    it("treats a 429 rate-limit as terminal without retrying", async () => {
      // A 429 (including a free-tier warmup throttle) is a terminal outcome,
      // not a retryable one: exactly one request leaves this process.
      const { fetchImpl, calls } = sequenceFetch([
        new Response("slow down", { status: 429 }),
        ok({ q: { p: 0.8 } }),
      ]);
      const sleeps: number[] = [];
      const model = new OpenRouterDecisionModel({
        ...base,
        fetch: fetchImpl,
        sleep: async (ms) => void sleeps.push(ms),
      });
      await expect(
        model.evaluate({ state: "s", questions: { q: { type: "noul", instructions: "x" } } }),
      ).rejects.toBeInstanceOf(JevRateLimitError);
      expect(calls()).toBe(1);
      expect(sleeps).toHaveLength(0);
    });

    it("ignores retry-after on a 429 and still sends exactly one request", async () => {
      // A retry-after hint does not resurrect a refused request.
      const { fetchImpl, calls } = sequenceFetch([
        new Response("slow down", { status: 429, headers: { "retry-after": "120" } }),
        ok({ q: { p: 0.8 } }),
      ]);
      const sleeps: number[] = [];
      const model = new OpenRouterDecisionModel({
        ...base,
        fetch: fetchImpl,
        sleep: async (ms) => void sleeps.push(ms),
      });
      await expect(
        model.evaluate({ state: "s", questions: { q: { type: "noul", instructions: "x" } } }),
      ).rejects.toBeInstanceOf(JevRateLimitError);
      expect(calls()).toBe(1);
      expect(sleeps).toHaveLength(0);
    });

    it("treats a warmup-stub prose body as terminal without retrying", async () => {
      const { fetchImpl, calls } = sequenceFetch([
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "model is warming up, please try again" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ]);
      const model = new OpenRouterDecisionModel({ ...base, fetch: fetchImpl, sleep: async () => {} });
      await expect(
        model.evaluate({ state: "s", questions: { q: { type: "noul", instructions: "x" } } }),
      ).rejects.toBeInstanceOf(JevValidationError);
      expect(calls()).toBe(1);
    });

    it("retries a network failure, then succeeds", async () => {
      const { fetchImpl, calls } = sequenceFetch([new TypeError("socket hang up"), ok({ q: { p: 0.1 } })]);
      const model = new OpenRouterDecisionModel({
        ...base,
        fetch: fetchImpl,
        maxRetries: 1,
        sleep: async () => {},
      });
      const result = await model.evaluate({
        state: "s",
        questions: { q: { type: "noul", instructions: "x" } },
      });
      expect(result.answers.q.noul).toBe(0.1);
      expect(calls()).toBe(2);
    });

    it("gives up on persistent 5xx and reports the status", async () => {
      const { fetchImpl, calls } = sequenceFetch([new Response("bad", { status: 503 })]);
      const model = new OpenRouterDecisionModel({
        ...base,
        fetch: fetchImpl,
        maxRetries: 1,
        sleep: async () => {},
      });
      await expect(
        model.evaluate({ state: "s", questions: { q: { type: "noul", instructions: "x" } } }),
      ).rejects.toBeInstanceOf(JevOverloadedError);
      expect(calls()).toBe(2);
    });

    it("never retries auth failures", async () => {
      const { fetchImpl, calls } = sequenceFetch([new Response("no", { status: 403 })]);
      const model = new OpenRouterDecisionModel({
        ...base,
        fetch: fetchImpl,
        sleep: async () => {},
      });
      await expect(
        model.evaluate({ state: "s", questions: { q: { type: "noul", instructions: "x" } } }),
      ).rejects.toBeInstanceOf(JevAuthError);
      expect(calls()).toBe(1);
    });
  });

  it("honors per-request model override and rejects empty questions", async () => {
    let seenModel = "";
    const capture = (async (url: string | URL | Request, init?: RequestInit) => {
      seenModel = JSON.parse(String(init?.body)).model;
      return stubFetch({ q: { p: 0.5 } }, { servedModel: "other/model" })(url, init);
    }) as typeof fetch;
    const model = new OpenRouterDecisionModel({ ...base, fetch: capture });
    const result = await model.evaluate({
      state: "s",
      questions: { q: { type: "noul", instructions: "x" } },
      model: "other/model",
    });
    expect(seenModel).toBe("other/model");
    expect(result.model).toBe("other/model");
    await expect(model.evaluate({ state: "s", questions: {} })).rejects.toBeInstanceOf(JevValidationError);
  });

  it("exposes choice/score/probability helpers", async () => {
    const chooser = new OpenRouterDecisionModel({
      ...base,
      fetch: stubFetch({ q: { pick: "a", probabilities: { a: 1 } } }),
    });
    expect((await chooser.choice("s", { instructions: "p", criteria: { a: null } })).choice).toBe("a");
    const scorer = new OpenRouterDecisionModel({
      ...base,
      fetch: stubFetch({ q: { index: 1, probabilities: [0.1, 0.9] } }),
    });
    const scored = await scorer.score("s", { instructions: "r", criteria: ["low", "high"] });
    expect(scored.score).toBeCloseTo(0.9, 5);
    const prober = new OpenRouterDecisionModel({ ...base, fetch: stubFetch({ q: { p: 0.3 } }) });
    expect(await prober.probability("s", { instructions: "u" })).toBe(0.3);
  });
});
