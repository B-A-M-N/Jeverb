/**
 * Who may post a hook payload to the daemon.
 *
 * The daemon binds to loopback, so the threat is not the network: it is another
 * process on the same machine — a different local user, or anything that can
 * make an HTTP request — feeding the plugin tool calls it never saw, or reading
 * them back. The shared secret is the TypeSafe API key, because it is the one
 * value both ends already have: `hooks.json` interpolates it into the request
 * headers and `loadHookConfig` reads it in the daemon.
 *
 * Three headers, any of which is accepted:
 *
 *   Authorization: Bearer $CLAUDE_PLUGIN_OPTION_API_KEY
 *   X-Jev-Env-Key: $TYPESAFE_API_KEY
 *   X-Jev-Daemon-Token: $JEV_DAEMON_TOKEN
 *
 * The first two carry the provider key from the plugin option and the shell.
 * The third carries the daemon's own local capability token (a random secret
 * minted into the data directory), which authenticates loopback hook posts
 * without spending — or exposing — the provider key, and without requiring
 * any provider key to be configured at all. An empty credential is *absent*,
 * not wrong: treating it as wrong would lock out installs that set the key
 * in only one place.
 *
 * The daemon holds every key present in its environment plus its local token,
 * and accepts a credential matching any of them. The option and the shell can
 * legitimately hold different keys, and the hooks interpolate one of each, so
 * an install that rotated one half and not the other still has a daemon that
 * knows both. `auth: "none"` in `/v1/health` means even the token could not
 * be established (unwritable data directory) — every route is then open, and
 * the health output says so rather than implying otherwise.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** Header bag as `node:http` hands it over. */
export type Headers = Record<string, string | string[] | undefined>;

export type AuthMode = "key" | "none";

export function authMode(expectedKeys: readonly string[]): AuthMode {
  return expectedKeys.length === 0 ? "none" : "key";
}

/**
 * Header carrying the daemon's local capability token. Sent as
 * `X-Jev-Daemon-Token: $JEV_DAEMON_TOKEN` by hook transports that have it;
 * the Bearer slot stays reserved for provider keys.
 */
export const DAEMON_TOKEN_HEADER = "x-jev-daemon-token";

function header(headers: Headers, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value : undefined;
}

/**
 * Every credential the request offered, empties dropped.
 *
 * Exported because "an empty `Bearer ` counts as no credential at all" is the
 * subtle half of this module and deserves its own test.
 */
export function credentials(headers: Headers): string[] {
  const found: string[] = [];

  const authorization = header(headers, "authorization")?.trim();
  if (authorization !== undefined) {
    const match = /^Bearer\s*(.*)$/i.exec(authorization);
    const token = (match?.[1] ?? "").trim();
    if (token !== "") found.push(token);
  }

  const envKey = header(headers, "x-jev-env-key")?.trim();
  if (envKey !== undefined && envKey !== "") found.push(envKey);

  const daemonToken = header(headers, DAEMON_TOKEN_HEADER)?.trim();
  if (daemonToken !== undefined && daemonToken !== "") found.push(daemonToken);

  return found;
}

/** Constant-time comparison of two secrets of any length. */
function sameSecret(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

/**
 * The keys the daemon's environment holds, trimmed, empty ones dropped,
 * duplicates collapsed (first occurrence wins), in a fixed order.
 *
 * The plugin option, `JEV_PLUGIN_API_KEY` and the shell's `TYPESAFE_API_KEY`
 * are three places the same install can put a key, and the hooks interpolate
 * one of each into the two headers, so the daemon serves them all rather than
 * only the one `loadHookConfig` happened to pick.
 */
export function expectedKeysFrom(env: Record<string, string | undefined>): string[] {
  const keys: string[] = [];
  for (const raw of [env.CLAUDE_PLUGIN_OPTION_API_KEY, env.JEV_PLUGIN_API_KEY, env.TYPESAFE_API_KEY]) {
    const value = (raw ?? "").trim();
    if (value !== "" && !keys.includes(value)) keys.push(value);
  }
  return keys;
}

/**
 * The first 8 lowercase hex characters of `sha256(key)`.
 *
 * It identifies a key in a status line without revealing it: 32 bits of a hash
 * of a 100+ character secret is not a recovery path.
 */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8);
}

/**
 * True when the request may be served.
 *
 * No key held is unauthenticated mode and accepts everything; with keys held,
 * at least one non-empty credential has to match one of them.
 */
export function authorize(headers: Headers, expectedKeys: readonly string[]): boolean {
  if (expectedKeys.length === 0) return true;
  return matchedCredentialId(headers, expectedKeys) !== undefined;
}

/**
 * Full-length identity of one credential: `sha256(secret)` in hex.
 *
 * A session is bound to the id of the credential that created it (see
 * `registry.ts`), so a request naming session B while presenting the
 * credential that created session A cannot act as B. The id is a hash, never
 * the secret, and only ever compared with `timingSafeEqual` via `sameSecret`
 * on the preimage — but it must still never be logged or put in a response
 * body: `/v1/health` and `/v1/admin/sessions` expose 8-char fingerprints only.
 */
export function credentialId(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * The id of the held credential that authorized this request, if any.
 *
 * `undefined` means "no credential matched" — which in unauthenticated mode
 * (no keys held) is every request, so callers that bind sessions must use the
 * literal `"none"` there rather than `undefined`, or unbound sessions would
 * compare unequal to their own creator.
 */
export function matchedCredentialId(headers: Headers, expectedKeys: readonly string[]): string | undefined {
  for (const candidate of credentials(headers)) {
    for (const key of expectedKeys) {
      if (sameSecret(candidate, key)) return credentialId(key);
    }
  }
  return undefined;
}

/**
 * Header carrying the separate administrative capability.
 *
 * Session and hook credentials authorize lifecycle and hook-submission for
 * the sessions they created; they never authorize administration. Admin
 * routes (`/v1/admin/*`) accept only this header against the daemon's own
 * admin token, minted into the data directory beside the daemon token.
 */
export const ADMIN_TOKEN_HEADER = "x-jev-admin-token";

/**
 * True when the request carries the daemon's admin capability.
 *
 * A missing or empty configured token never authorizes: unlike the session
 * routes there is no legacy mode in which administration is open, so an
 * unconfigured daemon answers every admin route 401 rather than falling
 * back to another credential.
 */
export function authorizeAdmin(headers: Headers, adminToken: string | undefined): boolean {
  if (adminToken === undefined || adminToken.trim() === "") return false;
  const presented = header(headers, ADMIN_TOKEN_HEADER)?.trim();
  if (presented === undefined || presented === "") return false;
  return sameSecret(presented, adminToken);
}
