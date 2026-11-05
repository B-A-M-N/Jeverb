import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "./helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig, missingApiKeyMessage } from "../src/config.js";

describe("loadConfig", () => {
  it("applies documented defaults", () => {
    const config = loadConfig({ TYPESAFE_API_KEY: "sk-abc" });
    expect(config).toEqual({
      apiKey: "sk-abc",
      backend: "typesafe",
      allowCustomRelay: false,
      baseUrl: DEFAULTS.baseUrl,
      model: DEFAULTS.model,
      timeoutMs: DEFAULTS.timeoutMs,
      maxRetries: DEFAULTS.maxRetries,
      thresholds: { auto: DEFAULTS.autoThreshold, review: DEFAULTS.reviewThreshold },
      maxConcurrency: DEFAULTS.maxConcurrency,
      maxConcurrencyExplicit: false,
      warnings: [],
      masterSwitchPath: "/var/lib/jeverb/control-state.json",
      // Absolute and machine-dependent, so asserted for shape rather than value.
      projectRoot: expect.any(String),
    });
  });

  /**
   * 0.5.0 pins the version the server sends. An alias that re-points silently
   * moves every probability a caller has tuned thresholds against.
   */
  it("defaults to a pinned model version, not to the alias", () => {
    expect(DEFAULTS.model).toBe("jev-1.14.0");
    expect(loadConfig({ TYPESAFE_API_KEY: "k" }).model).toBe("jev-1.14.0");
  });

  it("reads the plugin's model option, and ignores an empty or unsubstituted one", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: "k", CLAUDE_PLUGIN_OPTION_MODEL: "jev-latest" }).model).toBe("jev-latest");
    expect(
      loadConfig({ TYPESAFE_API_KEY: "k", CLAUDE_PLUGIN_OPTION_MODEL: "  ", JEV_MODEL: "jev-1.12.0" }).model,
    ).toBe("jev-1.12.0");
    expect(loadConfig({ TYPESAFE_API_KEY: "k", CLAUDE_PLUGIN_OPTION_MODEL: "${user_config.model}" }).model).toBe(
      DEFAULTS.model,
    );
  });

  it("confines the file tools to CLAUDE_PROJECT_DIR when the harness sets one", () => {
    const config = loadConfig({ TYPESAFE_API_KEY: "sk-abc", CLAUDE_PROJECT_DIR: process.cwd() });
    expect(config.projectRoot).toBe(process.cwd());
  });

  it("represents a missing API key instead of throwing", () => {
    expect(loadConfig({}).apiKey).toBeNull();
    expect(loadConfig({ TYPESAFE_API_KEY: "" }).apiKey).toBeNull();
    expect(loadConfig({ TYPESAFE_API_KEY: "   " }).apiKey).toBeNull();
  });

  it("reads every override", () => {
    const config = loadConfig({
      TYPESAFE_API_KEY: " sk-abc ",
      TYPESAFE_BASE_URL: "http://localhost:9000/",
      JEV_MODEL: "jev-1.14.0",
      JEV_TIMEOUT_MS: "5000",
      JEV_MAX_RETRIES: "0",
      JEV_AUTO_THRESHOLD: "0.9",
      JEV_REVIEW_THRESHOLD: "0.5",
      JEV_MAX_CONCURRENCY: "8",
    });

    expect(config).toEqual({
      apiKey: "sk-abc",
      backend: "typesafe",
      allowCustomRelay: false,
      baseUrl: "http://localhost:9000",
      model: "jev-1.14.0",
      timeoutMs: 5000,
      maxRetries: 0,
      thresholds: { auto: 0.9, review: 0.5 },
      maxConcurrency: 8,
      maxConcurrencyExplicit: true,
      warnings: [],
      masterSwitchPath: "/var/lib/jeverb/control-state.json",
      projectRoot: expect.any(String),
    });
  });

  it("falls back to the default when an override is blank", () => {
    const config = loadConfig({ TYPESAFE_API_KEY: "k", JEV_MODEL: "  ", JEV_TIMEOUT_MS: "" });
    expect(config.model).toBe(DEFAULTS.model);
    expect(config.timeoutMs).toBe(DEFAULTS.timeoutMs);
  });

  it("rejects malformed numbers with a message naming the variable", () => {
    expect(() => loadConfig({ TYPESAFE_API_KEY: "k", JEV_TIMEOUT_MS: "soon" })).toThrow(/JEV_TIMEOUT_MS/);
    expect(() => loadConfig({ TYPESAFE_API_KEY: "k", JEV_AUTO_THRESHOLD: "1.5" })).toThrow(
      /JEV_AUTO_THRESHOLD/,
    );
    expect(() => loadConfig({ TYPESAFE_API_KEY: "k", JEV_MAX_CONCURRENCY: "0" })).toThrow(
      /JEV_MAX_CONCURRENCY/,
    );
  });

  it("rejects a review threshold above the auto threshold", () => {
    expect(() =>
      loadConfig({ TYPESAFE_API_KEY: "k", JEV_AUTO_THRESHOLD: "0.5", JEV_REVIEW_THRESHOLD: "0.9" }),
    ).toThrow(/must not exceed/);
  });
});

describe("loadConfig — API key sources", () => {
  it("prefers the plugin option over the shell variable", () => {
    expect(loadConfig({ JEV_PLUGIN_API_KEY: "sk-plugin", TYPESAFE_API_KEY: "sk-shell" }).apiKey).toBe("sk-plugin");
  });

  // The plugin manifest always sets JEV_PLUGIN_API_KEY. When the user left the
  // option empty and exported the key in their shell instead, that empty value
  // must not mask it.
  it("falls through an empty or unsubstituted plugin option to the shell variable", () => {
    expect(loadConfig({ JEV_PLUGIN_API_KEY: "", TYPESAFE_API_KEY: "sk-shell" }).apiKey).toBe("sk-shell");
    expect(loadConfig({ JEV_PLUGIN_API_KEY: "  ", TYPESAFE_API_KEY: "sk-shell" }).apiKey).toBe("sk-shell");
    expect(loadConfig({ JEV_PLUGIN_API_KEY: "${user_config.api_key}", TYPESAFE_API_KEY: "sk-shell" }).apiKey).toBe("sk-shell");
  });

  it("reports no key when every source is empty", () => {
    expect(loadConfig({ JEV_PLUGIN_API_KEY: "", TYPESAFE_API_KEY: "" }).apiKey).toBeNull();
  });
});

describe("loadConfig — backend selection", () => {
  it("stays native by default and ignores the other backend's key", () => {
    const config = loadConfig({ TYPESAFE_API_KEY: "sk-abc", OPENROUTER_API_KEY: "sk-or-abc" });
    expect(config.backend).toBe("typesafe");
    expect(config.apiKey).toBe("sk-abc");
    expect(config.baseUrl).toBe(DEFAULTS.baseUrl);
    expect(config.model).toBe(DEFAULTS.model);
    expect(config.allowCustomRelay).toBe(false);
  });

  it("switches defaults to OpenRouter with JEV_BACKEND=openrouter", () => {
    const config = loadConfig({ JEV_BACKEND: "openrouter", OPENROUTER_API_KEY: "sk-or-abc" });
    expect(config.backend).toBe("openrouter");
    expect(config.apiKey).toBe("sk-or-abc");
    expect(config.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.model).toBe("typesafe/jev-latest");
    expect(config.allowCustomRelay).toBe(false);
  });

  it("selects the keyless local FI Gateway Jev slot", () => {
    const config = loadConfig({ JEV_BACKEND: "jev-gateway" });
    expect(config.backend).toBe("jev-gateway");
    expect(config.apiKey).toBeNull();
    expect(config.baseUrl).toBe("http://127.0.0.1:18769/jev");
    expect(config.model).toBe("typesafe/jev-latest");
    expect(missingApiKeyMessage("jev-gateway")).toContain("127.0.0.1:18769");
  });

  it("reads relay approval and a custom relay base URL", () => {
    const config = loadConfig({
      JEV_BACKEND: "openrouter",
      JEV_ALLOW_CUSTOM_RELAY: "true",
      OPENROUTER_API_KEY: "sk-or-abc",
      OPENROUTER_BASE_URL: "http://127.0.0.1:18789/api/v1",
    });
    expect(config.allowCustomRelay).toBe(true);
    expect(config.baseUrl).toBe("http://127.0.0.1:18789/api/v1");
    // A key from the other backend is ignored, never forwarded wrongly.
    expect(loadConfig({ JEV_BACKEND: "openrouter", TYPESAFE_API_KEY: "sk-native" }).apiKey).toBeNull();
    expect(loadConfig({ OPENROUTER_API_KEY: "sk-or-abc" }).apiKey).toBeNull();
  });

  it("names the missing key for the selected backend", () => {
    expect(missingApiKeyMessage("typesafe")).toMatch(/TYPESAFE_API_KEY/);
    expect(missingApiKeyMessage("openrouter")).toMatch(/OPENROUTER_API_KEY/);
  });
});

describe("loadConfig — Muse plugin data directory", () => {
  it("loads native Muse MCP config from the plugin id in its absolute cache path", () => {
    const home = mkdtempSync(join(tmpdir(), "jev-native-muse-home-"));
    const dataHome = join(home, ".local", "share");
    const digest = "c".repeat(64);
    const script = join(dataHome, "muse", "plugins", "cache", "local", "jeverb", digest,
      "package", "plugin", "dist", "mcp.mjs");
    const dataDir = join(dataHome, "muse", "plugins", "data", "jeverb");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      backend: "jev-gateway", base_url: "http://127.0.0.1:18769/jev", model: "typesafe/jev-latest",
    }));
    const config = loadConfig({ HOME: home }, script);
    expect(config).toMatchObject({
      backend: "jev-gateway", baseUrl: "http://127.0.0.1:18769/jev", model: "typesafe/jev-latest", apiKey: null,
    });
  });

  it("loads backend, gateway, model, budgets, and matching credentials from install-scoped files", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-muse-config-"));
    try {
      writeFileSync(join(dir, "config.json"), JSON.stringify({
        backend: "openrouter",
        base_url: "https://gateway.invalid/jev/v1/",
        model: "typesafe/jev-router",
        allow_custom_relay: true,
        timeout_ms: 8_000,
        max_retries: 0,
        auto_threshold: 0.9,
        review_threshold: 0.55,
        max_concurrency: 6,
      }));
      writeFileSync(join(dir, "credentials"), JSON.stringify({ OPENROUTER_API_KEY: "synthetic-gateway-key" }));
      chmodSync(join(dir, "credentials"), 0o600);

      const config = loadConfig({ MUSE_PLUGIN_DATA_DIR: dir });
      expect(config).toMatchObject({
        apiKey: "synthetic-gateway-key",
        backend: "openrouter",
        baseUrl: "https://gateway.invalid/jev/v1",
        model: "typesafe/jev-router",
        allowCustomRelay: true,
        timeoutMs: 8_000,
        maxRetries: 0,
        thresholds: { auto: 0.9, review: 0.55 },
        maxConcurrency: 6,
        maxConcurrencyExplicit: true,
        warnings: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps explicit environment settings ahead of plugin files and never crosses backend keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-muse-config-"));
    try {
      writeFileSync(join(dir, "config.json"), JSON.stringify({
        backend: "openrouter", base_url: "https://gateway.invalid/v1", allow_custom_relay: true, model: "relay-model",
      }));
      writeFileSync(join(dir, "credentials"), JSON.stringify({ OPENROUTER_API_KEY: "synthetic-relay-key" }));
      chmodSync(join(dir, "credentials"), 0o600);

      const config = loadConfig({
        MUSE_PLUGIN_DATA_DIR: dir,
        JEV_BACKEND: "typesafe",
        JEV_MODEL: "jev-1.14.0",
        TYPESAFE_API_KEY: "synthetic-typesafe-key",
        TYPESAFE_BASE_URL: "https://typesafe.invalid/",
      });
      expect(config).toMatchObject({
        backend: "typesafe",
        apiKey: "synthetic-typesafe-key",
        baseUrl: "https://typesafe.invalid",
        model: DEFAULTS.model,
        allowCustomRelay: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores broadly permissioned credential files and surfaces a sanitized warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-muse-config-"));
    try {
      writeFileSync(join(dir, "config.json"), JSON.stringify({ backend: "openrouter" }));
      writeFileSync(join(dir, "credentials"), JSON.stringify({ OPENROUTER_API_KEY: "must-not-load" }));
      chmodSync(join(dir, "credentials"), 0o644);

      const config = loadConfig({ MUSE_PLUGIN_DATA_DIR: dir });
      expect(config.apiKey).toBeNull();
      expect(config.warnings.join(" ")).toMatch(/accessible to group or others/);
      expect(config.warnings.join(" ")).not.toContain("must-not-load");
      expect(missingApiKeyMessage(config.backend, config.warnings)).toMatch(/credential file.*0600/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
