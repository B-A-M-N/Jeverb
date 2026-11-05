/**
 * HTTP client for TypeSafe-compatible typed Decisions endpoints, as a `DecisionModel`.
 *
 * There is no TypeSafe SDK dependency here: the wire shapes in
 * `src/decision/types.ts` mirror the native Jev wire contract closely enough
 * that this is a passthrough plus local transport and response safeguards —
 * retry/backoff, deadlines, local budget and schema checks, response identity
 * and provider-usage capture, and verification that every question you asked
 * came back answered with the right type.
 */

import {
  checkBudget,
  DEFAULT_BUDGET_LIMITS,
  type BudgetLimits,
} from "../decision/budget.js";
import type { ListModelsResult, ModelCatalog, ModelInfo } from "../decision/models.js";
import { hashQuestions } from "../decision/provenance.js";
import { validateQuestions } from "../decision/validate.js";
import { PROVIDER_TYPESAFE } from "../decision/types.js";
import type {
  Answer,
  ChoiceAnswer,
  ChoiceQuestion,
  DecisionModel,
  EvaluateRequest,
  EvaluateResult,
  NoulQuestion,
  Question,
  ScoreAnswer,
  ScoreQuestion,
  State,
  Usage,
} from "../decision/types.js";
import {
  JevAuthError,
  JevConnectionError,
  JevError,
  JevForbiddenError,
  JevOverloadedError,
  JevProtocolError,
  JevProviderHttpError,
  JevQuotaError,
  JevRateLimitError,
  JevTimeoutError,
  JevValidationError,
  classifyTransportFailure,
} from "./errors.js";

export type { ListModelsResult, ModelInfo } from "../decision/models.js";

export interface JevDecisionModelOptions {
  apiKey?: string | undefined;
  baseUrl?: string;
  /** Default model for requests that do not override it. */
  model?: string;
  /** Deadline for one logical call, covering all retries. */
  timeoutMs?: number;
  /** Retries *after* the first attempt. 0 disables retrying. */
  maxRetries?: number;
  /** Injected for tests. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Injected for tests so backoff waits do not take real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Override the context limits, e.g. for a future model with a bigger window. */
  budgetLimits?: BudgetLimits;
  /** Override the native endpoint for a compatible Jev Decisions relay. */
  endpointPath?: string;
  /** Keep gateway-mediated judgments distinct in receipts/calibration. */
  provider?: string;
  /** Fixed safe client-label headers for local gateway transports. */
  requestHeaders?: Record<string, string>;
  /** Require and retain the provider's serving-model and request identities. */
  requireResponseIdentity?: boolean;
}

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_JEV_MODEL = "jev-1.14.0";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 10_000;

/** Full-jitter exponential backoff, capped. Exported for tests. */
export function computeBackoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(ceiling * (0.5 + 0.5 * random()));
}

/**
 * Parse a `retry-after` header: delay-seconds or an HTTP date.
 * Returns milliseconds, clamped to the backoff cap, or `null` if unusable.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return Math.min(Math.max(ms, 0), BACKOFF_CAP_MS);
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(date - now, 0), BACKOFF_CAP_MS);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export class JevDecisionModel implements DecisionModel, ModelCatalog {
  readonly name: string;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly budgetLimits: BudgetLimits;
  private readonly endpointPath: string;
  private readonly provider: string;
  private readonly requestHeaders: Record<string, string>;
  private readonly requireResponseIdentity: boolean;

  constructor(options: JevDecisionModelOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.name = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.budgetLimits = options.budgetLimits ?? DEFAULT_BUDGET_LIMITS;
    this.endpointPath = options.endpointPath ?? "/v1/systemone";
    this.provider = options.provider ?? PROVIDER_TYPESAFE;
    this.requestHeaders = options.requestHeaders ?? {};
    this.requireResponseIdentity = options.requireResponseIdentity ?? false;

    if (typeof this.fetchImpl !== "function") {
      throw new JevError("No fetch implementation available. Node 20+ or an injected `fetch` is required.");
    }
  }

  async evaluate<Q extends Record<string, Question>>(request: EvaluateRequest<Q>): Promise<EvaluateResult<Q>> {
    const questions = request.questions as Record<string, Question>;
    validateQuestions(questions);
    checkBudget(request.state, questions, this.budgetLimits);

    const model = request.model ?? this.name;
    const started = Date.now();

    const body = await this.send(
      this.endpointPath,
      this.requestPayload(request.state, model, questions),
      request.signal,
      {
        ...this.requestHeaders,
        ...(request.correlationId === undefined ? {} : { "X-Request-ID": request.correlationId }),
      },
    );

    const latency_ms = Date.now() - started;
    const parsed = this.parseEvaluateResponse(body, questions);
    const correlationId = this.requireResponseIdentity
      ? parsed.requestId
      : request.correlationId ?? parsed.requestId;

    return {
      model: parsed.model,
      ...(correlationId === undefined ? {} : { correlationId }),
      provider: this.provider,
      questionHash: hashQuestions(questions),
      answers: parsed.answers as EvaluateResult<Q>["answers"],
      usage: parsed.usage,
      latency_ms,
    };
  }

  async choice(state: State, question: Omit<ChoiceQuestion, "type">): Promise<ChoiceAnswer> {
    const result = await this.evaluate({ state, questions: { q: { type: "choice", ...question } } });
    return result.answers.q;
  }

  async score(state: State, question: Omit<ScoreQuestion, "type">): Promise<ScoreAnswer> {
    const result = await this.evaluate({ state, questions: { q: { type: "score", ...question } } });
    return result.answers.q;
  }

  async probability(state: State, question: Omit<NoulQuestion, "type">): Promise<number> {
    const result = await this.evaluate({ state, questions: { q: { type: "noul", ...question } } });
    return result.answers.q.noul;
  }

  protected requestPayload(state: State, model: string, questions: Record<string, Question>): unknown {
    return { state, model, questions };
  }

  /** `GET /v1/models` — the names this account may send in `model`. */
  async listModels(signal?: AbortSignal): Promise<ListModelsResult> {
    const body = await this.send("/v1/models", undefined, signal);
    if (typeof body !== "object" || body === null || !Array.isArray((body as { models?: unknown }).models)) {
      throw new JevProtocolError("GET /v1/models did not return a `models` array.", { body });
    }
    return { models: (body as { models: ModelInfo[] }).models };
  }

  // ---------------------------------------------------------------- internals

  /**
   * One logical request: attempts, backoff and the deadline all live here.
   * Returns the parsed JSON body of a 2xx response.
   */
  private async send(
    path: string,
    payload: unknown,
    callerSignal?: AbortSignal,
    requestHeaders?: Record<string, string>,
  ): Promise<unknown> {
    const deadline = Date.now() + this.timeoutMs;
    let lastError: JevError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      this.throwIfCallerAborted(callerSignal);

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw lastError instanceof JevTimeoutError
          ? lastError
          : new JevTimeoutError(`Request to ${path} exceeded the ${this.timeoutMs}ms timeout.`, {
              cause: lastError,
            });
      }

      let response: Response;
      try {
        response = await this.attempt(path, payload, callerSignal, remaining, requestHeaders);
      } catch (error) {
        if (error instanceof JevError && !(error instanceof JevConnectionError)) throw error;
        if (!(error instanceof JevError)) throw error;
        lastError = error;
        if (attempt >= this.maxRetries) throw error;
        await this.backoff(attempt, null, deadline, callerSignal);
        continue;
      }

      if (response.ok) {
        return await this.readJson(response, path);
      }

      const error = await this.toError(response, path);

      // 401 and 422 are caller mistakes; retrying just burns the deadline.
      if (!isRetryableStatus(response.status)) throw error;

      lastError = error;
      if (attempt >= this.maxRetries) throw error;
      await this.backoff(attempt, response.headers.get("retry-after"), deadline, callerSignal);
    }

    /* c8 ignore next */
    throw lastError ?? new JevError(`Request to ${path} failed with no attempts made.`);
  }

  /** A single HTTP attempt, with its own abort plumbing. */
  private async attempt(
    path: string,
    payload: unknown,
    callerSignal: AbortSignal | undefined,
    remainingMs: number,
    requestHeaders?: Record<string, string>,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remainingMs);

    const onCallerAbort = (): void => {
      controller.abort();
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const init: RequestInit = {
        method: payload === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
          ...requestHeaders,
        },
        signal: controller.signal,
      };
      if (payload !== undefined) init.body = JSON.stringify(payload);

      return await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        this.throwIfCallerAborted(callerSignal);
        if (timedOut) {
          throw new JevTimeoutError(`Request to ${path} exceeded the ${this.timeoutMs}ms timeout.`, {
            transportDiagnostic: { kind: "timeout", code: "TIMEOUT_EXCEEDED" },
          });
        }
      }
      const transportDiagnostic = classifyTransportFailure(error);
      throw new JevConnectionError("Could not reach decision provider.", {
        code: transportDiagnostic.code,
        transportDiagnostic,
      });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private throwIfCallerAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw signal.reason ?? new JevTimeoutError("Request aborted by the caller.");
    }
  }

  private async backoff(
    attempt: number,
    retryAfter: string | null,
    deadline: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<void> {
    const hinted = parseRetryAfter(retryAfter);
    const wait = Math.min(hinted ?? computeBackoffMs(attempt), Math.max(deadline - Date.now(), 0));
    if (wait > 0) await this.sleep(wait);
    this.throwIfCallerAborted(callerSignal);
  }

  private async readJson(response: Response, path: string): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new JevProtocolError(`${path} returned a non-JSON body.`, {
        status: response.status,
        body: text.slice(0, 500),
        cause: error,
      });
    }
  }

  private async toError(response: Response, path: string): Promise<JevError> {
    let body: unknown;
    try {
      const text = await response.text();
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text.slice(0, 500);
      }
    } catch {
      body = undefined;
    }

    // Sanitized provider diagnostics: status plus a short error code only.
    // Never persist authorization headers, secrets, or raw sensitive bodies.
    const providerErrorCode = extractProviderErrorCode(body);
    const options = {
      status: response.status,
      body: sanitizeProviderBody(body, providerErrorCode),
      transportDiagnostic: classifyTransportFailure(undefined, response.status),
    };

    switch (response.status) {
      case 401:
        return new JevAuthError(
          "TypeSafe rejected the API key. Check TYPESAFE_API_KEY.",
          options,
        );
      case 403: {
        const signal = `${providerErrorCode ?? ""} ${typeof body === "string" ? body : JSON.stringify(body ?? "")}`.toLowerCase();
        if (/quota|entitlement|allowlist|insufficient|credit|billing|forbidden.*model|model.*access/.test(signal)) {
          return new JevQuotaError(
            `Provider refused the request on quota/entitlement policy (HTTP 403${providerErrorCode ? ` code=${providerErrorCode}` : ""}).`,
            options,
          );
        }
        return new JevForbiddenError(
          `Provider refused the request (HTTP 403${providerErrorCode ? ` code=${providerErrorCode}` : ""}).`,
          options,
        );
      }
      case 422:
        // Validation bodies name the offending field and carry no secrets;
        // keep the full shape so callers can report which field failed.
        return new JevValidationError(
          "TypeSafe rejected the request body as invalid; the response names the offending field.",
          { status: response.status, body },
        );
      case 429:
        return new JevRateLimitError("TypeSafe rate limit exceeded.", options);
      case 529:
        return new JevOverloadedError("TypeSafe is temporarily overloaded.", options);
      default:
        if (response.status >= 500) {
          return new JevOverloadedError(`TypeSafe returned a server error on ${path}.`, options);
        }
        if (response.status >= 400) {
          return new JevProviderHttpError(`Provider returned HTTP ${response.status} on ${path}.`, options);
        }
        return new JevError(`TypeSafe returned an unexpected status on ${path}.`, options);
    }
  }

  /**
   * Check the response against the questions we asked. An id we never asked
   * about is ignored; a missing id, or one whose answer `type` disagrees with
   * the question, is a protocol error — silently handing a caller the wrong
   * answer shape is worse than failing.
   */
  private parseEvaluateResponse(
    body: unknown,
    questions: Record<string, Question>,
  ): { model: string; requestId?: string; answers: Record<string, Answer>; usage: Usage } {
    if (typeof body !== "object" || body === null) {
      throw new JevProtocolError("Evaluate response was not a JSON object.", { body });
    }

    const raw = body as { model?: unknown; id?: unknown; answers?: unknown; usage?: unknown };

    const validIdentity = (value: unknown): value is string =>
      typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_.:/~-]+$/.test(value);
    if (this.requireResponseIdentity && (!validIdentity(raw.model) || !validIdentity(raw.id))) {
      throw new JevProtocolError("Evaluate response is missing a valid serving-model or request identity.", { body });
    }

    if (typeof raw.answers !== "object" || raw.answers === null || Array.isArray(raw.answers)) {
      throw new JevProtocolError("Evaluate response is missing the `answers` object.", { body });
    }
    const answers = raw.answers as Record<string, Answer | undefined>;

    const missing: string[] = [];
    const mismatched: string[] = [];

    for (const [id, question] of Object.entries(questions)) {
      const answer = answers[id];
      if (answer === undefined || answer === null) {
        missing.push(id);
        continue;
      }
      if (answer.type !== question.type) {
        mismatched.push(`${id} (asked ${question.type}, got ${JSON.stringify(answer.type)})`);
      }
    }

    if (missing.length > 0) {
      throw new JevProtocolError(
        `Evaluate response is missing answers for: ${missing.join(", ")}.`,
        { body },
      );
    }
    if (mismatched.length > 0) {
      throw new JevProtocolError(
        `Evaluate response answer types do not match the questions asked: ${mismatched.join("; ")}.`,
        { body },
      );
    }

    const usage = raw.usage as (Partial<Usage> & { cost?: unknown }) | undefined;

    return {
      model: validIdentity(raw.model) ? raw.model : this.name,
      ...(validIdentity(raw.id) ? { requestId: raw.id } : {}),
      answers: answers as Record<string, Answer>,
      usage: {
        input_tokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : 0,
        output_tokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : 0,
        ...(typeof usage?.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
          ? { cost_usd: usage.cost }
          : {}),
      },
    };
  }
}

function isRetryableStatus(status: number): boolean {
  // 401/403/422 are caller or admission mistakes: retrying burns quota.
  if (status === 401 || status === 403 || status === 422) return false;
  // A 429 is an admission decision (including a free-tier warmup throttle),
  // not a failed attempt: retrying it re-dispatches a refused request.
  if (status === 429) return false;
  return status >= 500;
}

/** Best-effort extraction of a short machine-readable provider error code. */
function extractProviderErrorCode(body: unknown): string | undefined {
  if (typeof body === "string") {
    const m = body.slice(0, 200).match(/[a-z0-9_.-]{3,64}/i);
    return m?.[0].slice(0, 64);
  }
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const candidates: unknown[] = [
    (record.error as Record<string, unknown> | undefined)?.code,
    record.code,
    record.error_code,
    record.failure_category,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim().slice(0, 64);
    }
  }
  return undefined;
}

/** Keep only status-relevant diagnostics; drop secrets and long raw bodies. */
function sanitizeProviderBody(body: unknown, code: string | undefined): unknown {
  if (body === undefined || body === null) {
    return code === undefined ? undefined : { providerErrorCode: code };
  }
  if (typeof body === "string") {
    const text = body.slice(0, 300);
    return code === undefined ? text : { providerErrorCode: code, detail: text.slice(0, 200) };
  }
  if (typeof body !== "object") return code === undefined ? {} : { providerErrorCode: code };
  const record = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (code !== undefined) out.providerErrorCode = code;
  for (const key of ["message", "error", "status", "failure_category", "request_id", "requestId"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) out[key] = value.slice(0, 300);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (key === "error" && typeof value === "object" && value !== null) {
      const nested = value as Record<string, unknown>;
      if (typeof nested.message === "string") out.errorMessage = nested.message.slice(0, 300);
      if (typeof nested.code === "string") out.errorCode = nested.code.slice(0, 64);
    }
  }
  return out;
}
