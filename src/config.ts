/**
 * Environment parsing.
 *
 * The server must boot without an API key: an MCP client typically starts the
 * server before the user has finished configuring it, and a process that exits
 * at startup gives them a transport error instead of an explanation. So a
 * missing key is recorded here (`apiKey: null`) and surfaced as an `isError`
 * tool result that says what to set.
 */

import type { GateThresholds } from "./decision/types.js";
import { resolveProjectRoot } from "./files/index.js";
import { join } from "node:path";
import {
  installIdFromScriptPath,
  museInstallIdFromScriptPath,
  readDataDirConfig,
  readFileCredentials,
  resolveDataDir,
} from "./hooks/config.js";
import { protectedMasterSwitchPath } from "./control/constants.js";

export type ConfigBackend = "typesafe" | "openrouter" | "jev-gateway";

export interface Config {
  /** `null` when no provider key is set — the server still starts. */
  apiKey: string | null;
  /** Explicit protocol selector. Never derived from URL equality. */
  backend: ConfigBackend;
  /**
   * Approval to forward credentials to an OpenRouter-compatible relay URL.
   * Without it, an openrouter backend with a non-official base URL is a
   * construction error, not a silent fallthrough to the native client.
   */
  allowCustomRelay: boolean;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  thresholds: GateThresholds;
  maxConcurrency: number;
  /**
   * True when `JEV_MAX_CONCURRENCY` was set. File-source ranking fans out
   * wider than the default, but an operator who named a number meant it.
   */
  maxConcurrencyExplicit: boolean;
  /** Project root the file-reading tools are confined to. */
  projectRoot: string;
  /** Fixed protected switch-state source; never loaded from environment. */
  masterSwitchPath: string;
  /** Sanitized non-secret issues found while loading the install-scoped config. */
  warnings: string[];
}

export const OPENROUTER_DEFAULTS = {
  baseUrl: "https://openrouter.ai/api/v1",
  model: "typesafe/jev-latest",
} as const;

export const JEV_GATEWAY_DEFAULTS = {
  baseUrl: "http://127.0.0.1:18769/jev",
  model: "typesafe/jev-latest",
} as const;

export const DEFAULTS = {
  baseUrl: "https://api.typesafe.ai",
  /**
   * Pinned: an alias move would shift every probability under thresholds the
   * caller has tuned. `JEV_MODEL=jev-latest` opts back into following
   * releases. The library's own default (`src/jev/client.ts`) stays the alias —
   * a library user picks their own policy.
   */
  model: "jev-1.14.0",
  timeoutMs: 30_000,
  maxRetries: 3,
  autoThreshold: 0.85,
  reviewThreshold: 0.6,
  maxConcurrency: 4,
} as const;

/** Message used wherever a call needs a key that was never configured. */
export const MISSING_API_KEY_MESSAGE =
  "TYPESAFE_API_KEY is not set, so this server cannot reach the Jev API. " +
  "Set it in the MCP server's environment or the install-scoped credentials file (for example: " +
  "`claude mcp add jev -e TYPESAFE_API_KEY=sk-... -- npx -y jevwire`) and restart the server. " +
  "If this is the Claude Code plugin, either set the API key in the plugin's settings or export " +
  "TYPESAFE_API_KEY before starting Claude Code, then run /reload-plugins. " +
  "Keys are issued at https://typesafe.ai.";

export type Env = Record<string, string | undefined>;

function readString(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed === "" ? fallback : trimmed;
}

function readNumber(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(
      `${key}=${JSON.stringify(raw)} is not usable: expected a number between ${min} and ${max}.`,
    );
  }
  return value;
}

/**
 * The plugin manifest passes its `api_key` option as JEV_PLUGIN_API_KEY rather
 * than as TYPESAFE_API_KEY: when the option is left empty, a manifest entry
 * named TYPESAFE_API_KEY would overwrite a key the user exported in their shell
 * with an empty string. An empty or unsubstituted (`${…}`) value is skipped.
 */
function firstKey(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value !== undefined && value !== "" && !value.includes("${")) return value;
  }
  return undefined;
}

/**
 * Build a `Config` from an environment. Throws only on a *malformed* value —
 * a missing API key is represented, not thrown.
 */
/**
 * Message used wherever a call needs a key that was never configured.
 * Backend-aware: the missing key named is the one the selected backend reads.
 */
export function missingApiKeyMessage(backend: ConfigBackend, warnings: readonly string[] = []): string {
  const warningDetails = warnings.length === 0 ? "" : ` Configuration: ${warnings.join(" ")}`;
  if (backend === "jev-gateway") {
    return "The local FI Gateway Jev slot is selected but unavailable; check that 127.0.0.1:18769 is listening and the /jev slot is configured." + warningDetails;
  }
  if (backend === "openrouter") {
    return (
      "OPENROUTER_API_KEY is not set, so this server cannot reach the OpenRouter backend. " +
      "Set it in the MCP server's environment or the install-scoped credentials file and restart the server. " +
      "For an OpenRouter-compatible relay, set backend, base_url and allow_custom_relay in config.json." +
      warningDetails
    );
  }
  return MISSING_API_KEY_MESSAGE + warningDetails;
}

export function loadConfig(env: Env = process.env, scriptPath: string | undefined = process.argv[1]): Config {
  // Native Muse plugin MCP processes receive a cleared environment. Read the
  // install-scoped files only when the host provides a plugin data directory
  // or this entrypoint is running from an installed plugin cache; standalone
  // library/test callers remain isolated from machine plugin configuration.
  const pluginDataContext =
    [env.JEV_HOOKS_DATA_DIR, env.MUSE_PLUGIN_DATA_DIR, env.CLAUDE_PLUGIN_DATA].some((value) => value?.trim() !== undefined && value.trim() !== "") ||
    installIdFromScriptPath(scriptPath) !== undefined ||
    museInstallIdFromScriptPath(scriptPath) !== undefined;
  const dataDir = pluginDataContext ? resolveDataDir(env, scriptPath) : undefined;
  const configWarnings: string[] = [];
  const dirConfig = dataDir === undefined ? {} : readDataDirConfig(join(dataDir, "config.json"), configWarnings);
  const pluginCredentials = dataDir === undefined
    ? {}
    : readFileCredentials(join(dataDir, "credentials"), configWarnings);

  const backendRaw = (env.JEV_BACKEND ?? dirConfig.backend ?? "").trim().toLowerCase();
  const backend: ConfigBackend = backendRaw === "openrouter" ? "openrouter" : backendRaw === "jev-gateway" ? "jev-gateway" : "typesafe";
  const openRouter = backend === "openrouter";
  const defaultBaseUrl = backend === "jev-gateway" ? JEV_GATEWAY_DEFAULTS.baseUrl : openRouter ? OPENROUTER_DEFAULTS.baseUrl : DEFAULTS.baseUrl;
  const defaultModel = backend === "jev-gateway" ? JEV_GATEWAY_DEFAULTS.model : openRouter ? OPENROUTER_DEFAULTS.model : DEFAULTS.model;
  const apiKeyRaw = backend === "jev-gateway" ? null : openRouter
    ? (firstKey(env.JEV_PLUGIN_API_KEY, env.CLAUDE_PLUGIN_OPTION_API_KEY, env.OPENROUTER_API_KEY, pluginCredentials.OPENROUTER_API_KEY) ?? null)
    : (firstKey(env.JEV_PLUGIN_API_KEY, env.CLAUDE_PLUGIN_OPTION_API_KEY, env.TYPESAFE_API_KEY, pluginCredentials.TYPESAFE_API_KEY) ?? null);
  const auto = readNumber(env, "JEV_AUTO_THRESHOLD", dirConfig.autoThreshold ?? DEFAULTS.autoThreshold, 0, 1);
  const review = readNumber(env, "JEV_REVIEW_THRESHOLD", dirConfig.reviewThreshold ?? DEFAULTS.reviewThreshold, 0, 1);

  if (review > auto) {
    throw new Error(
      `JEV_REVIEW_THRESHOLD (${review}) must not exceed JEV_AUTO_THRESHOLD (${auto}).`,
    );
  }

  return {
    apiKey: apiKeyRaw === undefined || apiKeyRaw === "" ? null : apiKeyRaw,
    backend,
    allowCustomRelay: env.JEV_ALLOW_CUSTOM_RELAY === undefined
      ? (dirConfig.allowCustomRelay ?? false)
      : env.JEV_ALLOW_CUSTOM_RELAY.trim().toLowerCase() === "true",
    baseUrl: readString(
      env,
      backend === "jev-gateway" ? "JEV_GATEWAY_BASE_URL" : openRouter ? "OPENROUTER_BASE_URL" : "TYPESAFE_BASE_URL",
      dirConfig.baseUrl ?? defaultBaseUrl,
    )
      .replace(/\/+$/, "") || defaultBaseUrl,
    // The plugin manifest exports its `model` option here too, so the setting
    // means the same thing to the server as it does to the hooks. An empty or
    // unsubstituted option falls through to the env var and then the default.
    model: firstKey(env.CLAUDE_PLUGIN_OPTION_MODEL) ?? readString(env, "JEV_MODEL", dirConfig.model ?? defaultModel),
    timeoutMs: readNumber(env, "JEV_TIMEOUT_MS", dirConfig.timeoutMs ?? DEFAULTS.timeoutMs, 1, 600_000),
    maxRetries: readNumber(env, "JEV_MAX_RETRIES", dirConfig.maxRetries ?? DEFAULTS.maxRetries, 0, 10),
    thresholds: { auto, review },
    maxConcurrency: readNumber(env, "JEV_MAX_CONCURRENCY", dirConfig.maxConcurrency ?? DEFAULTS.maxConcurrency, 1, 32),
    maxConcurrencyExplicit: (env.JEV_MAX_CONCURRENCY ?? "").trim() !== "" || dirConfig.maxConcurrency !== undefined,
    projectRoot: resolveProjectRoot(env),
    masterSwitchPath: protectedMasterSwitchPath(env),
    warnings: configWarnings,
  };
}
