/**
 * Hook configuration. It never throws: a typo in a plugin option must not
 * break someone's session.
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOOK_DEFAULTS,
  installIdFromScriptPath,
  loadHookConfig,
  museInstallIdFromScriptPath,
  providerIdentityOf,
  resolveCredentialsPath,
  resolveDataDir,
  resolveMuseDataDir,
} from "../../src/hooks/config.js";
import { DEFAULT_PORT } from "../../src/hooks/daemon/protocol.js";
import { hookConfigFrom, readSessionConfig, sessionConfigOf } from "../../src/hooks/daemon/registry.js";
import { hashQuestions } from "../../src/decision/provenance.js";
import { MISSION_CLOSURE_QUESTION } from "../../src/mission/closure.js";

describe("loadHookConfig", () => {
  it("resolves Muse control state only from Muse or an explicit Jeverb data path", () => {
    expect(resolveMuseDataDir({ MUSE_PLUGIN_DATA_DIR: "/muse/plugin-data", CLAUDE_PLUGIN_DATA: "/claude/data" })).toBe("/muse/plugin-data");
    expect(resolveMuseDataDir({ JEV_HOOKS_DATA_DIR: "/operator/jev", MUSE_PLUGIN_DATA_DIR: "/muse/plugin-data" })).toBe("/muse/plugin-data");
    expect(resolveMuseDataDir({ JEV_MUSE_DATA_DIR: "/operator/muse-jev", CLAUDE_PLUGIN_DATA: "/claude/data" })).toBe("/operator/muse-jev");
    expect(() => resolveMuseDataDir({ HOME: "/home/test" })).toThrow("Muse plugin data directory is ambiguous");
    expect(() => resolveMuseDataDir({ XDG_DATA_HOME: "/xdg/test", JEV_HOOKS_DATA_DIR: "/generic/jev" })).toThrow(
      "Muse plugin data directory is ambiguous",
    );
  });

  it("uses the documented defaults with an empty environment", () => {
    const config = loadHookConfig({});
    expect(config.apiKey).toBeNull();
    expect(config.gate).toBe("advisory");
    expect(config.askOnTrip).toBe(false);
    expect(config.stopCheck).toBe(true);
    expect(config.screenResults).toBe(true);
    expect(config.routePrompts).toBe(false);
    expect(config.autoThreshold).toBe(0.85);
    expect(config.timeoutMs).toBe(HOOK_DEFAULTS.timeoutMs);
    expect(config.maxRetries).toBe(0);
    expect(config.warnings).toEqual([]);
  });

  /**
   * 0.5.0 pins the model. The hooks' thresholds are tuned against one model's
   * calibration and `/jev:calibrate` replays a log captured from it, so an
   * alias that moves under both is not a default anyone chose.
   */
  it("pins the model version rather than following the alias", () => {
    expect(HOOK_DEFAULTS.model).toBe("jev-1.14.0");
    expect(loadHookConfig({}).model).toBe("jev-1.14.0");
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_MODEL: "jev-latest" }).model).toBe("jev-latest");
    expect(loadHookConfig({ JEV_MODEL: "jev-1.12.0" }).model).toBe("jev-1.12.0");
  });

  it("prefers a plugin option over the env fallback", () => {
    const config = loadHookConfig({
      CLAUDE_PLUGIN_OPTION_API_KEY: "sk-from-plugin",
      TYPESAFE_API_KEY: "sk-from-env",
    });
    expect(config.apiKey).toBe("sk-from-plugin");
  });

  it("falls back to the env var when no plugin option is set", () => {
    expect(loadHookConfig({ TYPESAFE_API_KEY: "sk-from-env" }).apiKey).toBe("sk-from-env");
  });

  it("treats an empty option as unset", () => {
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_API_KEY: "   ", TYPESAFE_API_KEY: "sk-env" }).apiKey).toBe("sk-env");
  });

  it("reads every gate level", () => {
    for (const level of ["off", "advisory", "strict"]) {
      expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE: level }).gate).toBe(level);
    }
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE: "STRICT" }).gate).toBe("strict");
    expect(loadHookConfig({ JEV_GATE: "off" }).gate).toBe("off");
  });

  it("records a warning and keeps going on a bad gate level", () => {
    const config = loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE: "maybe" });
    expect(config.gate).toBe("advisory");
    expect(config.warnings.join(" ")).toContain("gate=");
  });

  it("reads ask_on_trip, the one setting that can prompt a human", () => {
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_ASK_ON_TRIP: "true" }).askOnTrip).toBe(true);
    expect(loadHookConfig({ JEV_ASK_ON_TRIP: "1" }).askOnTrip).toBe(true);
    expect(loadHookConfig({}).askOnTrip).toBe(false);
  });

  /**
   * 0.2.x installs carry `gate_mode`. Ignoring it would silently change the
   * gate under someone who had turned it off, so it is read, mapped, and
   * reported — the warning is what `/jev:status` prints.
   */
  describe("migration from gate_mode", () => {
    it("maps every old value and says so", () => {
      for (const [old, mapped] of [
        ["off", "off"],
        ["standard", "advisory"],
        ["strict", "strict"],
      ] as const) {
        const config = loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE_MODE: old });
        expect(config.gate, old).toBe(mapped);
        expect(config.warnings.join(" ")).toContain(`gate_mode is deprecated; read as gate=${mapped}`);
      }
    });

    it("reads the JEV_ env form too", () => {
      expect(loadHookConfig({ JEV_GATE_MODE: "off" }).gate).toBe("off");
    });

    it("prefers an explicit gate and then says nothing about the old setting", () => {
      const config = loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE: "off", CLAUDE_PLUGIN_OPTION_GATE_MODE: "strict" });
      expect(config.gate).toBe("off");
      expect(config.warnings.join(" ")).not.toContain("gate_mode");
    });

    it("warns about an unreadable old value instead of guessing", () => {
      const config = loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE_MODE: "maybe" });
      expect(config.gate).toBe("advisory");
      expect(config.warnings.join(" ")).toContain("gate_mode=\"maybe\"");
    });

    it("says plainly that auto_mode no longer does anything", () => {
      const config = loadHookConfig({ CLAUDE_PLUGIN_OPTION_AUTO_MODE: "ask" });
      expect(config.warnings.join(" ")).toContain("auto_mode is no longer used");
      expect(config.warnings.join(" ")).toContain("never prompts");
    });

    it("stays quiet when neither legacy setting is present", () => {
      expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE: "advisory" }).warnings).toEqual([]);
    });
  });

  it("reads booleans in every documented spelling", () => {
    for (const value of ["true", "1", "yes", "on", "TRUE"]) {
      expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_ROUTE_PROMPTS: value }).routePrompts, value).toBe(true);
    }
    for (const value of ["false", "0", "no", "off"]) {
      expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_STOP_CHECK: value }).stopCheck, value).toBe(false);
    }
  });

  it("warns on a boolean it cannot read", () => {
    const config = loadHookConfig({ CLAUDE_PLUGIN_OPTION_STOP_CHECK: "sometimes" });
    expect(config.stopCheck).toBe(true);
    expect(config.warnings.join(" ")).toContain("stop_check");
  });

  it("reads a threshold and rejects one out of range", () => {
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_AUTO_THRESHOLD: "0.9" }).autoThreshold).toBe(0.9);
    const bad = loadHookConfig({ CLAUDE_PLUGIN_OPTION_AUTO_THRESHOLD: "7" });
    expect(bad.autoThreshold).toBe(0.85);
    expect(bad.warnings.join(" ")).toContain("auto_threshold");
  });

  it("rejects threshold endpoints and keeps commit review advisory unless explicitly enabled", () => {
    for (const value of ["0", "1"]) {
      const config = loadHookConfig({ JEV_AUTO_THRESHOLD: value });
      expect(config.autoThreshold).toBe(HOOK_DEFAULTS.autoThreshold);
      expect(config.warnings.join(" ")).toContain("auto_threshold");
    }
    expect(loadHookConfig({}).commitEnforcement).toBe("advisory");
    expect(loadHookConfig({ JEV_COMMIT_ENFORCEMENT: "mandatory" }).commitEnforcement).toBe("mandatory");
    const invalid = loadHookConfig({ JEV_COMMIT_ENFORCEMENT: "unknown" });
    expect(invalid.commitEnforcement).toBe("advisory");
    expect(invalid.warnings.join(" ")).toContain("commit_enforcement");
  });

  /**
   * A Choice's `confidence` is a peakedness statistic, not a probability of a
   * binary event, so it has its own bar rather than sharing `auto_threshold`.
   */
  it("reads confidence_threshold, separately from the certainty threshold", () => {
    expect(loadHookConfig({}).confidenceThreshold).toBe(0.85);
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_CONFIDENCE_THRESHOLD: "0.6" }).confidenceThreshold).toBe(0.6);
    expect(loadHookConfig({ JEV_CONFIDENCE_THRESHOLD: "0.95" }).confidenceThreshold).toBe(0.95);
    // Changing one leaves the other exactly where it was.
    const tuned = loadHookConfig({ CLAUDE_PLUGIN_OPTION_AUTO_THRESHOLD: "0.7" });
    expect(tuned.autoThreshold).toBe(0.7);
    expect(tuned.confidenceThreshold).toBe(0.85);
  });

  it("warns and falls back on a confidence_threshold outside its range", () => {
    const bad = loadHookConfig({ JEV_CONFIDENCE_THRESHOLD: "0.2" });
    expect(bad.confidenceThreshold).toBe(0.85);
    expect(bad.warnings.join(" ")).toContain("confidence_threshold");
  });

  it("never lets the review threshold exceed the auto threshold", () => {
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_AUTO_THRESHOLD: "0.5" }).reviewThreshold).toBeLessThanOrEqual(0.5);
  });

  it("honours JEV_HOOKS_DISABLE", () => {
    expect(loadHookConfig({ JEV_HOOKS_DISABLE: "1" }).disabled).toBe(true);
    expect(loadHookConfig({}).disabled).toBe(false);
  });

  it("strips a trailing slash from the base url", () => {
    expect(loadHookConfig({ TYPESAFE_BASE_URL: "https://x.example/" }).baseUrl).toBe("https://x.example");
  });
});

describe("resolveDataDir", () => {
  it("uses CLAUDE_PLUGIN_DATA when Claude Code provides it", () => {
    expect(resolveDataDir({ CLAUDE_PLUGIN_DATA: "/tmp/data" })).toBe("/tmp/data");
  });

  it("falls back to the documented location under the home directory", () => {
    expect(resolveDataDir({ HOME: "/home/dev" })).toBe(join("/home/dev", ".claude", "plugins", "data", "jev"));
    expect(resolveDataDir({})).toBe(join(homedir(), ".claude", "plugins", "data", "jev"));
  });

  // A /jev:* command runs through the Bash tool, where CLAUDE_PLUGIN_DATA is not
  // exported. It has to land on the directory the hooks write to.
  it("derives the install id from an installed plugin's script path", () => {
    const script = "/home/dev/.claude/plugins/cache/brainwires-jev/jev/0.1.0/dist/hook.mjs";
    expect(resolveDataDir({ HOME: "/home/dev" }, script)).toBe(
      join("/home/dev", ".claude", "plugins", "data", "jev-brainwires-jev"),
    );
    expect(installIdFromScriptPath("C:\\Users\\dev\\.claude\\plugins\\cache\\my.market\\jev\\1.0.0\\dist\\hook.mjs")).toBe(
      "jev-my-market",
    );
  });

  it("resolves native Muse MCP bundle paths to the matching plugin data directory", () => {
    const digest = "b".repeat(64);
    const script = `/home/dev/.local/share/muse/plugins/cache/local/jeverb/${digest}/package/plugin/dist/mcp.mjs`;
    expect(museInstallIdFromScriptPath(script)).toBe("jeverb");
    expect(resolveDataDir({ HOME: "/home/dev" }, script)).toBe(
      "/home/dev/.local/share/muse/plugins/data/jeverb",
    );
    expect(resolveDataDir({ XDG_DATA_HOME: "/srv/user-data" }, script)).toBe(
      "/srv/user-data/muse/plugins/data/jeverb",
    );
    expect(museInstallIdFromScriptPath("/tmp/plugins/cache/local/jeverb/not-a-digest/package/plugin/dist/mcp.mjs")).toBeUndefined();
  });

  it("prefers Muse's data dir, then Claude's, with the explicit override first", () => {
    expect(resolveDataDir({ MUSE_PLUGIN_DATA_DIR: "/tmp/muse-data" })).toBe("/tmp/muse-data");
    expect(
      resolveDataDir({ MUSE_PLUGIN_DATA_DIR: "/tmp/muse-data", CLAUDE_PLUGIN_DATA: "/tmp/claude-data" }),
    ).toBe("/tmp/muse-data");
    expect(
      resolveDataDir({
        JEV_HOOKS_DATA_DIR: "/tmp/explicit",
        MUSE_PLUGIN_DATA_DIR: "/tmp/muse-data",
        CLAUDE_PLUGIN_DATA: "/tmp/claude-data",
      }),
    ).toBe("/tmp/explicit");
  });

  it("resolves the installed Muse plugin data directory for shell-invoked controls", () => {
    const home = mkdtempSync(join(tmpdir(), "jev-muse-home-"));
    const dataHome = join(home, ".local", "share");
    const installed = join(dataHome, "muse", "plugins", "data", "jeverb");
    mkdirSync(installed, { recursive: true });
    try {
      expect(resolveDataDir({ HOME: home }, "/usr/bin/jev-control")).toBe(installed);
      expect(resolveDataDir({ HOME: home, XDG_DATA_HOME: dataHome }, "/usr/bin/jev-control")).toBe(installed);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prefers CLAUDE_PLUGIN_DATA over the derived id, and ignores paths outside the plugin cache", () => {
    const script = "/home/dev/.claude/plugins/cache/brainwires-jev/jev/0.1.0/dist/hook.mjs";
    expect(resolveDataDir({ CLAUDE_PLUGIN_DATA: "/tmp/data" }, script)).toBe("/tmp/data");
    expect(installIdFromScriptPath("/repo/jevwire/plugin/dist/hook.mjs")).toBeUndefined();
    expect(installIdFromScriptPath("/x/cache/a/b/1/dist/hook.mjs")).toBeUndefined();
    expect(installIdFromScriptPath(undefined)).toBeUndefined();
  });
});

describe("daemon settings", () => {
  it("defaults to the port the plugin manifest hard-codes into its hook URLs", () => {
    // `hooks.json` can interpolate environment variables into headers only, so
    // the URL carries a literal and these two have to agree.
    expect(loadHookConfig({}).daemonPort).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(10522);
  });

  it("defaults to a thirty minute idle window", () => {
    expect(loadHookConfig({}).daemonIdleMs).toBe(30 * 60 * 1000);
  });

  it("reads the port from either name", () => {
    expect(loadHookConfig({ JEV_DAEMON_PORT: "10599" }).daemonPort).toBe(10599);
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_DAEMON_PORT: "10598" }).daemonPort).toBe(10598);
  });

  it("allows port 0, which is how the tests stay off the real one", () => {
    const config = loadHookConfig({ JEV_DAEMON_PORT: "0" });
    expect(config.daemonPort).toBe(0);
    expect(config.warnings).toEqual([]);
  });

  it("warns and falls back rather than throwing on a nonsense port", () => {
    for (const bad of ["-1", "70000", "http", ""]) {
      const config = loadHookConfig({ JEV_DAEMON_PORT: bad });
      expect(config.daemonPort, bad).toBe(DEFAULT_PORT);
    }
    expect(loadHookConfig({ JEV_DAEMON_PORT: "70000" }).warnings.join(" ")).toContain("daemon_port");
  });

  it("clamps the idle window to something a daemon can actually use", () => {
    expect(loadHookConfig({ JEV_DAEMON_IDLE_MS: "60000" }).daemonIdleMs).toBe(60_000);
    expect(loadHookConfig({ JEV_DAEMON_IDLE_MS: "1" }).daemonIdleMs).toBe(30 * 60 * 1000);
    expect(loadHookConfig({ JEV_DAEMON_IDLE_MS: "999999999" }).daemonIdleMs).toBe(30 * 60 * 1000);
  });
});

describe("the session config snapshot", () => {
  it("carries every setting the daemon needs and no secret", () => {
    const snapshot = sessionConfigOf(loadHookConfig({ TYPESAFE_API_KEY: "sk-secret", JEV_GATE: "strict" }));
    expect(snapshot.gate).toBe("strict");
    expect(JSON.stringify(snapshot)).not.toContain("sk-secret");
    expect(snapshot).not.toHaveProperty("apiKey");
    expect(snapshot).not.toHaveProperty("dataDir");
    expect(snapshot).not.toHaveProperty("disabled");
    expect(snapshot).not.toHaveProperty("warnings");
  });

  it("round-trips through validation unchanged", () => {
    const snapshot = sessionConfigOf(loadHookConfig({ JEV_GATE: "strict", JEV_ROUTE_PROMPTS: "1" }));
    expect(readSessionConfig(snapshot, sessionConfigOf(loadHookConfig({})))).toEqual(snapshot);
  });

  it("replaces every unusable field with the daemon's own value", () => {
    const own = sessionConfigOf(loadHookConfig({}));
    const read = readSessionConfig(
      {
        gate: "wide-open",
        autoThreshold: 42,
        reviewThreshold: -1,
        timeoutMs: 0,
        stopCheck: "yes",
        model: "",
        daemonPort: 999_999,
      },
      own,
    );
    expect(read).toEqual(own);
  });

  it("never lets a snapshot raise the review threshold above the auto one", () => {
    const own = sessionConfigOf(loadHookConfig({}));
    const read = readSessionConfig({ autoThreshold: 0.7, reviewThreshold: 0.95 }, own);
    expect(read?.autoThreshold).toBe(0.7);
    expect(read?.reviewThreshold).toBe(0.7);
  });

  it("rejects a snapshot that is not an object at all", () => {
    const own = sessionConfigOf(loadHookConfig({}));
    for (const bad of [null, undefined, 42, "gate=off", [1, 2]]) {
      expect(readSessionConfig(bad, own), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("credentials file", () => {
  function writeCreds(payload: unknown, mode: number): string {
    const path = join(mkdtempSync(join(tmpdir(), "jev-creds-")), "credentials");
    writeFileSync(path, typeof payload === "string" ? payload : JSON.stringify(payload));
    chmodSync(path, mode);
    return path;
  }

  function missingPath(): string {
    return join(mkdtempSync(join(tmpdir(), "jev-creds-")), "no-such-file");
  }

  it("loads the key from JEV_CREDENTIALS_FILE when the env has none", () => {
    const config = loadHookConfig({ JEV_CREDENTIALS_FILE: writeCreds({ TYPESAFE_API_KEY: "sk-file" }, 0o600) });
    expect(config.apiKey).toBe("sk-file");
    expect(config.warnings).toEqual([]);
  });

  it("loads the OpenRouter key from the file for an OpenRouter backend", () => {
    const config = loadHookConfig({
      JEV_BACKEND: "openrouter",
      JEV_CREDENTIALS_FILE: writeCreds({ OPENROUTER_API_KEY: "sk-or-file" }, 0o600),
    });
    expect(config.apiKey).toBe("sk-or-file");
    expect(config.warnings).toEqual([]);
  });

  it("selects the local Jev Gateway slot without reading upstream credentials", () => {
    const config = loadHookConfig({
      JEV_BACKEND: "jev-gateway",
      OPENROUTER_API_KEY: "must-not-be-forwarded",
      TYPESAFE_API_KEY: "also-must-not-be-forwarded",
    });
    expect(config.backend).toBe("jev-gateway");
    expect(config.baseUrl).toBe("http://127.0.0.1:18769/jev");
    expect(config.model).toBe("typesafe/jev-1.14");
    expect(config.apiKey).toBeNull();
    expect(config.warnings).toEqual([]);
    expect(providerIdentityOf(config).provider).toBe("jev-gateway");
  });

  it("ignores a group/world-readable file and warns about the mode", () => {
    const path = writeCreds({ TYPESAFE_API_KEY: "sk-file" }, 0o644);
    const config = loadHookConfig({ JEV_CREDENTIALS_FILE: path });
    expect(config.apiKey).toBeNull();
    const text = config.warnings.join(" ");
    expect(text).toContain("0600");
    expect(text).not.toContain("sk-file");
  });

  it("lets the env and the plugin option win over the file", () => {
    const path = writeCreds({ TYPESAFE_API_KEY: "sk-file" }, 0o600);
    expect(loadHookConfig({ TYPESAFE_API_KEY: "sk-env", JEV_CREDENTIALS_FILE: path }).apiKey).toBe("sk-env");
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_API_KEY: "sk-opt", JEV_CREDENTIALS_FILE: path }).apiKey).toBe(
      "sk-opt",
    );
  });

  it("resolves the default path under ~/.config/jeverb", () => {
    expect(resolveCredentialsPath({ HOME: "/home/dev" })).toBe(
      join("/home/dev", ".config", "jeverb", "credentials"),
    );
    expect(resolveCredentialsPath({ JEV_CREDENTIALS_FILE: "/tmp/custom", HOME: "/home/dev" })).toBe("/tmp/custom");
  });

  it("reads the install-scoped plant from the resolved data dir", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jev-datadir-"));
    writeFileSync(join(dataDir, "credentials"), JSON.stringify({ OPENROUTER_API_KEY: "planted-or-credential" }));
    chmodSync(join(dataDir, "credentials"), 0o600);
    // No HOME file, no env key: the plant in the data dir (reachable even
    // when the hook transport sanitizes HOME) supplies the credential.
    const config = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir, JEV_BACKEND: "openrouter" });
    expect(config.apiKey).toBe("planted-or-credential");
  });

  it("reads backend/model/base_url from the data-dir config file", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jev-datadir-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ backend: "openrouter", base_url: "https://example.invalid/v1/", model: "example/model" }),
    );
    // No backend env: the install-scoped config file selects the backend and
    // its defaults, so the hook is Jev-active without operator env.
    const config = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir });
    expect(config.baseUrl).toBe("https://example.invalid/v1");
    expect(config.model).toBe("example/model");
  });

  it("lets env and plugin options win over the data-dir config file", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jev-datadir-"));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ backend: "openrouter", model: "file/model" }));
    const fromEnv = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir, JEV_MODEL: "env/model" });
    expect(fromEnv.model).toBe("env/model");
    expect(fromEnv.baseUrl).toContain("openrouter");
    // Explicit native backend env switches the backend (and its base-url
    // default); the model setting itself is backend-independent.
    const native = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir, JEV_BACKEND: "typesafe" });
    expect(native.baseUrl).toBe(HOOK_DEFAULTS.baseUrl);
    expect(native.model).toBe("file/model");
  });

  it("ignores a malformed data-dir config file with a warning", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jev-datadir-"));
    writeFileSync(join(dataDir, "config.json"), "{not json");
    const config = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir });
    expect(config.model).toBe(HOOK_DEFAULTS.model);
    expect(config.warnings.some((w) => w.includes("config"))).toBe(true);
  });

  it("takes evidence retention knobs from the data-dir config file, clamped like env", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jev-datadir-"));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ evidence_retention_days: 30, evidence_max_records: 50_000 }));
    const config = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir });
    expect(config.evidenceRetentionDays).toBe(30);
    expect(config.evidenceMaxRecords).toBe(50_000);
    expect(loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir, JEV_EVIDENCE_RETENTION_DAYS: "7" }).evidenceRetentionDays).toBe(7);
    // Out-of-range file values fall back to the defaults with a warning.
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ evidence_retention_days: 0, evidence_max_records: 5 }));
    const clamped = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir });
    expect(clamped.evidenceRetentionDays).toBe(HOOK_DEFAULTS.evidenceRetentionDays);
    expect(clamped.evidenceMaxRecords).toBe(HOOK_DEFAULTS.evidenceMaxRecords);
    expect(clamped.warnings.some((w) => w.includes("evidence_retention_days"))).toBe(true);
    expect(clamped.warnings.some((w) => w.includes("evidence_max_records"))).toBe(true);
  });

  it("takes timeout_ms from the data-dir config file, clamped like env", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jev-datadir-"));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ timeout_ms: 8000 }));
    expect(loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir }).timeoutMs).toBe(8000);
    // Env wins over the file.
    expect(loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir, JEV_HOOK_TIMEOUT_MS: "2000" }).timeoutMs).toBe(2000);
    // Out-of-range file values fall back to the default with a warning.
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ timeout_ms: 99999 }));
    const config = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir });
    expect(config.timeoutMs).toBe(HOOK_DEFAULTS.timeoutMs);
    expect(config.warnings.some((w) => w.includes("timeout_ms"))).toBe(true);
  });

  it("reads relay approval from env or the data-dir file, defaulting to deny", () => {
    expect(loadHookConfig({}).allowCustomRelay).toBe(false);
    const dataDir = mkdtempSync(join(tmpdir(), "jev-relay-"));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ allow_custom_relay: true }));
    expect(loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir }).allowCustomRelay).toBe(true);
    // Explicit env wins over the file in both directions.
    expect(
      loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir, JEV_ALLOW_CUSTOM_RELAY: "false" }).allowCustomRelay,
    ).toBe(false);
    expect(loadHookConfig({ JEV_ALLOW_CUSTOM_RELAY: "true" }).allowCustomRelay).toBe(true);
    // Non-boolean file values are ignored with a warning, never approved.
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ allow_custom_relay: "yes" }));
    const config = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir });
    expect(config.allowCustomRelay).toBe(false);
    expect(config.warnings.some((w) => w.includes("allow_custom_relay"))).toBe(true);
  });

  it("loads policy from the install-scoped config used by sanitized Muse hooks", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jev-policy-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({
        gate: "strict",
        route_prompts: true,
        screen_results: false,
        lint: "tripwire",
        lint_conventions: false,
        verify_claims: false,
        auto_threshold: 0.9,
        review_threshold: 0.95,
        confidence_threshold: 0.92,
      }),
    );

    const config = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir });
    expect(config.gate).toBe("strict");
    expect(config.routePrompts).toBe(true);
    expect(config.screenResults).toBe(false);
    expect(config.lint).toBe("tripwire");
    expect(config.lintConventions).toBe(false);
    expect(config.verifyClaims).toBe(false);
    expect(config.autoThreshold).toBe(0.9);
    // Review is clamped to the automatic threshold even when the file is not.
    expect(config.reviewThreshold).toBe(0.9);
    expect(config.confidenceThreshold).toBe(0.92);

    // Explicit operator env still wins over the install-scoped values.
    const overridden = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir, JEV_GATE: "off", JEV_ROUTE_PROMPTS: "false" });
    expect(overridden.gate).toBe("off");
    expect(overridden.routePrompts).toBe(false);
  });

  it("keeps model/question calibration claims advisory until a qualification manifest verifies", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jev-mission-calibration-"));
    const questionHash = hashQuestions({ closure: MISSION_CLOSURE_QUESTION });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      mission_closure: {
        calibrated: true,
        min_confidence: 0.91,
        model_version: "jev-1.14.0",
        question_hash: questionHash,
        calibration_version: "jev-1.14.0/closure-test-1",
      },
    }));
    const config = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir });
    expect(config.missionClosurePolicy).toMatchObject({
      calibrated: false,
      backend: "typesafe",
      model: "jev-1.14.0",
      modelVersion: "jev-1.14.0",
      minConfidence: 0.91,
      questionHash,
    });
    expect(config.warnings.some((warning) => warning.includes("no qualification manifest"))).toBe(true);

    const stale = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir, JEV_MODEL: "jev-latest" });
    expect(stale.missionClosurePolicy.calibrated).toBe(false);
  });

  it("keeps gateway version claims advisory until a qualification manifest verifies", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jev-gateway-calibration-"));
    const questionHash = hashQuestions({ closure: MISSION_CLOSURE_QUESTION });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      backend: "jev-gateway",
      mission_closure: {
        calibrated: true,
        min_confidence: 0.91,
        model_version: "typesafe/jev-1.14-20261014",
        question_hash: questionHash,
        calibration_version: "jev-1.14/gateway-closure-test-1",
      },
    }));
    const config = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir });
    expect(config.missionClosurePolicy).toMatchObject({
      calibrated: false,
      backend: "jev-gateway",
      model: "typesafe/jev-1.14",
      modelVersion: "typesafe/jev-1.14-20261014",
      questionHash,
    });
    expect(config.warnings.some((warning) => warning.includes("no qualification manifest"))).toBe(true);
  });

  it("does not accept mission calibration policy from a persisted session snapshot", () => {
    const fallback = sessionConfigOf(loadHookConfig({}));
    const forged = {
      ...fallback,
      missionClosurePolicy: {
        ...fallback.missionClosurePolicy,
        calibrated: true,
        calibrationVersion: "forged",
      },
    };
    const loaded = readSessionConfig(forged, fallback);
    expect(loaded?.missionClosurePolicy).toEqual(fallback.missionClosurePolicy);
  });

  it("ignores malformed install-scoped policy fields with warnings", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jev-policy-invalid-"));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ gate: "wide-open", route_prompts: "yes", auto_threshold: 7 }));
    const config = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir });
    expect(config.gate).toBe("advisory");
    expect(config.routePrompts).toBe(false);
    expect(config.autoThreshold).toBe(0.85);
    expect(config.warnings.join(" ")).toContain("data-dir config gate");
    expect(config.warnings.join(" ")).toContain("data-dir config route_prompts");
    expect(config.warnings.join(" ")).toContain("data-dir config auto_threshold");
  });

  it("keeps home-file precedence over the data-dir plant", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jev-datadir-"));
    writeFileSync(join(dataDir, "credentials"), JSON.stringify({ TYPESAFE_API_KEY: "sk-planted" }));
    chmodSync(join(dataDir, "credentials"), 0o600);
    const home = mkdtempSync(join(tmpdir(), "jev-home-"));
    mkdirSync(join(home, ".config", "jeverb"), { recursive: true });
    writeFileSync(join(home, ".config", "jeverb", "credentials"), JSON.stringify({ TYPESAFE_API_KEY: "sk-home" }));
    chmodSync(join(home, ".config", "jeverb", "credentials"), 0o600);
    const config = loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir, HOME: home });
    expect(config.apiKey).toBe("sk-home");
  });
});

describe("missing credentials versus backend reachability", () => {
  function missingPath(): string {
    return join(mkdtempSync(join(tmpdir(), "jev-creds-")), "no-such-file");
  }

  it("warns naming the backend when it is selected but its key is absent", () => {
    const config = loadHookConfig({ JEV_BACKEND: "openrouter", JEV_CREDENTIALS_FILE: missingPath() });
    expect(config.apiKey).toBeNull();
    const text = config.warnings.join(" ");
    expect(text).toContain("openrouter");
    expect(text).toContain("missing credentials");
    expect(text).toContain("never contacted");
  });

  it("warns for an explicitly selected typesafe backend with no key", () => {
    const config = loadHookConfig({ JEV_BACKEND: "typesafe", JEV_CREDENTIALS_FILE: missingPath() });
    expect(config.apiKey).toBeNull();
    expect(config.warnings.join(" ")).toContain("typesafe");
  });

  it("stays quiet with no backend selected and no key", () => {
    expect(loadHookConfig({ JEV_CREDENTIALS_FILE: missingPath() }).warnings).toEqual([]);
  });

  it("says nothing when the selected backend has its key", () => {
    const config = loadHookConfig({
      JEV_BACKEND: "openrouter",
      OPENROUTER_API_KEY: "sk-or-test-key",
      JEV_CREDENTIALS_FILE: missingPath(),
    });
    expect(config.warnings).toEqual([]);
  });
});

describe("provider identity", () => {
  it("labels the default config as the pinned TypeSafe model", () => {
    expect(providerIdentityOf(loadHookConfig({}))).toEqual({
      provider: "typesafe",
      model: "jev-1.14.0",
      baseUrl: "https://api.typesafe.ai",
    });
  });

  it("labels the OpenRouter backend and its router model", () => {
    const identity = providerIdentityOf(
      loadHookConfig({ JEV_BACKEND: "openrouter", OPENROUTER_API_KEY: "sk-or-test-key" }),
    );
    expect(identity.provider).toBe("openrouter");
    expect(identity.model).toBe("typesafe/jev-latest");
    expect(identity.baseUrl).toBe("https://openrouter.ai/api/v1");
  });
});

describe("the session config snapshot", () => {
  it("rebuilds a full config from a snapshot plus this daemon's secrets", () => {
    const own = loadHookConfig({ JEV_GATE: "strict" });
    const rebuilt = hookConfigFrom(sessionConfigOf(own), "sk-daemon", "/tmp/data");
    expect(rebuilt.gate).toBe("strict");
    expect(rebuilt.apiKey).toBe("sk-daemon");
    expect(rebuilt.dataDir).toBe("/tmp/data");
    // The kill switch is never inherited: it stops the hook before the daemon.
    expect(rebuilt.disabled).toBe(false);
    expect(rebuilt.warnings).toEqual([]);
  });
});

describe("adversarial closure toggle", () => {
  it("defaults off and enables from explicit operator env", () => {
    expect(loadHookConfig({}).adversarialClosure).toBe(false);
    expect(loadHookConfig({ JEV_ADVERSARIAL_CLOSURE: "1" }).adversarialClosure).toBe(true);
    expect(loadHookConfig({ JEV_ADVERSARIAL_CLOSURE: "off" }).adversarialClosure).toBe(false);
  });

  it("reads the install-scoped data-dir value with env winning", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jev-datadir-"));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ adversarial_closure: true }));
    expect(loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir }).adversarialClosure).toBe(true);
    expect(loadHookConfig({ MUSE_PLUGIN_DATA_DIR: dataDir, JEV_ADVERSARIAL_CLOSURE: "0" }).adversarialClosure).toBe(false);
  });

  it("survives the session snapshot round-trip and daemon validation", () => {
    const on = sessionConfigOf(loadHookConfig({ JEV_ADVERSARIAL_CLOSURE: "yes" }));
    expect(on.adversarialClosure).toBe(true);
    expect(readSessionConfig(on, sessionConfigOf(loadHookConfig({})))).toEqual(on);
    const own = sessionConfigOf(loadHookConfig({}));
    expect(readSessionConfig({ adversarialClosure: "yes" }, own)?.adversarialClosure).toBe(false);
    expect(readSessionConfig({ adversarialClosure: true }, own)?.adversarialClosure).toBe(true);
  });
});
