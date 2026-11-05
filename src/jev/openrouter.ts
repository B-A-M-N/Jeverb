/**
 * Generic OpenRouter chat-model adapter, separate from native Jev.
 *
 * This path asks an ordinary generative model for JSON and maps that output
 * onto `Answer` shapes. Those model-written probabilities are not native Jev
 * probabilities and must never be treated as Jev or calibrated against Jev.
 * Use `OpenRouterJevDecisionModel` for `typesafe/jev-*` models; it calls the
 * typed Decisions API without prompt-and-parse emulation.
 */

import { hashQuestions } from "../decision/provenance.js";
import { computeBackoffMs, JevDecisionModel, parseRetryAfter } from "./client.js";

/** retry-after in ms when the provider sends a parseable one, else undefined. */
function retryAfterMs(response: Response): number | undefined {
  const hinted = parseRetryAfter(response.headers.get("retry-after"));
  return hinted === null ? undefined : hinted;
}
import { PROVIDER_OPENROUTER } from "../decision/types.js";
import type {
  Answer,
  ChoiceQuestion,
  DecisionModel,
  EvaluateRequest,
  EvaluateResult,
  NoulQuestion,
  Question,
  ScoreQuestion,
  State,
  Usage,
} from "../decision/types.js";
import {
  JevAuthError,
  JevConnectionError,
  JevError,
  JevOverloadedError,
  JevRateLimitError,
  JevTimeoutError,
  JevValidationError,
  type ValidationFailureCode,
  classifyTransportFailure,
  type TransportDiagnostic,
} from "./errors.js";

/**
 * Sanitized metadata attached to validation errors for benchmark
 * diagnostics. Sizes, finish reasons, and attempt counts only — never
 * provider output text or credentials.
 */
export interface ValidationMetadata {
  inputTruncated: boolean;
  attempt: number;
  finishReason?: string;
  outputTokens?: number;
}

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_JEV_MODEL = "~typesafe/jev-latest";
export const OPENROUTER_JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export type OpenRouterConnectivityProbe =
  | { reachable: true; httpStatus: number }
  | { reachable: false; diagnostic: TransportDiagnostic };

/** Non-inference reachability check: unauthenticated HEAD, with no request body. */
export async function probeOpenRouterJevEndpoint(
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = 5_000,
): Promise<OpenRouterConnectivityProbe> {
  try {
    const response = await fetchImpl(OPENROUTER_JEV_DECISIONS_URL, {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // HEAD is not an inference method. A 404 is expected on some deployments
    // because the Decisions route accepts POST only; official route identity
    // is pinned separately by OPENROUTER_JEV_DECISIONS_URL.
    if (response.status >= 500) {
      return { reachable: false, diagnostic: classifyTransportFailure(undefined, response.status) };
    }
    return { reachable: true, httpStatus: response.status };
  } catch (error) {
    return { reachable: false, diagnostic: classifyTransportFailure(error) };
  }
}

/** The OpenRouter Decisions API uses a model alias with a leading `~`. */
export function canonicalOpenRouterJevModel(model: string): string {
  return model === "typesafe/jev-latest" ? DEFAULT_OPENROUTER_JEV_MODEL : model;
}

export function isOpenRouterJevModel(model: string): boolean {
  return /^~?typesafe\/jev(?:-|$)/.test(model);
}

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string;
  /** Explicit generative OpenRouter model id. Jev uses OpenRouterJevDecisionModel. */
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  maxTokens?: number;
  /** Retries *after* the first attempt. 0 disables retrying. Defaults to 3. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface ChatMessage {
  role: string;
  content: string;
}

function clamp01(n: unknown, code: ValidationFailureCode = "INVALID_PROBABILITIES"): number {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new JevValidationError("expected a finite number", { code });
  }
  return Math.min(1, Math.max(0, n));
}

function questionSchema(id: string, q: Question): string {
  const criteria = "criteria" in q ? JSON.stringify(q.criteria) : "{}";
  if (q.type === "noul") {
    return `"${id}": {"p": 0..1}, // ${(q as NoulQuestion).instructions}`;
  }
  if (q.type === "choice") {
    const options = Object.keys((q as ChoiceQuestion).criteria ?? {});
    return `"${id}": {"pick": one of ${JSON.stringify(options)}, "probabilities": {option: 0..1}}, // ${(q as ChoiceQuestion).instructions} criteria=${criteria}`;
  }
  const levels = ((q as ScoreQuestion).criteria ?? []).length;
  return `"${id}": {"index": 0..${Math.max(0, levels - 1)}, "probabilities": [0..1 per level]}, // ${(q as ScoreQuestion).instructions} criteria=${criteria}`;
}

function toAnswer(id: string, q: Question, raw: unknown, meta: ValidationMetadata): Answer {
  const invalid = (code: ValidationFailureCode, detail: string): JevValidationError =>
    new JevValidationError(`answer "${id}" ${detail}`, { code, body: { ...meta } });
  if (q.type === "noul" && typeof raw === "number") {
    // A bare number is the natural reading of a P(yes) question, and some
    // models emit `{"destructive": 0.12}` despite the `{p: ...}` schema in
    // the prompt. Accept it as P(yes); every other shape still goes
    // through the strict object path below.
    try {
      return { type: "noul", noul: clamp01(raw) };
    } catch {
      throw invalid("INVALID_PROBABILITIES", "has a non-finite probability");
    }
  }
  if (typeof raw !== "object" || raw === null) {
    throw invalid("INVALID_RESPONSE_SHAPE", "is not an object");
  }
  const r = raw as Record<string, unknown>;
  if (q.type === "noul") {
    try {
      return { type: "noul", noul: clamp01(r.p) };
    } catch {
      throw invalid("INVALID_PROBABILITIES", "has a non-finite probability");
    }
  }
  if (q.type === "choice") {
    const options = Object.keys(q.criteria ?? {});
    const pick = r.pick;
    if (typeof pick !== "string" || !options.includes(pick)) {
      throw invalid("INVALID_CHOICE", "picks an unknown option");
    }
    const probs: Record<string, number> = {};
    const given = (r.probabilities ?? {}) as Record<string, unknown>;
    if (r.probabilities !== undefined && (typeof r.probabilities !== "object" || r.probabilities === null)) {
      throw invalid("INVALID_PROBABILITIES", "has malformed probabilities");
    }
    let total = 0;
    try {
      for (const o of options) {
        const v = clamp01(given[o] ?? (o === pick ? 1 : 0));
        probs[o] = v;
        total += v;
      }
    } catch {
      throw invalid("INVALID_PROBABILITIES", "has a non-finite probability");
    }
    if (total <= 0) throw invalid("INVALID_PROBABILITIES", "has all-zero probabilities");
    for (const o of options) probs[o]! /= total;
    return { type: "choice", choice: pick, probabilities: probs, confidence: Math.max(...options.map((o) => probs[o]!)) };
  }
  const levels = (q.criteria ?? []).length;
  const probsRaw = r.probabilities;
  if (probsRaw === undefined) {
    throw invalid("MISSING_PROBABILITIES", "is missing level probabilities");
  }
  if (!Array.isArray(probsRaw) || probsRaw.length !== levels) {
    throw invalid("INVALID_PROBABILITIES", "has malformed level probabilities");
  }
  let probs: number[];
  try {
    probs = probsRaw.map((v) => clamp01(v));
  } catch {
    throw invalid("INVALID_PROBABILITIES", "has a non-finite probability");
  }
  const total = probs.reduce((a, b) => a + b, 0);
  if (total <= 0) throw invalid("INVALID_PROBABILITIES", "has all-zero probabilities");
  const norm = probs.map((v) => v / total);
  const legend: Record<string, string> = {};
  (q.criteria ?? []).forEach((entry, i) => {
    legend[String(i)] = JSON.stringify(entry);
  });
  return {
    type: "score",
    score: norm.reduce((a, p, i) => a + p * i, 0),
    legend,
    probabilities: Object.fromEntries(norm.map((p, i) => [String(i), p])),
    confidence: Math.max(...norm),
  };
}

export class OpenRouterDecisionModel implements DecisionModel {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: OpenRouterOptions) {
    if (!opts.apiKey) throw new JevAuthError("OpenRouter API key is missing.");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "");
    if (opts.model === undefined || opts.model.trim() === "") {
      throw new JevValidationError("an explicit generative OpenRouter model id is required; use the native Jev Decisions adapter for Jev models.");
    }
    this.model = opts.model;
    this.name = `openrouter:${this.model}`;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxTokens = opts.maxTokens ?? 512;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    // Same default as the native client: callers that need no retries opt out
    // explicitly with maxRetries: 0.
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async evaluate<Q extends Record<string, Question>>(request: EvaluateRequest<Q>): Promise<EvaluateResult<Q>> {
    const ids = Object.keys(request.questions);
    if (ids.length === 0) throw new JevValidationError("No questions provided.");
    const model = request.model ?? this.model;

    const schema = ids.map((id) => questionSchema(id, request.questions[id]!)).join("\n");
    const stateText = JSON.stringify(request.state);
    // The adapter truncates oversized states before sending. Record whether
    // calibration-relevant evidence may have been omitted so benchmark
    // failures can distinguish INPUT_TRUNCATED from model error.
    const inputTruncated = stateText.length > 6000;
    const baseMeta: ValidationMetadata = { inputTruncated, attempt: 0 };
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "Answer each bounded judgment question with a single JSON object. " +
          "Output ONLY that object, no prose. Probabilities are 0..1 estimates.",
      },
      {
        role: "user",
        content: `State:\n${stateText.slice(0, 6000)}\n\nQuestions (reply {"<id>": answer} exactly):\n{\n${schema}\n}`,
      },
    ];

    const started = Date.now();
    // One deadline for the whole logical request, attempts included — the
    // same shape as the native client. Retries never extend the budget.
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const payload = JSON.stringify({
      model,
      messages,
      temperature: 0,
      max_tokens: this.maxTokens,
      response_format: { type: "json_object" },
    });

    let response: Response | undefined;
    let attemptsUsed = 0;
    for (let attempt = 0; ; attempt += 1) {
      attemptsUsed = attempt + 1;
      if (request.signal?.aborted) {
        throw new JevTimeoutError(`OpenRouter request aborted after ${Date.now() - started}ms.`, {
          transportDiagnostic: { kind: "timeout", code: "REQUEST_ABORTED" },
        });
      }
      try {
        response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: payload,
          signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          throw new JevTimeoutError(`OpenRouter request timed out after ${this.timeoutMs}ms.`, {
            transportDiagnostic: { kind: "timeout", code: "TIMEOUT_EXCEEDED" },
          });
        }
        if (err instanceof Error && err.name === "AbortError") {
          throw new JevTimeoutError(`OpenRouter request aborted after ${Date.now() - started}ms.`, {
            transportDiagnostic: { kind: "timeout", code: "REQUEST_ABORTED" },
          });
        }
        // Network failure: retry while attempts remain, like the native client.
        if (attempt < this.maxRetries) {
          await this.sleep(computeBackoffMs(attempt));
          continue;
        }
        const transportDiagnostic = classifyTransportFailure(err);
        throw new JevConnectionError("Could not reach OpenRouter.", {
          code: transportDiagnostic.code,
          transportDiagnostic,
        });
      }

      // 401/403 are caller mistakes; retrying burns the deadline.
      if (response.status === 401 || response.status === 403) {
        throw new JevAuthError("OpenRouter rejected the API key.", {
          status: response.status,
          transportDiagnostic: classifyTransportFailure(undefined, response.status),
        });
      }
      // Only 5xx is retried: it signals a genuinely failed attempt, not an
      // admission decision. A 429 (including a free-tier warmup throttle) is
      // terminal — retrying it re-dispatches a request the provider refused.
      if (response.status >= 500) {
        if (attempt < this.maxRetries) {
          await this.sleep(retryAfterMs(response) ?? computeBackoffMs(attempt));
          continue;
        }
      }
      break;
    }
    // response is always assigned: the loop only exits via break after a fetch.
    const finalResponse = response as Response;

    if (finalResponse.status === 429) {
      throw new JevRateLimitError("OpenRouter rate-limited the request.", {
        status: finalResponse.status,
        transportDiagnostic: classifyTransportFailure(undefined, finalResponse.status),
      });
    }
    if (finalResponse.status >= 500) {
      throw new JevOverloadedError(`OpenRouter returned HTTP ${finalResponse.status}.`, {
        status: finalResponse.status,
        transportDiagnostic: classifyTransportFailure(undefined, finalResponse.status),
      });
    }
    if (!finalResponse.ok) {
      throw new JevError(`OpenRouter returned HTTP ${finalResponse.status}.`, {
        status: finalResponse.status,
        transportDiagnostic: classifyTransportFailure(undefined, finalResponse.status),
      });
    }
    response = finalResponse;

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new JevValidationError("OpenRouter returned a non-JSON body.", {
        code: "INVALID_RESPONSE_SHAPE",
        body: { ...baseMeta, attempt: attemptsUsed },
      });
    }
    const servedModel = (body as { model?: unknown })?.model;
    if (
      typeof servedModel !== "string" || servedModel.length === 0 || servedModel.length > 256 ||
      /[^\x21-\x7e]/.test(servedModel)
    ) {
      throw new JevValidationError("OpenRouter response did not include a valid serving model identity.", {
        code: "INVALID_RESPONSE_SHAPE",
        body: { ...baseMeta, attempt: attemptsUsed },
      });
    }
    const providerRequestId = (body as { id?: unknown })?.id;
    if (
      typeof providerRequestId !== "string" || providerRequestId.length === 0 ||
      providerRequestId.length > 256 || !/^[A-Za-z0-9_.:=-]+$/.test(providerRequestId)
    ) {
      throw new JevValidationError("OpenRouter response did not include a valid request id.", {
        code: "INVALID_RESPONSE_SHAPE",
        body: { ...baseMeta, attempt: attemptsUsed },
      });
    }
    const firstChoice = (body as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> })
      ?.choices?.[0];
    const finishReason = typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : undefined;
    const usageNode = (body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown } })?.usage;
    const outputTokens =
      typeof usageNode?.completion_tokens === "number" ? usageNode.completion_tokens : undefined;
    const meta: ValidationMetadata = {
      ...baseMeta,
      attempt: attemptsUsed,
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    };
    const content = firstChoice?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new JevValidationError("OpenRouter returned no message content.", {
        code: finishReason === "length" ? "OUTPUT_TRUNCATED" : "EMPTY_CONTENT",
        body: { ...meta },
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Never echo provider output: the code plus sanitized metadata is the
      // complete diagnostic record.
      throw new JevValidationError("OpenRouter content is not JSON.", {
        code: finishReason === "length" ? "OUTPUT_TRUNCATED" : "INVALID_JSON",
        body: { ...meta },
      });
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new JevValidationError("OpenRouter content is not a JSON object.", {
        code: "INVALID_RESPONSE_SHAPE",
        body: { ...meta },
      });
    }

    const answers = {} as { [K in keyof Q]: Answer };
    for (const id of ids) {
      const q = request.questions[id]!;
      if (!(id in (parsed as Record<string, unknown>))) {
        throw new JevValidationError(`OpenRouter answer is missing question "${id}".`, {
          code: finishReason === "length" ? "OUTPUT_TRUNCATED" : "MISSING_QUESTION",
          body: { ...meta },
        });
      }
      (answers as Record<string, Answer>)[id] = toAnswer(id, q, (parsed as Record<string, unknown>)[id], meta);
    }
    // Each answer was validated against its own question above; the mapped
    // type only restates that per-key correspondence for the caller.
    const typed = answers as unknown as { [K in keyof Q]: import("../decision/types.js").AnswerFor<Q[K]> };

    const usage: Usage = {
      input_tokens: typeof usageNode?.prompt_tokens === "number" ? usageNode.prompt_tokens : 0,
      output_tokens: typeof usageNode?.completion_tokens === "number" ? usageNode.completion_tokens : 0,
      ...(typeof usageNode?.cost === "number" && Number.isFinite(usageNode.cost) && usageNode.cost >= 0
        ? { cost_usd: usageNode.cost }
        : {}),
    };
    return {
      model: servedModel,
      correlationId: providerRequestId,
      provider: PROVIDER_OPENROUTER,
      questionHash: hashQuestions(request.questions as Record<string, Question>),
      answers: typed,
      usage,
      latency_ms: Date.now() - started,
    };
  }

  async choice(state: State, question: Omit<ChoiceQuestion, "type">) {
    const result = await this.evaluate({ state, questions: { q: { type: "choice", ...question } } });
    return result.answers.q;
  }

  async score(state: State, question: Omit<ScoreQuestion, "type">) {
    const result = await this.evaluate({ state, questions: { q: { type: "score", ...question } } });
    return result.answers.q;
  }

  async probability(state: State, question: Omit<NoulQuestion, "type">): Promise<number> {
    const result = await this.evaluate({ state, questions: { q: { type: "noul", ...question } } });
    return result.answers.q.noul;
  }
}

/**
 * Native Jev Decisions API adapter for Jev model IDs on OpenRouter.
 * Unlike `OpenRouterDecisionModel`, this sends the original typed `state`
 * and `questions` directly to `/api/alpha/decisions`; no chat prompt or
 * answer-shape emulation is involved.
 */
export class OpenRouterJevDecisionModel extends JevDecisionModel {
  constructor(options: OpenRouterOptions) {
    const configuredBase = (options.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "");
    const apiBase = configuredBase.endsWith("/v1") ? configuredBase.slice(0, -3) : configuredBase;
    super({
      apiKey: options.apiKey,
      baseUrl: apiBase,
      model: canonicalOpenRouterJevModel(options.model ?? DEFAULT_OPENROUTER_JEV_MODEL),
      endpointPath: "/alpha/decisions",
      provider: PROVIDER_OPENROUTER,
      requireResponseIdentity: true,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  }
}
