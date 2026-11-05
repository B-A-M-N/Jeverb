/**
 * The daemon's HTTP surface: who gets in, what gets rejected, and what happens
 * when a handler misbehaves.
 *
 * Every test binds `port: 0`. Nothing in this suite may touch 10522, because
 * that is where a real daemon on the developer's machine lives and a test that
 * killed it — or worse, answered its hooks — would be a test that changed the
 * behaviour of the session running it.
 *
 * The deadline test uses a real 60 ms wall clock rather than fake timers:
 * `node:http` is driven by the real event loop, so freezing time freezes the
 * request too and the test would measure nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionModel, EvaluateResult, Question } from "../../src/decision/types.js";
import {
  authorize,
  authorizeAdmin,
  credentialId,
  credentials,
  expectedKeysFrom,
  keyFingerprint,
} from "../../src/hooks/daemon/auth.js";
import { SessionRegistry, sessionConfigOf } from "../../src/hooks/daemon/registry.js";
import { daemonTokenPath, loadOrMintDaemonToken } from "../../src/hooks/daemon/state-file.js";
import { MAX_BODY_BYTES, PROTOCOL, startDaemon, type DaemonHandle } from "../../src/hooks/daemon/server.js";
import type { Deps } from "../../src/hooks/types.js";
import { HOOK_VERSION } from "../../src/hooks/version.js";
import { FakeModel, noul, score } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";
import { testStore } from "../helpers/control-state.js";
import { setTestSwitch } from "../helpers/control-state.js";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY = "sk-test-key";
const NOW = 1_700_000_000_000;

const PRE = {
  session_id: "s1",
  cwd: "/home/dev/project",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf ~/" },
};

let dir: string;
const handles: DaemonHandle[] = [];

beforeEach(() => {
  dir = tempDir();
});

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle !== undefined) await handle.close();
  }
  cleanup(dir);
});

interface StartOptions {
  expectedKeys?: readonly string[];
  model?: DecisionModel | null;
  depsFor?: (sessionId: string) => Deps;
  registry?: SessionRegistry;
  idleMs?: number;
  lastSessionGraceMs?: number;
  wallClockMs?: number;
  onExitRequested?: () => void;
  dataDir?: string;
  allowedDataRoots?: readonly string[];
  adminToken?: string;
}

async function start(options: StartOptions = {}): Promise<{
  handle: DaemonHandle;
  registry: SessionRegistry;
  deps: Deps;
}> {
  const deps = makeDeps(dir, { model: options.model ?? null, now: NOW });
  const registry = options.registry ?? new SessionRegistry(() => NOW);
  const dataDir = options.dataDir ?? dir;
  const handle = await startDaemon({
    port: 0,
    expectedKeys: options.expectedKeys === undefined ? [KEY] : options.expectedKeys,
    dataDir,
    masterSwitchPath: deps.config.masterSwitchPath,
    requireRootOwnedMasterSwitch: false,
    allowedDataRoots: options.allowedDataRoots ?? [dataDir],
    ...(options.adminToken === undefined ? {} : { adminToken: options.adminToken }),
    depsFor: options.depsFor ?? ((): Deps => deps),
    registry,
    onExitRequested: options.onExitRequested ?? ((): void => undefined),
    idleMs: options.idleMs ?? 0,
    lastSessionGraceMs: options.lastSessionGraceMs ?? 0,
    ...(options.wallClockMs !== undefined ? { wallClockMs: options.wallClockMs } : {}),
  });
  handles.push(handle);
  return { handle, registry, deps };
}

async function hook(
  port: number,
  event: string,
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${KEY}` },
): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/hook/${event}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function health(port: number): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function waitFor(predicate: () => boolean, budgetMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + budgetMs;
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timed out waiting for a condition"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

// ------------------------------------------------------------------- health

describe("GET /v1/health", () => {
  it("answers without a credential and identifies itself as jev", async () => {
    const { handle } = await start();
    const body = await health(handle.port);
    expect(body.jev).toBe(true);
    expect(body.pid).toBe(process.pid);
    expect(body.port).toBe(handle.port);
    expect(body.version).toBe(HOOK_VERSION);
    expect(body.protocol).toBe(PROTOCOL);
    expect(body.auth).toBe("key");
    expect(typeof body.started_at).toBe("number");
    expect(typeof body.uptime_ms).toBe("number");
    expect(body.sessions).toBe(0);
    expect(body.counters).toBeDefined();
    expect(body.counters).not.toHaveProperty("session_auth");
  });

  it("contains no secret of any kind", async () => {
    const { handle } = await start();
    const text = JSON.stringify(await health(handle.port));
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("api_key");
  });

  it("says auth none when there is no key anywhere", async () => {
    const { handle } = await start({ expectedKeys: [] });
    const body = await health(handle.port);
    expect(body.auth).toBe("none");
    expect(body.key_fingerprints).toEqual([]);
  });

  it("lists a fingerprint for each key it holds, and still no key itself", async () => {
    const { handle } = await start({ expectedKeys: [KEY, "sk-other-key"] });
    const body = await health(handle.port);
    expect(body.auth).toBe("key");
    expect(body.key_fingerprints).toEqual([KEY, "sk-other-key"].map(keyFingerprint));
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(JSON.stringify(body)).not.toContain("sk-other-key");
  });

  it("refuses anything but GET", async () => {
    const { handle } = await start();
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/health`, { method: "POST" });
    expect(response.status).toBe(405);
  });
});

// --------------------------------------------------------------------- auth

describe("authorization", () => {
  it("accepts the bearer form", async () => {
    const { handle } = await start();
    expect((await hook(handle.port, "PreToolUse", PRE)).status).toBe(200);
  });

  it("accepts the env-key header form", async () => {
    const { handle } = await start();
    const reply = await hook(handle.port, "PreToolUse", PRE, { "x-jev-env-key": KEY });
    expect(reply.status).toBe(200);
  });

  it("accepts an empty bearer alongside a good env key", async () => {
    // The real shape of an install that set the key in the shell but not in the
    // plugin's options: `Bearer ` with nothing after it, plus the env header.
    const { handle } = await start();
    const reply = await hook(handle.port, "PreToolUse", PRE, {
      authorization: "Bearer ",
      "x-jev-env-key": KEY,
    });
    expect(reply.status).toBe(200);
  });

  it("accepts any one of the keys it holds, in either header", async () => {
    // The option and the shell can hold different keys, and the hooks
    // interpolate one of each, so either alone has to get in.
    const { handle } = await start({ expectedKeys: ["option-key", "env-key"] });
    expect(
      (await hook(handle.port, "PreToolUse", PRE, { authorization: "Bearer option-key" })).status,
    ).toBe(200);
    expect((await hook(handle.port, "PreToolUse", PRE, { "x-jev-env-key": "env-key" })).status).toBe(200);
    const wrong = await hook(handle.port, "PreToolUse", PRE, { authorization: "Bearer other" });
    expect(wrong.status).toBe(200);
    expect(wrong.text).toBe("{}");
    expect(handle.stats().unauthorized).toBe(1);
  });

  it("answers 200 {} to a wrong key on a hook route, and 401 to the same key on a session route", async () => {
    const { handle } = await start();
    for (const headers of [{ authorization: "Bearer wrong" }, {}, { authorization: "Bearer " }]) {
      const reply = await hook(handle.port, "PreToolUse", PRE, headers);
      // Claude Code shows any non-2xx from an http hook to the user as a hook
      // error, so the refusal is answered in silence and counted instead.
      expect(reply.status, JSON.stringify(headers)).toBe(200);
      expect(reply.text, JSON.stringify(headers)).toBe("{}");
    }
    expect(handle.stats().unauthorized).toBe(3);
    // The session routes keep their real status: `/v1/session/start` uses a
    // 401 from them to recognise a stale daemon.
    const session = await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(session.status).toBe(401);
    expect(await session.text()).toBe("{}");
  });

  it("serves everything when no key is configured", async () => {
    const { handle } = await start({ expectedKeys: [] });
    expect((await hook(handle.port, "PreToolUse", PRE, {})).status).toBe(200);
  });

  it("leaves health unauthenticated even with a key set", async () => {
    const { handle } = await start();
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/health`);
    expect(response.status).toBe(200);
  });

  it("rejects a keyless hook post even when the body names a registered session", async () => {
    // The impersonation case: the session was legitimately registered with
    // a credential, but this post carries none. A session id is correlation,
    // never a credential — knowing "s1" must not buy service.
    const { handle } = await start({ expectedKeys: [KEY] });
    const session = await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(session.status).toBe(200);
    const reply = await hook(handle.port, "PreToolUse", PRE, {});
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("{}");
    expect(handle.stats().hooks.PreToolUse).toBeUndefined();
    expect(handle.stats().unauthorized).toBe(1);
  });

  it("rejects a keyless hook post naming an unknown session", async () => {
    const { handle } = await start({ expectedKeys: [KEY] });
    const reply = await hook(handle.port, "PreToolUse", { ...PRE, session_id: "nobody" }, {});
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("{}");
    expect(handle.stats().hooks.PreToolUse).toBeUndefined();
    expect(handle.stats().unauthorized).toBe(1);
  });

  it("a registered session does not open the session routes", async () => {
    const { handle } = await start({ expectedKeys: [KEY] });
    const startResp = await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(startResp.status).toBe(401);
    const endResp = await fetch(`http://127.0.0.1:${handle.port}/v1/session/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(endResp.status).toBe(401);
  });

  it("rejects a rotated token and serves its replacement", async () => {
    // Rotation happens when the token file loses its private ownership, not
    // through any request: the daemon holds whatever it started with, so a
    // rotated-out token must stop working without a daemon restart being the
    // thing that revokes it — the new daemon simply never held the old one.
    const first = loadOrMintDaemonToken(dir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const before = await start({ expectedKeys: [first as string] });
    expect((await hook(before.handle.port, "PreToolUse", PRE, { "x-jev-daemon-token": first as string })).status).toBe(
      200,
    );
    expect(before.handle.stats().hooks.PreToolUse).toBe(1);
    chmodSync(daemonTokenPath(dir), 0o644);
    const second = loadOrMintDaemonToken(dir);
    expect(second).not.toBe(first);
    const after = await start({ expectedKeys: [second as string] });
    const stale = await hook(after.handle.port, "PreToolUse", PRE, { "x-jev-daemon-token": first as string });
    expect(stale.status).toBe(200);
    expect(stale.text).toBe("{}");
    expect(after.handle.stats().hooks.PreToolUse).toBeUndefined();
    expect(after.handle.stats().unauthorized).toBe(1);
    const fresh = await hook(after.handle.port, "PreToolUse", PRE, { "x-jev-daemon-token": second as string });
    expect(fresh.status).toBe(200);
    expect(after.handle.stats().hooks.PreToolUse).toBe(1);
  });

  it("an ended session grants nothing to keyless posts, and revokes nothing from keyed ones", async () => {
    const { handle } = await start({ expectedKeys: [KEY] });
    const headers = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
    const startResp = await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(startResp.status).toBe(200);
    const endResp = await fetch(`http://127.0.0.1:${handle.port}/v1/session/end`, {
      method: "POST",
      headers,
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(endResp.status).toBe(200);
    // Stale session, no credential: still rejected. Session lifecycle never
    // mints authority; it only scopes configuration.
    const keyless = await hook(handle.port, "PreToolUse", PRE, {});
    expect(keyless.text).toBe("{}");
    expect(handle.stats().hooks.PreToolUse).toBeUndefined();
    // Stale session, valid credential: still served. Ending a session stops
    // its configuration from applying, not the credential from working.
    const keyed = await hook(handle.port, "PreToolUse", PRE);
    expect(keyed.status).toBe(200);
    expect(handle.stats().hooks.PreToolUse).toBe(1);
  });

  it("serves a repeated keyed post twice without counting a rejection", async () => {
    // No replay protection is claimed at this layer — identical bodies are
    // independent requests — so a retry with the same credential must not be
    // mistaken for an attack.
    const { handle } = await start({ expectedKeys: [KEY] });
    expect((await hook(handle.port, "PreToolUse", PRE)).status).toBe(200);
    expect((await hook(handle.port, "PreToolUse", PRE)).status).toBe(200);
    expect(handle.stats().hooks.PreToolUse).toBe(2);
    expect(handle.stats().unauthorized).toBe(0);
  });

  it("an oversize keyless body is refused before any credential check", async () => {
    const { handle } = await start({ expectedKeys: [KEY] });
    const big = `{"session_id":"s1","pad":"${"a".repeat(MAX_BODY_BYTES + 1024)}"}`;
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/hook/PreToolUse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: big,
    }).catch(() => undefined);
    if (response !== undefined) {
      expect([413, 200]).toContain(response.status);
      if (response.status === 200) expect(await response.text()).toBe("{}");
    }
    await waitFor(() => handle.stats().oversize === 1);
    expect(handle.stats().unauthorized).toBe(0);
  });
});

describe("authorize", () => {
  it("treats an empty bearer as absent rather than as wrong", () => {
    expect(credentials({ authorization: "Bearer " })).toEqual([]);
    expect(credentials({ authorization: "Bearer" })).toEqual([]);
    expect(credentials({ authorization: "Bearer abc" })).toEqual(["abc"]);
    expect(credentials({ "x-jev-env-key": "" })).toEqual([]);
    expect(credentials({ authorization: "bearer abc", "x-jev-env-key": "def" })).toEqual(["abc", "def"]);
  });

  it("compares secrets of different lengths without throwing", () => {
    // `timingSafeEqual` rejects buffers of unequal length, which is why this
    // hashes first. A key one character longer must simply not match.
    expect(authorize({ authorization: "Bearer short" }, ["a-much-longer-key"])).toBe(false);
    expect(authorize({ authorization: `Bearer ${"x".repeat(500)}` }, ["y"])).toBe(false);
  });

  it("accepts anything in unauthenticated mode, including nothing", () => {
    expect(authorize({}, [])).toBe(true);
    expect(authorize({ authorization: "Bearer junk" }, [])).toBe(true);
  });

  it("accepts a credential matching any held key", () => {
    expect(authorize({ authorization: "Bearer one" }, ["one", "two"])).toBe(true);
    expect(authorize({ "x-jev-env-key": "two" }, ["one", "two"])).toBe(true);
    expect(authorize({ authorization: "Bearer three" }, ["one", "two"])).toBe(false);
    expect(authorize({}, ["one", "two"])).toBe(false);
  });

  it("accepts the daemon token header as a credential", () => {
    expect(credentials({ "x-jev-daemon-token": "tok" })).toEqual(["tok"]);
    expect(credentials({ "x-jev-daemon-token": "" })).toEqual([]);
    expect(authorize({ "x-jev-daemon-token": "tok" }, ["key", "tok"])).toBe(true);
    expect(authorize({ "x-jev-daemon-token": "nope" }, ["key", "tok"])).toBe(false);
  });

  it("serves a hook post carrying only the daemon token", async () => {
    const { handle } = await start({ expectedKeys: [KEY, "toktok"] });
    const reply = await hook(handle.port, "PreToolUse", PRE, { "x-jev-daemon-token": "toktok" });
    expect(reply.status).toBe(200);
    expect(handle.stats().hooks.PreToolUse).toBe(1);
    expect(handle.stats().unauthorized).toBe(0);
  });

  it("does not leak the key through a fingerprint", () => {
    for (const key of ["abc", KEY]) {
      expect(keyFingerprint(key)).toMatch(/^[0-9a-f]{8}$/);
    }
    expect(keyFingerprint("abc")).not.toBe(keyFingerprint("abd"));
  });

  it("reads every key the environment holds, in order, trimmed and de-duplicated", () => {
    expect(expectedKeysFrom({ CLAUDE_PLUGIN_OPTION_API_KEY: " a ", JEV_PLUGIN_API_KEY: "", TYPESAFE_API_KEY: "a" })).toEqual(["a"]);
    expect(expectedKeysFrom({})).toEqual([]);
    expect(expectedKeysFrom({ TYPESAFE_API_KEY: "b", CLAUDE_PLUGIN_OPTION_API_KEY: "a" })).toEqual(["a", "b"]);
    expect(expectedKeysFrom({ JEV_PLUGIN_API_KEY: "j", TYPESAFE_API_KEY: "j" })).toEqual(["j"]);
  });
});

describe("daemon capability token", () => {
  it("mints a stable 0600 token on first use", () => {
    const token = loadOrMintDaemonToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrMintDaemonToken(dir)).toBe(token);
    expect(statSync(daemonTokenPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("rotates a token file with unsafe permissions instead of trusting it", () => {
    const first = loadOrMintDaemonToken(dir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(daemonTokenPath(dir), "deadbeef\n");
    chmodSync(daemonTokenPath(dir), 0o644);
    const second = loadOrMintDaemonToken(dir);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe("deadbeef");
    expect(second).not.toBe(first);
    expect(readFileSync(daemonTokenPath(dir), "utf8").trim()).toBe(second);
  });

  it("reports the token mode in health without revealing it", async () => {
    const { handle } = await start({ expectedKeys: ["toktok"] });
    const body = await health(handle.port);
    expect(body.auth).toBe("key");
    expect(body.daemon_token).toBe(false);
  });
});

// ------------------------------------------------------------------ routing

describe("routing", () => {
  it("answers 200 {} to an event it has no handler for, and counts it", async () => {
    const { handle } = await start();
    const reply = await hook(handle.port, "NoSuchEvent", PRE);
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("{}");
    expect(handle.stats().unknown_event).toBe(1);
  });

  it("404s an unknown path", async () => {
    const { handle } = await start();
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/nope`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  it("200s a GET on a hook route, which is not POST and not a session route", async () => {
    const { handle } = await start();
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/hook/PreToolUse`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{}");
  });

  it("has a route for every handler, including the Approval label", async () => {
    const { handle } = await start({ expectedKeys: [] });
    for (const event of [
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "Approval",
      "UserPromptSubmit",
      "Stop",
      "SubagentStop",
      "SessionStart",
      "SessionEnd",
    ]) {
      const reply = await hook(handle.port, event, { session_id: "s1" }, {});
      expect(reply.status, event).toBe(200);
    }
  });

  it("answers 200 {} to a hook caller on a different protocol, and still 409s one on a session route", async () => {
    const { handle } = await start();
    const reply = await hook(handle.port, "PreToolUse", PRE, {
      authorization: `Bearer ${KEY}`,
      "x-jev-protocol": "99",
    });
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("{}");
    expect(handle.stats().protocol_mismatch).toBe(1);
    const session = await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${KEY}`,
        "x-jev-protocol": "99",
      },
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(session.status).toBe(409);
  });

  it("accepts the matching protocol, and an absent one", async () => {
    const { handle } = await start();
    expect(
      (await hook(handle.port, "PreToolUse", PRE, {
        authorization: `Bearer ${KEY}`,
        "x-jev-protocol": String(PROTOCOL),
      })).status,
    ).toBe(200);
    expect((await hook(handle.port, "PreToolUse", PRE)).status).toBe(200);
  });

  it("checks the route before authorization, so an unknown hook path is counted as unknown event", async () => {
    const { handle } = await start();
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/hook/NoSuchEvent`, {
      method: "POST",
      body: "{}",
    });
    // A hook route answers every refusal `200 {}`; the counter is the record.
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{}");
    expect(handle.stats().unknown_event).toBe(1);
    expect(handle.stats().unauthorized).toBe(0);
  });
});

// --------------------------------------------------------------------- body

describe("the request body", () => {
  it("answers `{}` to garbage rather than a 400, which would land in a debug log", async () => {
    const { handle } = await start();
    for (const body of ["", "   ", "not json", "{", "[]", "null", "42", '"a string"', '{"tool_name":']) {
      const reply = await hook(handle.port, "PreToolUse", body);
      expect(reply.status, body).toBe(200);
      expect(reply.text, body).toBe("{}");
    }
    expect(handle.stats().bad_request).toBe(9);
  });

  it("413s a body over 4 MB without buffering it", async () => {
    const { handle } = await start();
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/hook/PreToolUse`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: `{"session_id":"s1","pad":"${"a".repeat(MAX_BODY_BYTES + 1024)}"}`,
    }).catch(() => undefined);
    // The daemon answers 413 and destroys the request, so undici may surface
    // either the response or a broken pipe. Either is fail-open; what matters
    // is that the daemon counted it and stayed up.
    if (response !== undefined) expect([413, 200]).toContain(response.status);
    await waitFor(() => handle.stats().oversize === 1);
    expect((await health(handle.port)).jev).toBe(true);
  });

  it("accepts a large but legal body", async () => {
    const { handle } = await start();
    const reply = await hook(handle.port, "PreToolUse", {
      ...PRE,
      tool_input: { command: `echo ${"x".repeat(100_000)}` },
    });
    expect(reply.status).toBe(200);
  });
});

// ----------------------------------------------------------------- handlers

describe("serving hooks", () => {
  it("suppresses daemon hook dispatch and state mutation while install-wide OFF is set", async () => {
    const { handle, deps, registry } = await start({ dataDir: dir });
    deps.store.append({ ts: new Date(NOW).toISOString(), session_id: "seed", event: "seed", decision: "seed" });
    setTestSwitch(dir, "OFF");
    const before = readFileSync(deps.store.logPath, "utf8");
    const reply = await hook(handle.port, "PreToolUse", PRE);
    expect(reply).toEqual({ status: 200, text: "{}" });
    expect(registry.count()).toBe(0);
    expect(readFileSync(deps.store.logPath, "utf8")).toBe(before);
  });

  it("denies a hard pattern with the tripwire text", async () => {
    const { handle } = await start();
    const reply = await hook(handle.port, "PreToolUse", PRE);
    const parsed = JSON.parse(reply.text) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("[jev] tripwire t-");
  });

  it("reports the model stack's counters in health, not just the server's", async () => {
    // The server never calls Jev, so without this the `jev_calls` and
    // `memo_hits` in `/v1/health` would read a confident zero forever.
    const deps = makeDeps(dir, { now: NOW });
    const handle = await startDaemon({
      port: 0,
      expectedKeys: [],
      depsFor: (): Deps => deps,
      registry: new SessionRegistry(() => NOW),
      onExitRequested: () => undefined,
      idleMs: 0,
      lastSessionGraceMs: 0,
      modelStats: () => ({ jev_calls: 9, memo_hits: 4, jev_timeouts: 1, jev_errors: 2 }),
    });
    handles.push(handle);

    const counters = (await health(handle.port)).counters as Record<string, number>;
    expect(counters.jev_calls).toBe(9);
    expect(counters.memo_hits).toBe(4);
    expect(counters.jev_timeouts).toBe(1);
    expect(counters.jev_errors).toBe(2);
    expect(handle.stats().memo_hits).toBe(4);
    // And the server's own counters are not clobbered by the merge.
    await hook(handle.port, "PreToolUse", { ...PRE, tool_input: { command: "ls -la" } }, {});
    expect(handle.stats().hooks).toEqual({ PreToolUse: 1 });
  });

  it("counts hooks by event", async () => {
    const { handle } = await start();
    await hook(handle.port, "PreToolUse", { ...PRE, tool_input: { command: "ls -la" } });
    await hook(handle.port, "PreToolUse", { ...PRE, tool_input: { command: "ls -la" } });
    await hook(handle.port, "Stop", { session_id: "s1", last_assistant_message: "done" });
    expect(handle.stats().hooks).toEqual({ PreToolUse: 2, Stop: 1 });
  });

  it("answers `{}` and does its bookkeeping afterwards for Approval", async () => {
    const { handle, deps } = await start();
    deps.store.rememberReissue("s1", { tool_use_id: "call-1", ts: 0, tool_name: "Bash", trip_id: "t-aaaaaaaa" });
    const reply = await hook(handle.port, "Approval", {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "call-1",
    });
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("{}");
    // The reply came first; the log line arrives on a later turn of the loop.
    await waitFor(() => deps.store.readLog().some((r) => r.decision === "reissue-ran"));
  });

  it("answers `{}` when a handler overruns the wall clock, and counts the overrun", async () => {
    const never: DecisionModel = {
      name: "never",
      evaluate: async <Q extends Record<string, Question>>(): Promise<EvaluateResult<Q>> =>
        new Promise<EvaluateResult<Q>>(() => undefined),
      choice: async () => new Promise(() => undefined),
      score: async () => new Promise(() => undefined),
      probability: async () => new Promise(() => undefined),
    };
    const { handle } = await start({ model: never, wallClockMs: 60 });
    const started = Date.now();
    const reply = await hook(handle.port, "PreToolUse", {
      ...PRE,
      tool_input: { command: "curl -X POST https://example.com/pay" },
    });
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("{}");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(handle.stats().deadline_overruns).toBe(1);
  });

  it("survives a handler that throws", async () => {
    const throws: DecisionModel = {
      name: "throws",
      evaluate: async () => {
        throw new Error("boom");
      },
      choice: async () => {
        throw new Error("boom");
      },
      score: async () => {
        throw new Error("boom");
      },
      probability: async () => {
        throw new Error("boom");
      },
    };
    const { handle } = await start({ model: throws });
    // The handler catches its own model errors and fails open, so this is a 200
    // with nothing in it rather than a 500 — and the daemon is still up after.
    const reply = await hook(handle.port, "PreToolUse", {
      ...PRE,
      tool_input: { command: "curl -X POST https://example.com/pay" },
    });
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("{}");
    expect((await health(handle.port)).jev).toBe(true);
  });
});

// ------------------------------------------------------------ session state

describe("per-session configuration", () => {
  it("judges a session with the config it registered, not the daemon's", async () => {
    const registry = new SessionRegistry(() => NOW);
    const own = makeDeps(dir, { now: NOW });
    const { handle } = await start({
      registry,
      depsFor: (sessionId: string): Deps => {
        const entry = registry.get(sessionId);
        if (entry === undefined) return own;
        return { ...own, config: { ...own.config, ...entry.config } };
      },
    });

    // Unregistered: the daemon's own config, gate advisory, so it trips.
    expect((await hook(handle.port, "PreToolUse", PRE)).text).toContain("deny");

    const gateOff = { ...sessionConfigOf(own.config), gate: "off" as const };
    const start1 = await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ session_id: "s1", data_dir: dir, config: gateOff }),
    });
    expect(start1.status).toBe(200);
    expect(registry.get("s1")?.config.gate).toBe("off");
    expect(handle.stats().sessions_started).toBe(1);

    // Registered with the gate off: the same call is silent.
    expect((await hook(handle.port, "PreToolUse", PRE)).text).toBe("{}");
  });

  it("falls back to its own config when the snapshot is nonsense", async () => {
    const registry = new SessionRegistry(() => NOW);
    const { handle } = await start({ registry });
    await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ session_id: "s1", config: { gate: "wide-open", autoThreshold: 99, stopCheck: "yes" } }),
    });
    const entry = registry.get("s1");
    expect(entry?.config.gate).toBe("advisory");
    expect(entry?.config.autoThreshold).toBe(0.85);
    expect(entry?.config.stopCheck).toBe(true);
  });

  it("ends a session on /v1/session/end and on the SessionEnd hook", async () => {
    const registry = new SessionRegistry(() => NOW);
    const { handle } = await start({ registry });
    const register = async (id: string): Promise<void> => {
      await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ session_id: id, data_dir: dir }),
      });
    };
    await register("s1");
    await register("s2");
    expect(registry.count()).toBe(2);

    await fetch(`http://127.0.0.1:${handle.port}/v1/session/end`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(registry.count()).toBe(1);

    await hook(handle.port, "SessionEnd", { session_id: "s2", hook_event_name: "SessionEnd", reason: "other" });
    expect(registry.count()).toBe(0);
    expect(handle.stats().sessions_ended).toBe(2);
  });
});

// ----------------------------------------------------------------- lifetime

describe("lifetime", () => {
  it("asks to exit after the idle window with no requests", async () => {
    let asked = 0;
    const { handle } = await start({ idleMs: 40, onExitRequested: () => (asked += 1) });
    await waitFor(() => asked > 0);
    expect(asked).toBeGreaterThan(0);
    expect(handle.port).toBeGreaterThan(0);
  });

  it("does not count a health probe as activity", async () => {
    // The MCP watchdog probes health every ten seconds for as long as Claude
    // Code runs. If that reset the idle clock, the daemon would never exit.
    let asked = 0;
    const { handle } = await start({ idleMs: 120, onExitRequested: () => (asked += 1) });
    for (let i = 0; i < 4; i += 1) {
      await health(handle.port);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(asked).toBeGreaterThan(0);
  });

  it("keeps the clock running while hooks arrive", async () => {
    let asked = 0;
    const { handle } = await start({ idleMs: 200, onExitRequested: () => (asked += 1) });
    for (let i = 0; i < 4; i += 1) {
      await hook(handle.port, "PreToolUse", { ...PRE, tool_input: { command: "ls -la" } });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(asked).toBe(0);
  });

  it("arms a grace timer when the last session ends", async () => {
    let asked = 0;
    const registry = new SessionRegistry(() => NOW);
    const { handle } = await start({ registry, lastSessionGraceMs: 40, onExitRequested: () => (asked += 1) });
    const body = (id: string): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ session_id: id, data_dir: dir }),
    });
    await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, body("s1"));
    await fetch(`http://127.0.0.1:${handle.port}/v1/session/end`, body("s1"));
    await waitFor(() => asked > 0);
    expect(asked).toBe(1);
  });

  it("cancels the grace timer when a new session arrives", async () => {
    let asked = 0;
    const registry = new SessionRegistry(() => NOW);
    const { handle } = await start({ registry, lastSessionGraceMs: 120, onExitRequested: () => (asked += 1) });
    const body = (id: string): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ session_id: id, data_dir: dir }),
    });
    await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, body("s1"));
    await fetch(`http://127.0.0.1:${handle.port}/v1/session/end`, body("s1"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, body("s2"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(asked).toBe(0);
  });

  it("frees the port on close, so a replacement can bind it", async () => {
    const { handle } = await start();
    const port = handle.port;
    await handle.close();
    handles.length = 0;
    await expect(fetch(`http://127.0.0.1:${port}/v1/health`)).rejects.toThrow();

    const again = await startDaemon({
      port,
      expectedKeys: [],
      depsFor: (): Deps => makeDeps(dir, { now: NOW }),
      registry: new SessionRegistry(() => NOW),
      onExitRequested: () => undefined,
      idleMs: 0,
      lastSessionGraceMs: 0,
    });
    handles.push(again);
    expect(again.port).toBe(port);
    expect((await health(port)).jev).toBe(true);
  });

  it.skipIf(!existsSync("/proc/self/fd"))("does not leak listener file descriptors across repeated start/close", async () => {
    const fdDirectory = "/proc/self/fd";
    const before = readdirSync(fdDirectory).length;
    for (let i = 0; i < 25; i += 1) {
      const { handle } = await start();
      await handle.close();
      handles.pop();
    }
    const after = readdirSync(fdDirectory).length;
    expect(after).toBeLessThanOrEqual(before + 1);
  });

  it("rejects a second daemon on a port already held", async () => {
    const { handle } = await start();
    await expect(
      startDaemon({
        port: handle.port,
        expectedKeys: [],
        depsFor: (): Deps => makeDeps(dir, { now: NOW }),
        registry: new SessionRegistry(() => NOW),
        onExitRequested: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});

describe("the model reaches the handlers", () => {
  it("judges through the daemon with the session's model", async () => {
    const model = new FakeModel(() => ({
      destructive: noul(0.99),
      outward_facing: noul(0.02),
      in_scope: noul(0.3),
      credential_exposure: noul(0.01),
      blast_radius: score(1, ["a", "b", "c", "d"], 0.9),
    }));
    const { handle, deps } = await start({ model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["clean up"] }), NOW);
    const reply = await hook(handle.port, "PreToolUse", { ...PRE, tool_input: { command: "npm install" } });
    expect(reply.text).toContain("additionalContext");
    expect(model.calls).toHaveLength(1);
  });
});

// ------------------------------------------------------- session binding

const CRED_A = "session-a-credential";
const CRED_B = "session-b-credential";

async function sessionStart(
  port: number,
  sessionId: string,
  credential: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/session/start`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify({ session_id: sessionId, data_dir: dir, ...extra }),
  });
}

describe("session binding", () => {
  it("refuses a valid credential bound to another session (cross-session impersonation)", async () => {
    const dirA = `${dir}/a`;
    const dirB = `${dir}/b`;
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const depsA = makeDeps(dirA, { now: NOW });
    const depsB = makeDeps(dirB, { now: NOW });
    const { handle, registry } = await start({
      expectedKeys: [CRED_A, CRED_B],
      depsFor: (sessionId: string): Deps => (sessionId === "sB" ? depsB : depsA),
    });

    expect((await sessionStart(handle.port, "sA", CRED_A, { data_dir: dirA })).status).toBe(200);
    expect((await sessionStart(handle.port, "sB", CRED_B, { data_dir: dirB })).status).toBe(200);
    expect(registry.get("sA")?.creator).toBe(credentialId(CRED_A));
    expect(registry.get("sB")?.creator).toBe(credentialId(CRED_B));

    // A's credential is valid at the daemon, but it may not act as B: the
    // hook post is refused with fail-open silence and touches nothing.
    const attack = await hook(
      handle.port,
      "PreToolUse",
      { ...PRE, session_id: "sB" },
      { authorization: `Bearer ${CRED_A}` },
    );
    expect(attack.status).toBe(200);
    expect(attack.text).toBe("{}");
    expect(handle.stats().hooks.PreToolUse).toBeUndefined();
    expect(handle.stats().forbidden).toBe(1);

    // No config, data_dir or evidence of B was read or modified: B's store
    // is empty, and ending B with A's credential is a 403 that revokes
    // nothing.
    expect(testStore(dirB).readLog()).toHaveLength(0);
    const endAttack = await fetch(`http://127.0.0.1:${handle.port}/v1/session/end`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CRED_A}` },
      body: JSON.stringify({ session_id: "sB" }),
    });
    expect(endAttack.status).toBe(403);
    expect(registry.get("sB")).toBeDefined();
    expect(handle.stats().forbidden).toBe(2);

    // The bound credential still works: B's own post is judged with B's
    // scope (advisory gate denies the tripwire) and writes B's evidence.
    const legit = await hook(
      handle.port,
      "PreToolUse",
      { ...PRE, session_id: "sB" },
      { authorization: `Bearer ${CRED_B}` },
    );
    expect(legit.text).toContain("deny");
    expect(handle.stats().hooks.PreToolUse).toBe(1);
    expect(testStore(dirB).readLog().length).toBeGreaterThan(0);
  });

  it("rejects a data_dir outside the allowed roots without registering", async () => {
    const outside = tempDir();
    try {
      const { handle, registry } = await start({ expectedKeys: [CRED_A] });
      const headers = { "content-type": "application/json", authorization: `Bearer ${CRED_A}` };
      const attempt = (dataDir: string): Promise<Response> =>
        fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
          method: "POST",
          headers,
          body: JSON.stringify({ session_id: "evil", data_dir: dataDir }),
        });

      // Outside the roots, missing, relative, and not-a-directory.
      expect((await attempt(outside)).status).toBe(400);
      expect((await attempt(`${dir}/no-such-dir`)).status).toBe(400);
      expect((await attempt("relative/path")).status).toBe(400);
      const file = `${dir}/file.txt`;
      writeFileSync(file, "x");
      expect((await attempt(file)).status).toBe(400);

      // A symlink inside the roots pointing outside them is an escape.
      const link = `${dir}/escape-link`;
      symlinkSync(outside, link);
      expect((await attempt(link)).status).toBe(400);

      expect(registry.get("evil")).toBeUndefined();
      expect(handle.stats().forbidden).toBe(5);

      // A real directory under the roots still registers.
      const sub = `${dir}/sub`;
      mkdirSync(sub, { recursive: true });
      expect((await attempt(sub)).status).toBe(200);
      expect(registry.get("evil")?.dataDir).toBeDefined();
    } finally {
      cleanup(outside);
    }
  });

  it("rotation: the old token stops working and sessions stay bound", async () => {
    const OLD = "old-daemon-token";
    const NEW = "new-daemon-token";
    const registry = new SessionRegistry(() => NOW);
    const first = await start({ expectedKeys: [OLD], registry });
    expect((await sessionStart(first.handle.port, "s1", OLD)).status).toBe(200);

    // The replacement daemon never held the old token: it 401s, and the
    // session it names is not adopted by the new credential either.
    const second = await start({ expectedKeys: [NEW], registry });
    const stale = await sessionStart(second.handle.port, "s1", OLD);
    expect(stale.status).toBe(401);
    const hijack = await hook(
      second.handle.port,
      "PreToolUse",
      { ...PRE, session_id: "s1" },
      { authorization: `Bearer ${NEW}` },
    );
    expect(hijack.status).toBe(200);
    expect(hijack.text).toBe("{}");
    expect(second.handle.stats().forbidden).toBe(1);
    expect(second.handle.stats().hooks.PreToolUse).toBeUndefined();

    // Re-registration with the new credential rebinds, and only then does
    // the new credential serve the session again.
    expect((await sessionStart(second.handle.port, "s1", NEW)).status).toBe(200);
    expect(registry.get("s1")?.creator).toBe(credentialId(NEW));
    const served = await hook(
      second.handle.port,
      "PreToolUse",
      { ...PRE, session_id: "s1", tool_input: { command: "ls -la" } },
      { authorization: `Bearer ${NEW}` },
    );
    expect(served.status).toBe(200);
    expect(second.handle.stats().hooks.PreToolUse).toBe(1);
  });

  it("revocation ends the binding and returns the session to unregistered", async () => {
    const { handle, registry } = await start({ expectedKeys: [CRED_A] });
    expect((await sessionStart(handle.port, "s1", CRED_A)).status).toBe(200);
    expect(registry.get("s1")).toBeDefined();

    const end = await fetch(`http://127.0.0.1:${handle.port}/v1/session/end`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CRED_A}` },
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(end.status).toBe(200);
    expect(registry.get("s1")).toBeUndefined();

    // The credential still works at the daemon, but the revoked session no
    // longer scopes anything: the post falls back to the daemon's config.
    const after = await hook(
      handle.port,
      "PreToolUse",
      { ...PRE, session_id: "s1", tool_input: { command: "ls -la" } },
      { authorization: `Bearer ${CRED_A}` },
    );
    expect(after.status).toBe(200);
    expect(handle.stats().hooks.PreToolUse).toBe(1);
  });

  it("ending an unknown session stays a quiet idempotent 200", async () => {
    const { handle } = await start({ expectedKeys: [CRED_A] });
    const end = await fetch(`http://127.0.0.1:${handle.port}/v1/session/end`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CRED_A}` },
      body: JSON.stringify({ session_id: "nobody" }),
    });
    expect(end.status).toBe(200);
  });
});

// ------------------------------------------------- privilege separation

describe("privilege separation", () => {
  it("reserves admin routes for the separate admin capability", async () => {
    const ADMIN = "admin-capability-token";
    const { handle, registry } = await start({ expectedKeys: [CRED_A], adminToken: ADMIN });
    expect((await sessionStart(handle.port, "s1", CRED_A)).status).toBe(200);

    // No token, a session credential as the admin token, and a wrong admin
    // token: all 401, never a fallback into another tier.
    const listNone = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/sessions`);
    expect(listNone.status).toBe(401);
    for (const presented of [CRED_A, "wrong"]) {
      const denied = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-jev-admin-token": presented },
        body: JSON.stringify({ session_id: "s1" }),
      });
      expect(denied.status).toBe(401);
    }
    expect(registry.get("s1")).toBeDefined();

    // The admin capability lists without revealing secrets, and revokes.
    const list = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/sessions`, {
      headers: { "x-jev-admin-token": ADMIN },
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { sessions: Array<{ session_id: string }> };
    expect(listed.sessions.map((s) => s.session_id)).toContain("s1");
    expect(JSON.stringify(listed)).not.toContain(ADMIN);
    expect(JSON.stringify(listed)).not.toContain(CRED_A);

    const revoke = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jev-admin-token": ADMIN },
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(revoke.status).toBe(200);
    expect(registry.get("s1")).toBeUndefined();
  });

  it("closes admin routes entirely when no admin capability is configured", async () => {
    const { handle, registry } = await start({ expectedKeys: [CRED_A] });
    expect((await sessionStart(handle.port, "s1", CRED_A)).status).toBe(200);
    const revoke = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jev-admin-token": CRED_A },
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(revoke.status).toBe(401);
    expect(registry.get("s1")).toBeDefined();
  });

  it("keeps health diagnostic: unauthenticated, secret-free, and tier-labelled", async () => {
    const { handle } = await start({ expectedKeys: [CRED_A], adminToken: "admin-capability-token" });
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.auth).toBe("key");
    expect(body.admin).toBe(true);
    const text = JSON.stringify(body);
    expect(text).not.toContain(CRED_A);
    expect(text).not.toContain("admin-capability-token");
  });

  it("never lets the admin capability authorize session or hook routes", async () => {
    const ADMIN = "admin-capability-token";
    const { handle } = await start({ expectedKeys: [CRED_A], adminToken: ADMIN });
    const startResp = await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jev-admin-token": ADMIN },
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(startResp.status).toBe(401);
    const hookResp = await hook(
      handle.port,
      "PreToolUse",
      { ...PRE, session_id: "s1" },
      { "x-jev-admin-token": ADMIN },
    );
    expect(hookResp.status).toBe(200);
    expect(hookResp.text).toBe("{}");
    expect(handle.stats().hooks.PreToolUse).toBeUndefined();
    expect(handle.stats().unauthorized).toBe(1);
  });

  it("unit: admin authorization needs the exact configured token", () => {
    expect(authorizeAdmin({}, "tok")).toBe(false);
    expect(authorizeAdmin({ "x-jev-admin-token": "tok" }, "tok")).toBe(true);
    expect(authorizeAdmin({ "x-jev-admin-token": "wrong" }, "tok")).toBe(false);
    expect(authorizeAdmin({ "x-jev-admin-token": "tok" }, undefined)).toBe(false);
    expect(authorizeAdmin({ "x-jev-admin-token": "tok" }, "")).toBe(false);
    expect(authorizeAdmin({ "x-jev-admin-token": "" }, "tok")).toBe(false);
  });
});
