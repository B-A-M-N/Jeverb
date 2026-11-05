/**
 * Backend selection for DecisionModel construction.
 *
 * Native TypeSafe and OpenRouter Jev IDs use their typed Decisions protocols;
 * other OpenRouter models use the chat-completions adapter. Selection follows
 * the explicit backend and Jev model family, never URL equality, so a chat
 * response cannot be mistaken for native Jev probabilities. The local Jev
 * Gateway accepts only the historical pinned model or its production alias.
 * Environment interpretation lives in the config layer, not here.
 */
import type { DecisionModel } from "../decision/types.js";
import { JevDecisionModel } from "./client.js";
import { JevValidationError } from "./errors.js";
import {
  DEFAULT_OPENROUTER_BASE_URL,
  isOpenRouterJevModel,
  OpenRouterDecisionModel,
  OpenRouterJevDecisionModel,
} from "./openrouter.js";
import { DEFAULT_JEV_GATEWAY_BASE_URL, DEFAULT_JEV_GATEWAY_MODEL, JevGatewayDecisionModel } from "./gateway.js";

export type ModelBackend = "typesafe" | "openrouter" | "jev-gateway";

export interface ModelBuildOptions {
  apiKey?: string | undefined;
  /** Explicit protocol selector. URL equality is never consulted. */
  backend: ModelBackend;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  /**
   * Required when `backend` is `"openrouter"` and `baseUrl` is not the
   * official OpenRouter endpoint. Credentials are never forwarded to an
   * unapproved third-party URL: without this flag construction throws.
   */
  allowCustomRelay?: boolean;
}

export function isOpenRouterBaseUrl(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, "").toLowerCase() === DEFAULT_OPENROUTER_BASE_URL;
}

/**
 * Reject model/backend combinations that cannot work, instead of sending a
 * native TypeSafe id to OpenRouter (or a vendor-namespaced id to TypeSafe)
 * and misreading whatever comes back as calibrated Jev output.
 */
export function assertModelBackendMatch(baseUrl: string, model: string, backend?: ModelBackend): void {
  const openRouter = backend === undefined ? isOpenRouterBaseUrl(baseUrl) : backend === "openrouter";
  if (openRouter && /^jev(-|$)/.test(model)) {
    throw new JevValidationError(
      `model "${model}" is missing OpenRouter's provider namespace; use an ID such as "typesafe/jev-1.14" or "~typesafe/jev-latest".`,
    );
  }
  if (!openRouter && model.includes("/")) {
    throw new JevValidationError(
      `model "${model}" is vendor-namespaced and cannot run on the native TypeSafe backend; use a versioned id such as "jev-1.14.0".`,
    );
  }
}

export function buildDecisionModel(opts: ModelBuildOptions): DecisionModel {
  if (opts.backend === "jev-gateway") {
    // Keep the historical explicit version available, while defaulting the
    // gateway route to the operator-selected production alias. The returned
    // provider model remains recorded by the Jev client and is what
    // qualification/receipt checks must inspect.
    if (opts.model !== DEFAULT_JEV_GATEWAY_MODEL && opts.model !== "typesafe/jev-1.14") {
      throw new JevValidationError(
        `backend "jev-gateway" requires the Jev Decisions model "${DEFAULT_JEV_GATEWAY_MODEL}" or "typesafe/jev-1.14".`,
      );
    }
    let isLocalJevSlot = false;
    try {
      const gatewayUrl = new URL(opts.baseUrl);
      isLocalJevSlot =
        gatewayUrl.protocol === "http:" &&
        gatewayUrl.hostname === "127.0.0.1" &&
        gatewayUrl.port === "18769" &&
        gatewayUrl.pathname.replace(/\/$/, "") === "/jev" &&
        gatewayUrl.search === "" &&
        gatewayUrl.hash === "";
    } catch {
      // Invalid URLs are rejected by the same fail-closed guard below.
    }
    if (!isLocalJevSlot) {
      throw new JevValidationError(
        `backend "jev-gateway" must target the local Jev slot at ${DEFAULT_JEV_GATEWAY_BASE_URL}; refusing to send an unauthenticated request elsewhere.`,
      );
    }
    return new JevGatewayDecisionModel({
      baseUrl: opts.baseUrl,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries,
    });
  }
  assertModelBackendMatch(opts.baseUrl, opts.model, opts.backend);
  if (opts.backend === "openrouter") {
    if (!opts.apiKey) throw new JevValidationError("OPENROUTER_API_KEY is required for the OpenRouter backend.");
    if (!isOpenRouterBaseUrl(opts.baseUrl) && opts.allowCustomRelay !== true) {
      throw new JevValidationError(
        `backend "openrouter" with a custom relay base URL ${JSON.stringify(opts.baseUrl)} ` +
          `requires explicit relay approval (allowCustomRelay); refusing to forward credentials ` +
          `to an unapproved endpoint.`,
      );
    }
    const modelOptions = {
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries,
    };
    return isOpenRouterJevModel(opts.model)
      ? new OpenRouterJevDecisionModel(modelOptions)
      : new OpenRouterDecisionModel(modelOptions);
  }
  if (!opts.apiKey) throw new JevValidationError("TYPESAFE_API_KEY is required for the native TypeSafe backend.");
  return new JevDecisionModel({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
  });
}
