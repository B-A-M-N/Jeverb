import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed-transport primitives for the HTTP calibration harness.
 *
 * HMAC-SHA256 over `timestamp + "." + eventId + "." + rawBody`, sent as
 * `x-jevrb-signature` (hex) with `x-jevrb-timestamp` (epoch seconds) and
 * `x-jevrb-event-id`. Verification is fail-closed: any missing, malformed,
 * expired, replayed, or mismatched input rejects before parsing the body.
 *
 * Test secrets only: every caller generates its own secret with
 * `randomBytes` per run. The live provider-dashboard secret is never
 * wired here, never read here, and must never appear in a test.
 */
export interface SignedEnvelope {
  rawBody: string;
  signature: string;
  timestamp: string;
  eventId: string;
}

export function signEnvelope(secret: Buffer, timestamp: string, eventId: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${eventId}.${rawBody}`, "utf8").digest("hex");
}

export interface VerifyOptions {
  /** Maximum accepted age in seconds. Unsigned or absurd timestamps fail. */
  maxAgeSeconds?: number;
  /** Caller-owned set of already-seen event IDs for replay protection. */
  seenEventIds?: Set<string>;
  /** Clock in epoch seconds (injectable for tests). */
  nowSeconds?: () => number;
}

export function verifyEnvelope(
  secret: Buffer,
  envelope: SignedEnvelope,
  options: VerifyOptions = {},
): { ok: true } | { ok: false; reason: string } {
  const { maxAgeSeconds = 300, seenEventIds, nowSeconds = () => Date.now() / 1000 } = options;
  if (envelope.signature === "" || envelope.timestamp === "" || envelope.eventId === "") {
    return { ok: false, reason: "missing signature fields" };
  }
  if (!/^[0-9a-f]{64}$/i.test(envelope.signature)) {
    return { ok: false, reason: "malformed signature" };
  }
  const timestamp = Number(envelope.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { ok: false, reason: "malformed timestamp" };
  }
  const age = nowSeconds() - timestamp;
  if (age < -30 || age > maxAgeSeconds) {
    return { ok: false, reason: "stale or future timestamp" };
  }
  if (seenEventIds !== undefined) {
    if (seenEventIds.has(envelope.eventId)) return { ok: false, reason: "replayed event id" };
  }
  const expected = signEnvelope(secret, envelope.timestamp, envelope.eventId, envelope.rawBody);
  const actual = Buffer.from(envelope.signature, "hex");
  const want = Buffer.from(expected, "hex");
  if (actual.length !== want.length || !timingSafeEqual(actual, want)) {
    return { ok: false, reason: "signature mismatch" };
  }
  if (seenEventIds !== undefined) seenEventIds.add(envelope.eventId);
  return { ok: true };
}

/** Test-only secret generation. Never substitute a live provider secret. */
export function generateTestSecret(): Buffer {
  return randomBytes(32);
}
