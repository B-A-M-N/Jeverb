import { describe, expect, it } from "vitest";
import {
  computeBackoffMs,
  JevDecisionModel,
  parseRetryAfter,
} from "../src/jev/client.js";
import {
  JevAuthError,
  JevConnectionError,
  JevForbiddenError,
  JevOverloadedError,
  JevProtocolError,
  JevProviderHttpError,
  JevQuotaError,
  JevRateLimitError,
  JevTimeoutError,
  JevValidationError,
} from "../src/jev/errors.js";

// ------------------------------------------------------------------- fixtures

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = () => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sequence(handlers: (Response | Handler)[]): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    });

    const next = handlers[index];
    index += 1;
    if (next === undefined) throw new Error(`fake fetch: no response queued for request ${index}`);
    return typeof next === "function" ? await next() : next;
  };

  return { fetch: impl as unknown as typeof fetch, requests };
}

const NOUL_OK = {
  model: "jev-1.13.0",
  answers: { urgent: { type: "noul", noul: 0.92 } },
  usage: { input_tokens: 312, output_tokens: 48 },
};

function client(
  fetchImpl: typeof fetch,
  sleeps: number[] = [],
  overrides: Partial<ConstructorParameters<typeof JevDecisionModel>[0]> = {},
): JevDecisionModel {
  return new JevDecisionModel({
    apiKey: "sk-test-key",
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
}

const URGENT = { urgent: { type: "noul" as const, instructions: "Does this convey urgency?" } };

// ---------------------------------------------------------------------- tests

describe("request shape", () => {
  it("POSTs to /v1/systemone with the bearer token and the documented body", async () => {
    const { fetch: impl, requests } = sequence([jsonResponse(NOUL_OK)]);
    const model = client(impl);

    const result = await model.evaluate({ state: "Help! My payouts are failing.", questions: URGENT });

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe("Bearer sk-test-key");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.body).toEqual({
      state: "Help! My payouts are failing.",
      model: "jev-latest",
      questions: { urgent: { type: "noul", instructions: "Does this convey urgency?" } },
    });

    expect(result.model).toBe("jev-1.13.0");
    expect(result.provider).toBe("typesafe");
    expect(result.questionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.answers.urgent.noul).toBe(0.92);
    expect(result.usage).toEqual({ input_tokens: 312, output_tokens: 48 });
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("honours baseUrl (trailing slashes trimmed) and the per-request model override", async () => {
    const { fetch: impl, requests } = sequence([jsonResponse(NOUL_OK)]);
    const model = client(impl, [], { baseUrl: "http://localhost:8080/", model: "jev-preview" });

    await model.evaluate({ state: "hi", questions: URGENT, model: "jev-1.13.0" });

    expect(requests[0]!.url).toBe("http://localhost:8080/v1/systemone");
    expect((requests[0]!.body as { model: string }).model).toBe("jev-1.13.0");
  });

  it("uses the configured model when the request does not override it", async () => {
    const { fetch: impl, requests } = sequence([jsonResponse(NOUL_OK)]);
    const model = client(impl, [], { model: "jev-1.13.0" });

    await model.evaluate({ state: "hi", questions: URGENT });

    expect((requests[0]!.body as { model: string }).model).toBe("jev-1.13.0");
    expect(model.name).toBe("jev-1.13.0");
  });
});

describe("retries", () => {
  it("treats a 429 as terminal without retrying", async () => {
    // A 429 (including a free-tier warmup throttle) is a terminal outcome,
    // not a retryable one: exactly one request leaves this process.
    const sleeps: number[] = [];
    const { fetch: impl, requests } = sequence([
      jsonResponse({ error: "slow down" }, 429),
      jsonResponse(NOUL_OK),
    ]);

    await expect(
      client(impl, sleeps).evaluate({ state: "hi", questions: URGENT }),
    ).rejects.toBeInstanceOf(JevRateLimitError);
    expect(requests).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it("ignores retry-after on a 429 and still sends exactly one request", async () => {
    // A retry-after hint does not resurrect a refused request.
    const sleeps: number[] = [];
    const { fetch: impl, requests } = sequence([
      jsonResponse({ error: "slow down" }, 429, { "retry-after": "120" }),
      jsonResponse(NOUL_OK),
    ]);

    await expect(
      client(impl, sleeps).evaluate({ state: "hi", questions: URGENT }),
    ).rejects.toBeInstanceOf(JevRateLimitError);
    expect(requests).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it("treats a warmup-stub prose body as terminal without retrying", async () => {
    const sleeps: number[] = [];
    const { fetch: impl, requests } = sequence([
      new Response("model is warming up, please try again", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);

    await expect(
      client(impl, sleeps).evaluate({ state: "hi", questions: URGENT }),
    ).rejects.toBeInstanceOf(JevProtocolError);
    expect(requests).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it("retries a 529 with exponential backoff when no retry-after is sent", async () => {
    const sleeps: number[] = [];
    const { fetch: impl, requests } = sequence([
      jsonResponse({ error: "overloaded" }, 529),
      jsonResponse({ error: "overloaded" }, 529),
      jsonResponse(NOUL_OK),
    ]);

    await client(impl, sleeps).evaluate({ state: "hi", questions: URGENT });

    expect(requests).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    // Full jitter: within [half, all] of 500 * 2^attempt, capped at 10s.
    expect(sleeps[0]).toBeGreaterThanOrEqual(250);
    expect(sleeps[0]).toBeLessThanOrEqual(500);
    expect(sleeps[1]).toBeGreaterThanOrEqual(500);
    expect(sleeps[1]).toBeLessThanOrEqual(1000);
  });

  it("retries 5xx and surfaces JevOverloadedError once retries run out", async () => {
    const sleeps: number[] = [];
    const { fetch: impl, requests } = sequence([
      jsonResponse({ error: "bad gateway" }, 502),
      jsonResponse({ error: "bad gateway" }, 502),
      jsonResponse({ error: "bad gateway" }, 502),
    ]);

    await expect(
      client(impl, sleeps, { maxRetries: 2 }).evaluate({ state: "hi", questions: URGENT }),
    ).rejects.toBeInstanceOf(JevOverloadedError);
    expect(requests).toHaveLength(3);
  });

  it("gives up on 429 immediately and reports the status and body", async () => {
    const sleeps: number[] = [];
    const { fetch: impl, requests } = sequence([
      jsonResponse({ error: "limit" }, 429),
      jsonResponse({ error: "limit" }, 429),
    ]);

    try {
      await client(impl, sleeps, { maxRetries: 1 }).evaluate({ state: "hi", questions: URGENT });
      expect.unreachable("expected a JevRateLimitError");
    } catch (error) {
      expect(error).toBeInstanceOf(JevRateLimitError);
      expect((error as JevRateLimitError).status).toBe(429);
      expect((error as JevRateLimitError).body).toEqual({ error: "limit" });
    }
    expect(requests).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it("retries network failures, then raises JevConnectionError", async () => {
    const sleeps: number[] = [];
    const boom: Handler = () => {
      throw new TypeError("fetch failed");
    };
    const { fetch: impl, requests } = sequence([boom, boom, boom]);

    await expect(
      client(impl, sleeps, { maxRetries: 2 }).evaluate({ state: "hi", questions: URGENT }),
    ).rejects.toBeInstanceOf(JevConnectionError);
    expect(requests).toHaveLength(3);
  });

  it("recovers from a network failure on a later attempt", async () => {
    const sleeps: number[] = [];
    const { fetch: impl } = sequence([
      () => {
        throw new TypeError("fetch failed");
      },
      jsonResponse(NOUL_OK),
    ]);

    const result = await client(impl, sleeps).evaluate({ state: "hi", questions: URGENT });
    expect(result.answers.urgent.noul).toBe(0.92);
  });

  it("never retries 401", async () => {
    const { fetch: impl, requests } = sequence([jsonResponse({ error: "bad key" }, 401), jsonResponse(NOUL_OK)]);

    try {
      await client(impl).evaluate({ state: "hi", questions: URGENT });
      expect.unreachable("expected a JevAuthError");
    } catch (error) {
      expect(error).toBeInstanceOf(JevAuthError);
      expect((error as JevAuthError).status).toBe(401);
      expect((error as Error).message).toContain("TYPESAFE_API_KEY");
    }
    expect(requests).toHaveLength(1);
  });

  it("maps quota-exhausted 403 to JevQuotaError without retrying", async () => {
    const { fetch: impl, requests } = sequence([
      jsonResponse({ failure_category: "quota_exhausted", error: "quota exceeded" }, 403),
      jsonResponse(NOUL_OK),
    ]);

    try {
      await client(impl).evaluate({ state: "hi", questions: URGENT });
      expect.unreachable("expected a JevQuotaError");
    } catch (error) {
      expect(error).toBeInstanceOf(JevQuotaError);
      expect((error as JevQuotaError).status).toBe(403);
    }
    expect(requests).toHaveLength(1);
  });

  it("maps admission 403 to JevForbiddenError without retrying", async () => {
    const { fetch: impl, requests } = sequence([
      jsonResponse({ error: "not entitled" }, 403),
      jsonResponse(NOUL_OK),
    ]);

    try {
      await client(impl).evaluate({ state: "hi", questions: URGENT });
      expect.unreachable("expected a JevForbiddenError");
    } catch (error) {
      expect(error).toBeInstanceOf(JevForbiddenError);
      expect((error as JevForbiddenError).status).toBe(403);
    }
    expect(requests).toHaveLength(1);
  });

  it("maps other 4xx to JevProviderHttpError without retrying", async () => {
    const { fetch: impl, requests } = sequence([jsonResponse({ error: "nope" }, 418), jsonResponse(NOUL_OK)]);

    try {
      await client(impl).evaluate({ state: "hi", questions: URGENT });
      expect.unreachable("expected a JevProviderHttpError");
    } catch (error) {
      expect(error).toBeInstanceOf(JevProviderHttpError);
    }
    expect(requests).toHaveLength(1);
  });

  it("never retries 422 and keeps the offending-field body", async () => {
    const body = { detail: [{ loc: ["questions", "q", "criteria"], msg: "at least two options" }] };
    const { fetch: impl, requests } = sequence([jsonResponse(body, 422), jsonResponse(NOUL_OK)]);

    try {
      await client(impl).evaluate({ state: "hi", questions: URGENT });
      expect.unreachable("expected a JevValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(JevValidationError);
      expect((error as JevValidationError).status).toBe(422);
      expect((error as JevValidationError).body).toEqual(body);
    }
    expect(requests).toHaveLength(1);
  });
});

describe("retry-after parsing", () => {
  it("reads delay-seconds", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("caps an absurd delay at the backoff ceiling", () => {
    expect(parseRetryAfter("3600")).toBe(10_000);
  });

  it("reads an HTTP date relative to now", () => {
    const now = Date.parse("Thu, 01 Jan 2026 00:00:00 GMT");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:04 GMT", now)).toBe(4000);
    expect(parseRetryAfter("Thu, 01 Jan 2025 00:00:00 GMT", now)).toBe(0);
  });

  it("ignores junk", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soonish")).toBeNull();
  });

  it("uses an HTTP-date retry-after as the wait", async () => {
    const sleeps: number[] = [];
    const when = new Date(Date.now() + 3000).toUTCString();
    const { fetch: impl } = sequence([
      jsonResponse({ error: "slow down" }, 503, { "retry-after": when }),
      jsonResponse(NOUL_OK),
    ]);

    await client(impl, sleeps).evaluate({ state: "hi", questions: URGENT });

    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(1500);
    expect(sleeps[0]).toBeLessThanOrEqual(3000);
  });
});

describe("computeBackoffMs", () => {
  it("grows exponentially and stays capped", () => {
    expect(computeBackoffMs(0, () => 1)).toBe(500);
    expect(computeBackoffMs(1, () => 1)).toBe(1000);
    expect(computeBackoffMs(0, () => 0)).toBe(250);
    expect(computeBackoffMs(20, () => 1)).toBe(10_000);
  });
});

describe("deadlines and abort", () => {
  it("raises JevTimeoutError when the request outlives timeoutMs", async () => {
    const hang: Handler = () =>
      new Promise<Response>((_resolve, reject) => {
        // The client's own AbortController fires; mimic fetch's rejection.
        setTimeout(() => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        }, 50);
      });

    const model = client(hang as unknown as typeof fetch, [], { timeoutMs: 10 });
    await expect(model.evaluate({ state: "hi", questions: URGENT })).rejects.toBeInstanceOf(JevTimeoutError);
  });

  it("does not retry past the deadline", async () => {
    const sleeps: number[] = [];
    const slow503: Handler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return jsonResponse({ error: "overloaded" }, 503, { "retry-after": "2" });
    };
    const { fetch: impl, requests } = sequence([slow503, jsonResponse(NOUL_OK)]);

    const model = client(impl, sleeps, { timeoutMs: 20 });
    await expect(model.evaluate({ state: "hi", questions: URGENT })).rejects.toBeInstanceOf(JevTimeoutError);
    expect(requests).toHaveLength(1);
  });

  it("propagates a caller abort", async () => {
    const controller = new AbortController();
    const reason = new Error("caller changed their mind");
    controller.abort(reason);

    const { fetch: impl, requests } = sequence([jsonResponse(NOUL_OK)]);
    await expect(
      client(impl).evaluate({ state: "hi", questions: URGENT, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(requests).toHaveLength(0);
  });

  it("passes an abort signal through to fetch", async () => {
    let seen: AbortSignal | undefined;
    const impl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return jsonResponse(NOUL_OK);
    }) as unknown as typeof fetch;

    await client(impl).evaluate({ state: "hi", questions: URGENT });
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});

describe("response verification", () => {
  it("raises JevProtocolError when a requested id is missing", async () => {
    const { fetch: impl } = sequence([
      jsonResponse({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
    ]);

    try {
      await client(impl).evaluate({ state: "hi", questions: URGENT });
      expect.unreachable("expected a JevProtocolError");
    } catch (error) {
      expect(error).toBeInstanceOf(JevProtocolError);
      expect((error as Error).message).toContain("missing answers for: urgent");
    }
  });

  it("raises JevProtocolError when the answer type does not match the question", async () => {
    const { fetch: impl } = sequence([
      jsonResponse({
        model: "jev-1.13.0",
        answers: { urgent: { type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 1 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ]);

    try {
      await client(impl).evaluate({ state: "hi", questions: URGENT });
      expect.unreachable("expected a JevProtocolError");
    } catch (error) {
      expect(error).toBeInstanceOf(JevProtocolError);
      expect((error as Error).message).toContain("asked noul, got \"choice\"");
    }
  });

  it("raises JevProtocolError when `answers` is absent", async () => {
    const { fetch: impl } = sequence([jsonResponse({ model: "jev-1.13.0" })]);
    await expect(client(impl).evaluate({ state: "hi", questions: URGENT })).rejects.toBeInstanceOf(
      JevProtocolError,
    );
  });

  it("raises JevProtocolError on a non-JSON 200", async () => {
    const { fetch: impl } = sequence([new Response("<html>nope</html>", { status: 200 })]);
    await expect(client(impl).evaluate({ state: "hi", questions: URGENT })).rejects.toBeInstanceOf(
      JevProtocolError,
    );
  });

  it("ignores extra answers the caller did not ask for", async () => {
    const { fetch: impl } = sequence([
      jsonResponse({
        model: "jev-1.13.0",
        answers: { urgent: { type: "noul", noul: 0.1 }, bonus: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ]);

    const result = await client(impl).evaluate({ state: "hi", questions: URGENT });
    expect(result.answers.urgent.noul).toBe(0.1);
  });
});

describe("local guards", () => {
  it("rejects an invalid question map before any request", async () => {
    const { fetch: impl, requests } = sequence([jsonResponse(NOUL_OK)]);
    await expect(client(impl).evaluate({ state: "hi", questions: {} })).rejects.toThrow(
      /at least one question/,
    );
    expect(requests).toHaveLength(0);
  });

  it("rejects an over-budget request before any request", async () => {
    const { fetch: impl, requests } = sequence([jsonResponse(NOUL_OK)]);
    await expect(
      client(impl).evaluate({ state: "x".repeat(400_000), questions: URGENT }),
    ).rejects.toThrow(/context limit/);
    expect(requests).toHaveLength(0);
  });
});

describe("single-question helpers", () => {
  it("probability unwraps the noul", async () => {
    const { fetch: impl, requests } = sequence([
      jsonResponse({
        model: "jev-1.13.0",
        answers: { q: { type: "noul", noul: 0.42 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ]);

    const value = await client(impl).probability("hi", { instructions: "Is it urgent?" });
    expect(value).toBe(0.42);
    expect((requests[0]!.body as { questions: Record<string, { type: string }> }).questions.q!.type).toBe("noul");
  });

  it("choice unwraps the choice answer", async () => {
    const { fetch: impl } = sequence([
      jsonResponse({
        model: "jev-1.13.0",
        answers: { q: { type: "choice", choice: "technical", probabilities: { technical: 0.9, other: 0.1 }, confidence: 0.88 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ]);

    const answer = await client(impl).choice("hi", {
      instructions: "Which team?",
      criteria: { technical: "Bugs", other: "Anything else" },
    });
    expect(answer.choice).toBe("technical");
  });

  it("score unwraps the score answer", async () => {
    const { fetch: impl } = sequence([
      jsonResponse({
        model: "jev-1.13.0",
        answers: { q: { type: "score", score: 1.6, legend: { "0": "Calm", "1": "Angry" }, confidence: 0.7 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ]);

    const answer = await client(impl).score("hi", {
      instructions: "How frustrated?",
      criteria: ["Calm", "Angry"],
    });
    expect(answer.score).toBe(1.6);
  });
});

describe("listModels", () => {
  it("GETs /v1/models with the bearer token", async () => {
    const models = [
      { name: "jev-latest", description: "Most recent stable release", release_date: "2026-09-01" },
      { name: "jev-preview", description: "Most recent release", release_date: "2026-09-01" },
    ];
    const { fetch: impl, requests } = sequence([jsonResponse({ models })]);

    const result = await client(impl).listModels();

    expect(requests[0]!.url).toBe("https://api.typesafe.ai/v1/models");
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.headers.authorization).toBe("Bearer sk-test-key");
    expect(requests[0]!.body).toBeUndefined();
    expect(result.models).toEqual(models);
  });

  it("raises JevProtocolError when `models` is not an array", async () => {
    const { fetch: impl } = sequence([jsonResponse({ models: "nope" })]);
    await expect(client(impl).listModels()).rejects.toBeInstanceOf(JevProtocolError);
  });

  it("maps 401 on the models endpoint too", async () => {
    const { fetch: impl } = sequence([jsonResponse({ error: "bad key" }, 401)]);
    await expect(client(impl).listModels()).rejects.toBeInstanceOf(JevAuthError);
  });
});
