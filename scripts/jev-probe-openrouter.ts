#!/usr/bin/env tsx
/**
 * Live smoke probe for Jev's native OpenRouter Decisions API.
 *
 * Key comes only from OPENROUTER_API_KEY (never printed). Model id from
 * JEV_ROUTER_MODEL, default "typesafe/jev-latest". Asks one noul and one
 * choice question, prints answers + latency. Exits 0 on success, 1 on a
 * model/validation error, 2 on transport/auth failure.
 */
import { OpenRouterJevDecisionModel } from "../src/jev/openrouter.js";
import { JevAuthError, JevConnectionError, JevOverloadedError, JevRateLimitError } from "../src/jev/errors.js";

const apiKey = process.env.OPENROUTER_API_KEY ?? "";
if (apiKey === "") {
  console.error("jev-probe-openrouter: OPENROUTER_API_KEY is not set");
  process.exit(2);
}

const model = new OpenRouterJevDecisionModel({
  apiKey,
  model: process.env.JEV_ROUTER_MODEL ?? "typesafe/jev-latest",
  timeoutMs: 90_000,
});

try {
  const t0 = Date.now();
  const result = await model.evaluate({
    state: { diff: "+api_key=[REDACTED]", title: "probe", files: ["config.env"] },
    questions: {
      urgent: { type: "noul", instructions: "How urgent is it to block this change?" },
      lane: {
        type: "choice",
        instructions: "Which review lane fits this change?",
        criteria: { MERGE: "safe to merge", REVIEW: "needs human review" },
      },
    },
  });
  console.log(JSON.stringify({ model: result.model, answers: result.answers, ms: result.latency_ms }, null, 2));
  process.exit(0);
} catch (err) {
  if (
    err instanceof JevAuthError ||
    err instanceof JevConnectionError ||
    err instanceof JevRateLimitError ||
    err instanceof JevOverloadedError
  ) {
    console.error(`jev-probe-openrouter: transport/auth failure: ${err.message}`);
    process.exit(2);
  }
  console.error(`jev-probe-openrouter: model error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
