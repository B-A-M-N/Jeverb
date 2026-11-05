import { describe, expect, it } from "vitest";
import { hashQuestions } from "../../src/decision/provenance.js";
import { JevProtocolError } from "../../src/jev/errors.js";
import { OpenRouterJevDecisionModel } from "../../src/jev/openrouter.js";

describe("OpenRouterJevDecisionModel", () => {
  it("sends the original typed request to Decisions API and retains native response metadata", async () => {
    let requestedUrl = "";
    let requestedBody: unknown;
    const questions = {
      closure: {
        type: "choice" as const,
        instructions: "Choose the closure outcome.",
        criteria: { COMPLETE: "Complete", INCOMPLETE: "Incomplete" },
      },
    };
    const model = new OpenRouterJevDecisionModel({
      apiKey: "test-key",
      model: "typesafe/jev-latest",
      maxRetries: 0,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        requestedUrl = String(input);
        requestedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          model: "typesafe/jev-1.14-20261014",
          provider: "TypeSafe",
          id: "gen-dec-test-1",
          answers: {
            closure: {
              type: "choice",
              choice: "INCOMPLETE",
              probabilities: { COMPLETE: 0.2, INCOMPLETE: 0.8 },
              confidence: 0.8,
            },
          },
          usage: { input_tokens: 42, output_tokens: 12, cost: 0.000001764 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });

    const result = await model.evaluate({
      state: { objective: "Finish the migration", evidence: ["migration incomplete"] },
      questions,
    });

    expect(requestedUrl).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(requestedBody).toEqual({
      state: { objective: "Finish the migration", evidence: ["migration incomplete"] },
      model: "~typesafe/jev-latest",
      questions,
    });
    expect(result).toMatchObject({
      model: "typesafe/jev-1.14-20261014",
      correlationId: "gen-dec-test-1",
      provider: "openrouter",
      questionHash: hashQuestions(questions),
      answers: {
        closure: {
          type: "choice",
          choice: "INCOMPLETE",
          probabilities: { COMPLETE: 0.2, INCOMPLETE: 0.8 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 42, output_tokens: 12, cost_usd: 0.000001764 },
    });
  });

  it("requires the Decisions API serving model and provider request id", async () => {
    for (const missing of ["model", "id"] as const) {
      const model = new OpenRouterJevDecisionModel({
        apiKey: "test-key",
        model: "~typesafe/jev-latest",
        maxRetries: 0,
        fetch: (async () => {
          const body: Record<string, unknown> = {
            model: "typesafe/jev-1.14-20261014",
            id: "gen-dec-test-2",
            answers: { q: { type: "noul", noul: 0.7 } },
          };
          delete body[missing];
          return new Response(JSON.stringify(body), { status: 200 });
        }) as typeof fetch,
      });
      await expect(model.evaluate({
        state: "state",
        questions: { q: { type: "noul", instructions: "Does it hold?" } },
      })).rejects.toBeInstanceOf(JevProtocolError);
    }
  });
});
