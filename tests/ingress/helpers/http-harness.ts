import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handleStop } from "../../../src/hooks/handlers/stop.js";
import { handleUserPromptSubmit } from "../../../src/hooks/handlers/user-prompt-submit.js";
import { hookInputFromCanonical, type CanonicalEvent } from "../../../src/ingress/event-contract.js";
import { verifyEnvelope } from "../../../src/ingress/signed-transport.js";
import type { Deps, HookOutput } from "../../../src/hooks/types.js";

/**
 * Test-only loopback HTTP harness for the calibration slice. It speaks the
 * signed envelope protocol and dispatches verified canonical events to the
 * REAL handlers — the same functions the native path calls. Nothing here is
 * production code: no listener is opened outside tests, and the signing
 * secrets are generated per run (never the live provider secret).
 */
export interface Harness {
  url: string;
  seenEventIds: Set<string>;
  close(): Promise<void>;
  post(
    event: CanonicalEvent,
    overrides?: { signature?: string; timestamp?: string; eventId?: string; rawBody?: string },
  ): Promise<{ status: number; body: unknown }>;
}

export async function startHarness(
  secret: Buffer,
  dispatch: (event: CanonicalEvent) => Promise<HookOutput | undefined>,
): Promise<Harness> {
  const seenEventIds = new Set<string>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/v1/ingress/event") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end("{}");
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const envelope = {
          rawBody,
          signature: String(req.headers["x-jevrb-signature"] ?? ""),
          timestamp: String(req.headers["x-jevrb-timestamp"] ?? ""),
          eventId: String(req.headers["x-jevrb-event-id"] ?? ""),
        };
        const verdict = verifyEnvelope(secret, envelope, { seenEventIds });
        if (!verdict.ok) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, reason: verdict.reason }));
          return;
        }
        let event: CanonicalEvent;
        try {
          event = JSON.parse(rawBody) as CanonicalEvent;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, reason: "malformed event body" }));
          return;
        }
        // The dedupe key (header) and the correlation id (body) must agree:
        // two ids for one delivery is a confused-deputy gap.
        if (
          event !== null &&
          typeof event === "object" &&
          "eventId" in event &&
          typeof (event as { eventId?: unknown }).eventId === "string" &&
          (event as { eventId: string }).eventId !== envelope.eventId
        ) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, reason: "event id mismatch" }));
          return;
        }
        if (event === null || typeof event !== "object" || (event.kind !== "user-prompt-submit" && event.kind !== "stop")) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, reason: "unknown event kind" }));
          return;
        }
        const output = await dispatch(event);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, output: output ?? null }));
      } catch {
        try {
          res.writeHead(500, { "content-type": "application/json" });
          res.end("{}");
        } catch {
          // Already closed.
        }
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/v1/ingress/event`;
  return {
    url,
    seenEventIds,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    post: async (event, overrides = {}) => {
      const { signEnvelope } = await import("../../../src/ingress/signed-transport.js");
      const body = overrides.rawBody ?? JSON.stringify(event);
      let headerEventId = overrides.eventId;
      if (headerEventId === undefined) {
        try {
          const parsed = JSON.parse(body) as { eventId?: unknown };
          if (typeof parsed.eventId === "string" && parsed.eventId !== "") headerEventId = parsed.eventId;
        } catch {
          // Malformed bodies keep a random header id; verification fails on signature anyway.
        }
      }
      const eventId = headerEventId ?? `evt-${Math.random().toString(36).slice(2)}`;
      const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
      const signature = overrides.signature ?? signEnvelope(secret, timestamp, eventId, body);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-jevrb-signature": signature,
          "x-jevrb-timestamp": timestamp,
          "x-jevrb-event-id": eventId,
        },
        body,
      });
      return { status: response.status, body: (await response.json()) as unknown };
    },
  };
}

/** Dispatch to the real handlers — the native path calls these same functions. */
export function dispatchToHandlers(deps: Deps): (event: CanonicalEvent) => Promise<HookOutput | undefined> {
  return (event) => {
    const input = hookInputFromCanonical(event);
    if (event.kind === "user-prompt-submit") return handleUserPromptSubmit(input, deps);
    return handleStop(input, deps);
  };
}
