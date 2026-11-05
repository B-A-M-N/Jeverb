import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const REPO = "/home/bamn/Jeverb";
const HASH = "a".repeat(64);

function dataset(dir: string): string {
  const path = join(dir, "ds.jsonl");
  const cases = [
    { id: "ok-case", state: {}, questions: { q: { type: "choice", instructions: "Pick one.", criteria: { a: "First", b: "Second" } } }, expected: { q: { choice: "a" } } },
    { id: "fail-case", state: {}, questions: { q: { type: "choice", instructions: "Pick one.", criteria: { a: "First", b: "Second" } } }, expected: { q: { choice: "a" } } },
  ];
  writeFileSync(path, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  return path;
}

function receipts(dir: string, failModel: string): string {
  const path = join(dir, "r.jsonl");
  const rows = [
    { case: "ok-case", question: "q", model: "mm", modelVersion: "mm", adapterVersion: "0.6.3", provider: "openrouter", questionHash: HASH, dataset: "d", answer: { type: "choice", choice: "a" }, expected: { choice: "a" }, inRange: true },
    { case: "fail-case", question: "q", model: failModel, modelVersion: "mm", adapterVersion: "0.6.3", provider: "openrouter", questionHash: HASH, dataset: "d", expected: { choice: "a" }, inRange: false, error: "JevError", status: 400 },
    { case: "fail-case", question: "", caseError: true, dataset: "d", model: failModel, modelVersion: "mm", adapterVersion: "0.6.3", provider: "openrouter", questionHash: HASH, error: "JevError", status: 400 },
  ];
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

async function qualify(dir: string, failModel: string): Promise<{ code: number; stderr: string; manifest: string }> {
  const ds = dataset(dir);
  const rc = receipts(dir, failModel);
  const mkOther = (id: string) => [{ id, state: {}, questions: { q: { type: "choice", instructions: "Pick one.", criteria: { a: "First", b: "Second" } } }, expected: { q: { choice: "a" } } }];
  writeFileSync(join(dir, "dev.jsonl"), mkOther("dev-case").map((c) => JSON.stringify(c)).join("\n") + "\n");
  writeFileSync(join(dir, "val.jsonl"), mkOther("val-case").map((c) => JSON.stringify(c)).join("\n") + "\n");
  writeFileSync(join(dir, "s.json"), JSON.stringify({ expectedAnswers: 2, inRange: 1, invalidJudgments: 1 }));
  const out = join(dir, "m.json");
  try {
    await run("npx", ["tsx", join(REPO, "scripts/jev-qualify.ts"), "--summary", join(dir, "s.json"), "--dataset", ds, "--receipts", rc, "--development-dataset", join(dir, "dev.jsonl"), "--validation-dataset", join(dir, "val.jsonl"), "--family", "mission-closure", "--model-version", "mm", "--adapter-version", "0.6.3", "--out", out, "--split", "lockbox", "--decision", "rejected", "--policy-fields", JSON.stringify({ policyVersion: "p", questionHash: HASH, minConfidence: 0.9 })], { cwd: REPO, timeout: 55000 });
    return { code: 0, stderr: "", manifest: out };
  } catch (error) {
    const err = error as { code?: number; stderr?: string };
    return { code: err.code ?? 99, stderr: String(err.stderr ?? error), manifest: out };
  }
}

describe("jev-qualify model binding", () => {
  it("binds one deployment whose failure rows carry the provider-prefixed label", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-qual-bind-"));
    const result = await qualify(dir, "openrouter:mm");
    expect(result.stderr).not.toContain("span 2 models");
    expect(result.code).toBe(0);
    const manifest = JSON.parse((await import("node:fs")).readFileSync(result.manifest, "utf8")) as { model: string };
    expect(manifest.model).toBe("mm");
  });

  it("still refuses two genuinely different models", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-qual-bind-"));
    const result = await qualify(dir, "other-model");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("span 2 models");
  });
});
