import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_VERSION } from "../../src/hooks/version.js";
import { MISSION_CLOSURE_QUESTION } from "../../src/mission/closure.js";

const run = promisify(execFile);
const REPO = "/home/bamn/Jeverb";

describe("OpenRouter lockbox identity probe", () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("pins and records the resolved model before scored calls without counting the probe as a case", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-lockbox-openrouter-"));
    const datasetPath = join(dir, "dev.jsonl");
    const scoresPath = join(dir, "scores.jsonl");
    const questions = { closure: MISSION_CLOSURE_QUESTION };
    writeFileSync(datasetPath, `${JSON.stringify({
      id: "case-secret-name",
      state: {},
      questions,
      expected: { closure: { choice: "INCOMPLETE" } },
    })}\n`);

    const seenModels: string[] = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        model?: string;
        questions?: unknown;
        state?: unknown;
      };
      seenModels.push(body.model ?? "");
      expect(request.url).toBe("/api/alpha/decisions");
      expect(body.questions).toEqual(questions);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: `gen-openrouter-${seenModels.length}`,
        model: "typesafe/jev-resolved-v1",
        answers: { closure: {
          type: "choice",
          choice: "INCOMPLETE",
          probabilities: { COMPLETE: 0, INCOMPLETE: 1, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 },
          confidence: 1,
        } },
        usage: { input_tokens: 20, output_tokens: 10, cost: 0.00000084 },
      }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    const { stdout } = await run(
      join(REPO, "node_modules/.bin/tsx"),
      [
        join(REPO, "scripts/jev-lockbox.ts"), datasetPath,
        "--adapter", "openrouter",
        "--model", "typesafe/jev-latest",
        "--adapter-version", HOOK_VERSION,
        "--policy-version", "mission-closure/1",
        "--base-url", `http://127.0.0.1:${address.port}/api/v1`,
        "--out", scoresPath,
      ],
      {
        cwd: REPO,
        timeout: 20_000,
        env: { ...process.env, OPENROUTER_API_KEY: "test-key", CASE_LIMIT: "1" },
      },
    );

    const summary = JSON.parse(stdout) as Record<string, unknown>;
    const probe = summary["identityProbe"] as Record<string, unknown>;
    const rows = readFileSync(scoresPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(seenModels).toEqual(["~typesafe/jev-latest", "~typesafe/jev-latest"]);
    expect(summary).toMatchObject({
      configuredModel: "~typesafe/jev-latest",
      requestedModel: "typesafe/jev-latest",
      modelVersion: "typesafe/jev-resolved-v1",
      casesRun: 1,
      maxLogicalRequests: 2,
      logicalRequestsConsumed: 2,
      stoppedEarly: false,
    });
    expect(probe).toMatchObject({
      caseId: "case-secret-name",
      provider: "openrouter",
      model: "typesafe/jev-resolved-v1",
      requestId: "gen-openrouter-1",
      usage: { input_tokens: 20, output_tokens: 10, cost_usd: 0.00000084 },
      scored: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      caseId: "case-secret-name",
      observedModel: "typesafe/jev-resolved-v1",
      modelRequestId: "gen-openrouter-2",
      modelCall: {
        provider: "openrouter",
        model: "typesafe/jev-resolved-v1",
        requestId: "gen-openrouter-2",
        usage: { input_tokens: 20, output_tokens: 10, cost_usd: 0.00000084 },
      },
    });
  });
});
