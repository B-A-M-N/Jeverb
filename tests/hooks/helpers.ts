/**
 * Test rig for the hooks: a temp data directory and an injectable `Deps`.
 *
 * Handlers take `(input, deps)` precisely so none of this needs a network, a
 * real `~/.claude`, or a Claude Code process.
 */

import { rmSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionModel } from "../../src/decision/types.js";
import { loadHookConfig, type HookConfig } from "../../src/hooks/config.js";
import { testStore } from "../helpers/control-state.js";
import { testSwitchPath } from "../helpers/control-state.js";
import type { Deps } from "../../src/hooks/types.js";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "jev-hooks-"));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface DepsOptions {
  model?: DecisionModel | null;
  config?: Partial<HookConfig>;
  now?: number;
  dir?: string;
}

/** A config with no ambient environment leaking in. */
export function testConfig(dir: string, overrides: Partial<HookConfig> = {}): HookConfig {
  const base = loadHookConfig({ CLAUDE_PLUGIN_DATA: dir, TYPESAFE_API_KEY: "sk-test-key" });
  return { ...base, masterSwitchPath: testSwitchPath(dir), ...overrides };
}

export function makeDeps(dir: string, options: DepsOptions = {}): Deps {
  const config = testConfig(dir, options.config ?? {});
  return {
    model: options.model ?? null,
    config,
    store: testStore(config.dataDir),
    now: () => options.now ?? 1_700_000_000_000,
  };
}
