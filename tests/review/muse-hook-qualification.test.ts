import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve(import.meta.dirname, "../..");

interface HarnessFixture {
  root: string;
  bin: string;
  temp: string;
  inspect: string;
}

function makeFixture(parent: string): HarnessFixture {
  const root = join(parent, "repo");
  const candidate = join(root, "dist/muse-plugins/jeverb");
  const cache = join(parent, "installed-cache");
  const bin = join(parent, "bin");
  const temp = join(parent, "temp");
  mkdirSync(join(root, "harness"), { recursive: true });
  mkdirSync(join(root, ".muse-plugin"), { recursive: true });
  mkdirSync(join(root, "plugin/dist"), { recursive: true });
  mkdirSync(join(candidate, ".muse-plugin"), { recursive: true });
  mkdirSync(join(candidate, "plugin/dist"), { recursive: true });
  mkdirSync(join(cache, "plugin/dist"), { recursive: true });
  mkdirSync(join(root, "tests/fixtures/muse"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(temp, { recursive: true });

  const manifest = JSON.stringify({ capabilities: { hooks: [{ id: "fixture-hook" }] } });
  writeFileSync(join(root, ".muse-plugin/plugin.json"), manifest);
  writeFileSync(join(candidate, ".muse-plugin/plugin.json"), manifest);
  for (const bundle of ["hook.mjs", "mcp.mjs"]) {
    writeFileSync(join(candidate, "plugin/dist", bundle), `candidate ${bundle}\n`);
    writeFileSync(join(cache, "plugin/dist", bundle), `candidate ${bundle}\n`);
    writeFileSync(join(root, "plugin/dist", bundle), `different workspace ${bundle}\n`);
  }
  writeFileSync(join(root, "tests/fixtures/muse/session-start.json"), JSON.stringify({ stdin: { session_id: "seed" } }));
  for (const fixture of ["user-prompt-submit", "pretool-benign", "pretool-destructive"]) {
    writeFileSync(join(root, `tests/fixtures/muse/${fixture}.json`), JSON.stringify({ stdin: { session_id: "seed" } }));
  }
  writeFileSync(join(root, "harness/muse-hook-qualification.sh"),
    readFileSync(join(SOURCE_ROOT, "harness/muse-hook-qualification.sh")), { mode: 0o755 });

  const inspect = join(parent, "inspect.json");
  writeFileSync(inspect, JSON.stringify({
    plugin: { capabilities: { hooks: [{ id: "fixture-hook" }] } },
    record: { cache_path: cache },
  }));
  const muse = join(bin, "muse");
  writeFileSync(muse, [
    "#!/bin/sh",
    'if [ "$1" = plugins ] && [ "$2" = inspect ]; then cat "$MUSE_TEST_INSPECT_JSON"; exit $?; fi',
    'if [ "$1" = plugins ] && [ "$2" = hook ] && [ "$3" = test ]; then',
    '  status="${MUSE_TEST_HOOK_EXIT:-0}"; if [ "$status" != 0 ]; then exit "$status"; fi',
    '  printf \'{"terminals":[{"status":"%s","exit_code":0}]}\\n\' "${MUSE_TEST_HOOK_STATUS:-completed}"; exit 0',
    "fi",
    "exit 90",
    "",
  ].join("\n"), { mode: 0o755 });
  chmodSync(muse, 0o755);
  return { root, bin, temp, inspect };
}

function runHarness(fixture: HarnessFixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [join(fixture.root, "harness/muse-hook-qualification.sh"), ...args], {
    cwd: fixture.root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      MUSE_NO_AUTO_UPDATE: "1",
      MUSE_TEST_INSPECT_JSON: fixture.inspect,
      MUSE_TEST_HOOK_EXIT: "0",
      MUSE_TEST_HOOK_STATUS: "completed",
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      TMPDIR: fixture.temp,
      ...extraEnv,
    },
  });
}

describe("Muse installed-package qualification harness", () => {
  it("checks installed bundle hashes against the built candidate package", () => {
    const parent = mkdtempSync(join(tmpdir(), "jeverb-muse-qualification-"));
    const fixture = makeFixture(parent);

    const result = runHarness(fixture, ["--check-only"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Muse installed candidate matches built candidate");
  });

  it("removes its temporary fixture when installed hook execution fails", () => {
    const parent = mkdtempSync(join(tmpdir(), "jeverb-muse-qualification-cleanup-"));
    const fixture = makeFixture(parent);

    const result = runHarness(fixture, [], { MUSE_TEST_HOOK_EXIT: "42" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Muse hook fixture invocation failed: hook=jev-session-start fixture=session-start.json exit_code=42");
    expect(readdirSync(fixture.temp)).toEqual([]);
  });

  it("reports the actual installed hook status when enforcement is inactive", () => {
    const parent = mkdtempSync(join(tmpdir(), "jeverb-muse-qualification-mismatch-"));
    const fixture = makeFixture(parent);

    const result = runHarness(fixture, [], { MUSE_TEST_HOOK_STATUS: "completed" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Muse hook fixture mismatch: hook=jev-pre-tool fixture=pretool-destructive.json expected=blocked/0 actual=completed/0");
    expect(readdirSync(fixture.temp)).toEqual([]);
  });
});
