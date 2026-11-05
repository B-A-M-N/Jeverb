#!/usr/bin/env tsx
/**
 * Minimal Jev 1.14 reachability + response-shape probe.
 *
 * Prints (never the key): model list count, one fixed evaluate's answers,
 * latencies. Exits 0 on a successful evaluate, 1 on model error, 2 on
 * transport/auth failure. Key comes only from TYPESAFE_API_KEY.
 */
import { JevDecisionModel } from "../src/jev/client.js";

const apiKey = process.env.TYPESAFE_API_KEY ?? "";
if (apiKey === "") {
  console.error("jev-probe: TYPESAFE_API_KEY is not set");
  process.exit(2);
}

const model = new JevDecisionModel({
  apiKey,
  ...(process.env.TYPESAFE_BASE_URL ? { baseUrl: process.env.TYPESAFE_BASE_URL } : {}),
  model: process.env.JEV_MODEL ?? "jev-1.14.0",
  timeoutMs: 60_000,
});

try {
  const t0 = Date.now();
  const catalog = await model.listModels();
  console.log(JSON.stringify({ models: catalog.models.length, ms: Date.now() - t0 }));
} catch (err) {
  console.error(`jev-probe: listModels failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

try {
  const t0 = Date.now();
  const result = await model.evaluate({
    state: { diff: "+api_key=sk-syntheticfixture0123456789", title: "probe", files: ["config.env"] },
    questions: {
      urgent: { type: "noul", instructions: "How urgent is it to block this change?" },
    },
  });
  console.log(JSON.stringify({ answers: result.answers, ms: Date.now() - t0 }, null, 2));
  process.exit(0);
} catch (err) {
  console.error(`jev-probe: evaluate failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
