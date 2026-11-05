import { describe, expect, it } from "vitest";
import {
  generateTestSecret,
  signEnvelope,
  verifyEnvelope,
} from "../../src/ingress/signed-transport.js";

/** Pure transport unit coverage: no server, no handlers, no secret reuse. */
describe("signed envelope verification", () => {
  it("accepts a well-formed envelope", () => {
    const secret = generateTestSecret();
    const envelope = { rawBody: `{"kind":"stop"}`, signature: "", timestamp: "1700000000", eventId: "e1" };
    envelope.signature = signEnvelope(secret, envelope.timestamp, envelope.eventId, envelope.rawBody);
    expect(verifyEnvelope(secret, envelope, { nowSeconds: () => 1700000100 })).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    const secret = generateTestSecret();
    const signature = signEnvelope(secret, "1700000000", "e1", `{"kind":"stop"}`);
    const verdict = verifyEnvelope(
      secret,
      { rawBody: `{"kind":"stop","extra":true}`, signature, timestamp: "1700000000", eventId: "e1" },
      { nowSeconds: () => 1700000100 },
    );
    expect(verdict).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("rejects a wrong secret without distinguishing why", () => {
    const verdict = verifyEnvelope(
      generateTestSecret(),
      {
        rawBody: "{}",
        signature: signEnvelope(generateTestSecret(), "1700000000", "e1", "{}"),
        timestamp: "1700000000",
        eventId: "e1",
      },
      { nowSeconds: () => 1700000100 },
    );
    expect(verdict).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("rejects stale and future timestamps", () => {
    const secret = generateTestSecret();
    const now = 1700000000;
    const stale = {
      rawBody: "{}",
      signature: "",
      timestamp: String(now - 301),
      eventId: "e1",
    };
    stale.signature = signEnvelope(secret, stale.timestamp, stale.eventId, stale.rawBody);
    expect(verifyEnvelope(secret, stale, { nowSeconds: () => now })).toEqual({
      ok: false,
      reason: "stale or future timestamp",
    });
    const future = { ...stale, timestamp: String(now + 31) };
    future.signature = signEnvelope(secret, future.timestamp, future.eventId, future.rawBody);
    expect(verifyEnvelope(secret, future, { nowSeconds: () => now })).toEqual({
      ok: false,
      reason: "stale or future timestamp",
    });
  });

  it("rejects malformed fields before any crypto", () => {
    const secret = generateTestSecret();
    expect(verifyEnvelope(secret, { rawBody: "{}", signature: "", timestamp: "1", eventId: "e" })).toEqual({
      ok: false,
      reason: "missing signature fields",
    });
    expect(
      verifyEnvelope(secret, { rawBody: "{}", signature: "zz", timestamp: "1", eventId: "e" }),
    ).toEqual({ ok: false, reason: "malformed signature" });
    expect(
      verifyEnvelope(secret, { rawBody: "{}", signature: "a".repeat(64), timestamp: "soon", eventId: "e" }),
    ).toEqual({ ok: false, reason: "malformed timestamp" });
  });

  it("rejects a replayed event id exactly once", () => {
    const secret = generateTestSecret();
    const seen = new Set<string>();
    const envelope = { rawBody: "{}", signature: "", timestamp: "1700000000", eventId: "e-once" };
    envelope.signature = signEnvelope(secret, envelope.timestamp, envelope.eventId, envelope.rawBody);
    expect(verifyEnvelope(secret, envelope, { seenEventIds: seen, nowSeconds: () => 1700000100 })).toEqual({
      ok: true,
    });
    expect(verifyEnvelope(secret, envelope, { seenEventIds: seen, nowSeconds: () => 1700000100 })).toEqual({
      ok: false,
      reason: "replayed event id",
    });
  });
});
