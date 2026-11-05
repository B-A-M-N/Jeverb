/**
 * Error taxonomy for the Jev HTTP client.
 *
 * Every error thrown by `JevDecisionModel` is a `JevError`, so callers can
 * branch on `instanceof` for the class and read `status` / `body` for detail.
 * `body` is the parsed (or raw text) response body and never contains the API
 * key — the client never echoes request headers into an error.
 */

export interface JevErrorOptions {
  status?: number;
  body?: unknown;
  cause?: unknown;
  /**
   * Machine-readable failure category. For validation errors this names the
   * exact failure (see ValidationFailureCode); `body`, when present, carries
   * only sanitized metadata (finish reason, attempt count, sizes) — never
   * provider output text or credentials.
   */
  code?: string;
  transportDiagnostic?: TransportDiagnostic;
}

export type TransportFailureKind = "dns" | "tcp" | "tls" | "timeout" | "proxy" | "http";

/** Sanitized transport diagnosis. Codes are allowlisted and never contain URLs, headers, or provider text. */
export interface TransportDiagnostic {
  kind: TransportFailureKind;
  code: string;
  status?: number;
}

/** Map low-level Node/Undici causes to bounded diagnostics safe for persisted receipts. */
export function classifyTransportFailure(error: unknown, status?: number): TransportDiagnostic {
  if (status !== undefined) {
    const kind = status === 407 ? "proxy" : "http";
    return { kind, code: kind === "proxy" ? "PROXY_HTTP_407" : `HTTP_${status}`, status };
  }

  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null && !seen.has(current); depth += 1) {
    seen.add(current);
    chain.push(current);
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  const codes = chain.map((item) => typeof item === "object" && item !== null && "code" in item
    ? String((item as { code?: unknown }).code ?? "").toUpperCase()
    : "");
  const names = chain.map((item) => typeof item === "object" && item !== null && "name" in item
    ? String((item as { name?: unknown }).name ?? "")
    : "");
  const hints = chain.map((item) => item instanceof Error ? item.message : "");

  if (codes.some((code) => /PROXY|TUNNEL/.test(code)) || hints.some((message) => /proxy|tunnel/i.test(message))) {
    const code = codes.find((item) => /^ERR_(?:PROXY|TUNNEL)_[A-Z0-9_]+$/.test(item));
    return { kind: "proxy", code: code ?? "PROXY_CONNECT_FAILED" };
  }
  if (codes.some((code) => /^(?:ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/.test(code)) || names.some((name) => /timeout/i.test(name))) {
    const code = codes.find((item) => /^(?:ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/.test(item));
    return { kind: "timeout", code: code ? `TIMEOUT_${code}` : "TIMEOUT_EXCEEDED" };
  }
  if (codes.some((code) => /^(?:EAI_AGAIN|EAI_FAIL|EAI_NODATA|ENOTFOUND)$/.test(code)) || codes.some((code) => /^ERR_NAME_NOT_RESOLVED$/.test(code))) {
    const code = codes.find((item) => /^(?:EAI_AGAIN|EAI_FAIL|EAI_NODATA|ENOTFOUND|ERR_NAME_NOT_RESOLVED)$/.test(item));
    return { kind: "dns", code: `DNS_${code ?? "RESOLUTION_FAILED"}` };
  }
  if (codes.some((code) => /^(?:CERT_|ERR_TLS_|ERR_SSL_|ERR_OSSL_|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code))) {
    const code = codes.find((item) => /^(?:CERT_[A-Z0-9_]+|ERR_TLS_[A-Z0-9_]+|ERR_SSL_[A-Z0-9_]+|ERR_OSSL_[A-Z0-9_]+|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(item));
    return { kind: "tls", code: `TLS_${code ?? "HANDSHAKE_FAILED"}` };
  }
  if (codes.some((code) => /^(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET)$/.test(code))) {
    const code = codes.find((item) => /^(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET)$/.test(item));
    return { kind: "tcp", code: `TCP_${code}` };
  }
  return { kind: "tcp", code: "TCP_CONNECTION_FAILED" };
}

/** Machine-readable validation-failure categories for benchmark diagnostics. */
export type ValidationFailureCode =
  | "EMPTY_CONTENT"
  | "INVALID_JSON"
  | "INVALID_RESPONSE_SHAPE"
  | "MISSING_QUESTION"
  | "INVALID_CHOICE"
  | "MISSING_PROBABILITIES"
  | "INVALID_PROBABILITIES"
  | "OUTPUT_TRUNCATED"
  | "INPUT_TRUNCATED";

export class JevError extends Error {
  readonly status?: number;
  readonly body?: unknown;
  readonly code?: string;
  readonly transportDiagnostic?: TransportDiagnostic;

  constructor(message: string, options: JevErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    if (options.status !== undefined) this.status = options.status;
    if (options.body !== undefined) this.body = options.body;
    if (options.code !== undefined) this.code = options.code;
    if (options.transportDiagnostic !== undefined) this.transportDiagnostic = options.transportDiagnostic;
  }
}

/** 401: missing or invalid API key. Never retried. */
export class JevAuthError extends JevError {}

/** 422: the request body failed validation. Never retried. */
export class JevValidationError extends JevError {}

/** 429: rate limited. Retried with backoff, honoring `retry-after`. */
export class JevRateLimitError extends JevError {}

/** 403 with a quota/entitlement signal: upstream refused on quota or access policy. Never retried blindly. */
export class JevQuotaError extends JevError {}

/** 403 without a quota signal, or 401-class admission refusal: upstream denied access. Never retried. */
export class JevForbiddenError extends JevError {}

/** General provider HTTP failure carrying sanitized status/code metadata. Never includes secrets. */
export class JevProviderHttpError extends JevError {}

/** 529 (and 5xx): TypeSafe is overloaded. Retried with backoff. */
export class JevOverloadedError extends JevError {}

/** The request exceeded `timeoutMs`, or the caller's signal aborted it. */
export class JevTimeoutError extends JevError {}

/** The request never reached the API (DNS, TLS, socket). Retried. */
export class JevConnectionError extends JevError {}

/**
 * The API answered, but not in the documented shape: unparseable JSON, a
 * missing answer for a requested question id, or an answer whose `type` does
 * not match the question that asked for it.
 */
export class JevProtocolError extends JevError {}

/** Best-effort one-line summary for a tool result. Never includes a stack. */
export function describeError(error: unknown): string {
  if (error instanceof JevError) {
    const detail = formatBody(error.body);
    const status = error.status === undefined ? "" : ` (HTTP ${error.status})`;
    return detail ? `${error.message}${status}: ${detail}` : `${error.message}${status}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatBody(body: unknown): string {
  if (body === undefined || body === null) return "";
  const text = typeof body === "string" ? body : safeStringify(body);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
