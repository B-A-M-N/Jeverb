/**
 * The loopback HTTP server behind the `type: "http"` hooks.
 *
 * One process, many hook calls. That is the whole of 0.4.0: a skip-path
 * PreToolUse stops costing a Node cold start, and the Jev client keeps its TLS
 * session between calls instead of paying for a new one every time.
 *
 * Three properties matter more than speed, and every branch below is written to
 * keep them:
 *
 * 1. **Fail open, from Claude Code's point of view.** Claude Code treats a
 *    non-2xx reply, a non-JSON reply, a timeout and a refused connection all as
 *    non-blocking errors: the tool call proceeds. So every error path here is
 *    safe by construction, and the paths that could plausibly be a *hook*
 *    problem rather than a *request* problem answer `200 {}` — silence — rather
 *    than a status code that would land in a debug log for no reason.
 * 2. **Bounded time.** A handler races a 3.5 s wall clock, inside the 5 s
 *    declared in `hooks.json`, so Claude Code never has to cancel us.
 * 3. **The same answer as the command path.** The routes run `runEvent`, the
 *    same function `node hook.mjs <Event>` runs, with `Deps` built the same way.
 *    `{}` stands in for `undefined`, which is the wire's way of saying nothing.
 *
 * `/v1/health` is the one unauthenticated route, and it is why `ensureDaemon`
 * can tell "my daemon, the right version" from "my daemon, stale" from
 * "something else is on the port" without a credential. It therefore carries no
 * secret of any kind: a version, a pid, some counters.
 *
 * Four privilege tiers, in increasing order:
 *
 * 1. **Diagnostic** (`/v1/health`): no credential. Token-light by design, and
 *    secret-free — fingerprints at most.
 * 2. **Hook-submission** (`/v1/hook/*`): a credential the daemon holds. When
 *    the named session is registered and bound to a *different* credential,
 *    the post is refused with fail-open silence (`200 {}`): Claude Code shows
 *    any non-2xx from an http hook as a hook error, so the refusal must not
 *    be loud — it is counted in `forbidden` instead. A session id alone
 *    authorizes nothing, with or without a credential bound to another
 *    session.
 * 3. **Lifecycle** (`/v1/session/start`, `/v1/session/end`): a credential the
 *    daemon holds, and for `end` the credential bound at session start.
 *    `start` (re)binds the session to the credential that presents it and
 *    validates `data_dir`; `end` refuses a stranger's session with 403. Real
 *    status codes here, because `/v1/session/start` uses a 401 to recognise
 *    a stale daemon.
 * 4. **Administrative** (`/v1/admin/*`): only the daemon's separate admin
 *    capability. Session and hook credentials never authorize these routes,
 *    and the admin token never authorizes the routes below it. No
 *    unauthenticated fallback: unconfigured means every admin route 401s.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HANDLERS, runEvent, WALL_CLOCK_MS } from "../dispatch.js";
import type { Deps, HookOutput } from "../types.js";
import { HOOK_VERSION } from "../version.js";
import { authMode, authorize, authorizeAdmin, keyFingerprint, matchedCredentialId } from "./auth.js";
import { DEFAULT_IDLE_MS, LAST_SESSION_GRACE_MS, MAX_BODY_BYTES, PROTOCOL } from "./protocol.js";
import { readSessionConfig, sessionConfigOf, type SessionRegistry } from "./registry.js";
import { validateDataDir } from "./session-scope.js";
import { bundleIdentity, emptyCounters, type DaemonCounters } from "./state-file.js";
import { environmentDisableOverride, isGloballyDisabled } from "../store.js";

export { DEFAULT_PORT, MAX_BODY_BYTES, PROTOCOL } from "./protocol.js";

export interface DaemonOptions {
  /** 0 asks the OS for a free port; the chosen one comes back on the handle. */
  port: number;
  /** Empty runs unauthenticated. See `auth.ts` for why that is a real mode. */
  expectedKeys: readonly string[];
  /**
   * Fingerprint of the local capability token, when one is held. Reported in
   * `/v1/health` as `daemon_token: true` so operators can tell token-backed
   * authentication apart from provider-key authentication.
   */
  daemonTokenFingerprint?: string;
  /** Builds the `Deps` for one session id, honouring that session's config. */
  depsFor: (sessionId: string) => Deps;
  registry: SessionRegistry;
  /**
   * The daemon's own data directory. Used as the default allowed root for
   * caller-supplied `data_dir` values: sessions normally share it.
   */
  dataDir?: string;
  /** The same protected switch source used by command hooks. */
  masterSwitchPath?: string;
  requireRootOwnedMasterSwitch?: boolean;
  /**
   * Roots a caller-supplied `data_dir` may live under, after symlinks are
   * resolved. Defaults to `[dataDir]`; when neither is configured, `data_dir`
   * is not validated (legacy embedders that never register sessions).
   */
  allowedDataRoots?: readonly string[];
  /**
   * The separate administrative capability for `/v1/admin/*`. Absent means
   * those routes all 401 — session and hook credentials are never accepted
   * there as a fallback.
   */
  adminToken?: string;
  /** No requests for this long and the daemon asks to exit. */
  idleMs?: number;
  /** After the last session ends, wait this long before asking to exit. */
  lastSessionGraceMs?: number;
  /** Called when a timer fires. The caller owns the shutdown. */
  onExitRequested: () => void;
  /** Handler deadline. Defaults to the shared 3.5 s wall clock. */
  wallClockMs?: number;
  /**
   * What the model stack knows that the server cannot: how many Jev calls went
   * out, how many the memo answered, and how many failed.
   *
   * The server never calls the model — a handler does — so without this the
   * `jev_calls` and `memo_hits` in `/v1/health` would always read zero, which
   * is worse than absent: it is a number that looks like an answer.
   */
  modelStats?: () => Partial<DaemonCounters>;
}

export interface DaemonHandle {
  /** The port actually bound, which is what `port: 0` is for. */
  port: number;
  close(): Promise<void>;
  stats(): DaemonCounters;
  /** Epoch ms this daemon started listening. */
  startedAt: number;
}

const HOOK_PREFIX = "/v1/hook/";

function bump(counters: DaemonCounters, key: Exclude<keyof DaemonCounters, "hooks">): void {
  counters[key] += 1;
}

/** The server's own counters plus whatever the model stack contributes. */
function merge(counters: DaemonCounters, extra: (() => Partial<DaemonCounters>) | undefined): DaemonCounters {
  return { ...counters, ...(extra?.() ?? {}), hooks: { ...counters.hooks } };
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const text = status === 204 ? "" : `${JSON.stringify(body ?? {})}`;
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    // Nothing here is cacheable and nothing here is for a browser.
    "cache-control": "no-store",
  });
  res.end(text);
}

/**
 * Read the body, or say it was too big.
 *
 * The cap is enforced as bytes arrive rather than after the fact: a 4 GB POST
 * to a loopback port is a trivial way to make a daemon run out of memory, and
 * the daemon has to survive a neighbour's bug as well as its own.
 */
function readBody(req: IncomingMessage, max: number): Promise<string | "too-large"> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: string | "too-large"): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.byteLength;
      if (size > max) {
        finish("too-large");
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => finish(""));
    req.on("aborted", () => finish(""));
  });
}

function sessionIdOf(parsed: Record<string, unknown>): string {
  const raw = parsed.session_id;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : "unknown";
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const counters = emptyCounters();
  const bundle = bundleIdentity();
  const startedAt = Date.now();
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const graceMs = options.lastSessionGraceMs ?? LAST_SESSION_GRACE_MS;
  const wallClockMs = options.wallClockMs ?? WALL_CLOCK_MS;

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  /** Overwritten with the real port once the listener is up; `port: 0` needs it. */
  let handlePort = options.port;

  const clearGrace = (): void => {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
  };

  /**
   * Reset the idle clock.
   *
   * Health probes deliberately do not: the MCP watchdog polls health every 10 s
   * for as long as Claude Code is running, so counting it as activity would
   * mean the idle timer never fires and "exits when nobody is using it" would
   * be a comment rather than a behaviour.
   */
  const touch = (): void => {
    if (closing || idleMs <= 0) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      options.onExitRequested();
    }, idleMs);
  };

  const armGrace = (): void => {
    clearGrace();
    if (closing || graceMs <= 0) return;
    graceTimer = setTimeout(() => {
      if (options.registry.count() === 0) options.onExitRequested();
    }, graceMs);
  };

  const health = (): Record<string, unknown> => ({
    // The marker `ensureDaemon` looks for: something else on this port will not
    // have it, and that is the difference between "replace" and "conflict".
    jev: true,
    pid: process.pid,
    port: handlePort,
    version: HOOK_VERSION,
    protocol: PROTOCOL,
    bundle_path: bundle.path,
    bundle_mtime: bundle.mtime,
    started_at: startedAt,
    uptime_ms: Date.now() - startedAt,
    sessions: options.registry.count(),
    auth: authMode(options.expectedKeys),
    daemon_token: options.daemonTokenFingerprint !== undefined,
    admin: options.adminToken !== undefined && options.adminToken !== "",
    // Identifies each key in `/jev:daemon status` without revealing it.
    key_fingerprints: options.expectedKeys.map(keyFingerprint),
    counters: merge(counters, options.modelStats),
  });

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    void (async (): Promise<void> => {
      try {
        const url = (req.url ?? "/").split("?")[0] ?? "/";

        // ------------------------------------------------------------ health
        if (url === "/v1/health") {
          if (req.method !== "GET" && req.method !== "HEAD") {
            req.resume();
            respond(res, 405, {});
            return;
          }
          req.resume();
          respond(res, 200, health());
          return;
        }

        // Do not mutate session state, dispatch hooks, or service admin
        // operations while the install-wide switch is off. Health remains a
        // read-only liveness probe so the host can distinguish loaded from
        // operationally enabled.
        if (environmentDisableOverride() || (options.dataDir !== undefined && isGloballyDisabled(options.dataDir, options.masterSwitchPath, options.requireRootOwnedMasterSwitch ?? true))) {
          req.resume();
          respond(res, url.startsWith("/v1/hook/") ? 200 : 503, {});
          return;
        }

        // ----------------------------------------------- admin session list
        // Diagnostic-adjacent but NOT diagnostic: listing sessions needs the
        // admin capability. Handled before the POST-only gate below because
        // it is a GET, and the shared path requires POST plus a JSON body.
        if (url === "/v1/admin/sessions") {
          if (req.method !== "GET") {
            req.resume();
            respond(res, 405, {});
            return;
          }
          req.resume();
          if (!authorizeAdmin(req.headers, options.adminToken)) {
            bump(counters, "forbidden");
            respond(res, 401, {});
            return;
          }
          respond(res, 200, {
            sessions: options.registry.ids().map((id) => {
              const entry = options.registry.get(id);
              return {
                session_id: id,
                data_dir: entry?.dataDir,
                started_at: entry?.started_at,
                // Who may act as this session, without revealing the secret.
                owner: entry?.creator === undefined ? null : entry.creator.slice(0, 8),
              };
            }),
          });
          return;
        }

        const isHook = url.startsWith(HOOK_PREFIX);
        const event = isHook ? decodeURIComponent(url.slice(HOOK_PREFIX.length)) : "";

        // A hook route answers `200 {}` on every refusal because Claude Code
        // shows any non-2xx from an http hook to the user as a hook error, and
        // this plugin fails open in silence. The counters keep the refusal
        // countable, and the session routes keep their real status because
        // `/v1/session/start` uses a 401 to recognise a stale daemon.
        // The body is read before authorization because a hook's session id is a
        // credential and it lives in the body; `MAX_BODY_BYTES` bounds what an
        // unauthenticated caller can make the daemon read.
        const refuse = (status: number): void => {
          req.resume();
          respond(res, isHook ? 200 : status, {});
        };

        // ---------------------------------------------------------- method
        if (req.method !== "POST") {
          refuse(405);
          return;
        }

        // ------------------------------------------------------------ routing
        if (isHook && HANDLERS[event] === undefined) {
          bump(counters, "unknown_event");
          refuse(404);
          return;
        }
        if (!isHook && url !== "/v1/session/start" && url !== "/v1/session/end" && url !== "/v1/admin/revoke") {
          refuse(404);
          return;
        }

        // --------------------------------------------------- protocol version
        // Absent is fine: a curl, or a command-path fallback, has no reason to
        // know the number. Present and wrong means the caller ships a different
        // wire format, and answering it anyway is how you get a subtle bug
        // instead of a replaced daemon.
        const declared = req.headers["x-jev-protocol"];
        const declaredText = Array.isArray(declared) ? declared[0] : declared;
        if (typeof declaredText === "string" && declaredText.trim() !== "" && declaredText.trim() !== String(PROTOCOL)) {
          bump(counters, "protocol_mismatch");
          refuse(409);
          return;
        }

        // ---------------------------------------------------------- the body
        const raw = await readBody(req, MAX_BODY_BYTES);
        if (raw === "too-large") {
          bump(counters, "oversize");
          // `readBody` has already destroyed the request, so there is nothing
          // left to drain; answer directly rather than through `refuse`.
          respond(res, isHook ? 200 : 413, {});
          return;
        }

        let parsed: Record<string, unknown>;
        try {
          const value = JSON.parse(raw) as unknown;
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
          parsed = value as Record<string, unknown>;
        } catch {
          // Garbage in the body is not this plugin's problem to report, and a
          // 400 would show up in someone's debug log as if it were.
          bump(counters, "bad_request");
          respond(res, 200, {});
          return;
        }

        // ------------------------------------------------- admin revocation
        // The only privileged route that accepts the admin capability, and
        // the only session route that does not need the session's own
        // credential: revocation is for the aftermath, when that credential
        // may be the thing being cleaned up after. Checked before the
        // session-credential gate so a bare admin token is sufficient.
        const sessionId = sessionIdOf(parsed);
        if (url === "/v1/admin/revoke") {
          if (!authorizeAdmin(req.headers, options.adminToken)) {
            bump(counters, "forbidden");
            respond(res, 401, {});
            return;
          }
          options.registry.end(sessionId);
          bump(counters, "sessions_ended");
          if (options.registry.count() === 0) armGrace();
          respond(res, 200, {});
          return;
        }

        // ----------------------------------------------------- authorization
        // `readBody` has consumed the request, so no `req.resume()` here.
        //
        // A session id is correlation, never a credential: every route but
        // `/v1/health` requires a real one — a provider key the install
        // holds, or the daemon's own local capability token. A known
        // session id authorizes nothing on its own: session ids travel in
        // hook bodies and transcripts, so any local process that has seen
        // one could otherwise inject hook events for a session it does not
        // own. Keyless installs authenticate with the daemon token minted
        // into the data directory; SessionStart says how to export it when
        // the http transport cannot already present it.
        //
        // Admission is only the first half. Acting *as* a registered session
        // needs the credential that created it: `caller` is that credential's
        // id, and every route below compares it against the session's binding
        // before touching that session's config, data directory or evidence.
        const keyed = authorize(req.headers, options.expectedKeys);
        if (!keyed) {
          // A daemon credential of the wrong tier (the admin capability on
          // a hook route) is authenticated-but-not-permitted, not
          // unauthenticated: fail-open silence with the forbidden record,
          // and never build the session's deps.
          if (isHook && authorizeAdmin(req.headers, options.adminToken)) {
            bump(counters, "forbidden");
            respond(res, 200, {});
            return;
          }
          bump(counters, "unauthorized");
          respond(res, isHook ? 200 : 401, {});
          return;
        }
        const caller = matchedCredentialId(req.headers, options.expectedKeys) ?? "none";

        touch();

        // ------------------------------------------------ session lifecycle
        if (url === "/v1/session/start") {
          const own = options.depsFor(sessionId).config;
          const fallback = sessionConfigOf(own);
          const config = readSessionConfig(parsed.config, fallback) ?? fallback;
          const dataDirRaw = parsed.data_dir;
          const rawDir =
            typeof dataDirRaw === "string" && dataDirRaw.trim() !== ""
              ? dataDirRaw.trim()
              : own.dataDir;
          const roots =
            options.allowedDataRoots ?? (options.dataDir === undefined ? undefined : [options.dataDir]);
          if (roots !== undefined) {
            const verdict = validateDataDir(rawDir, roots);
            if (!verdict.ok) {
              bump(counters, "forbidden");
              respond(res, 400, {});
              return;
            }
            // Stored canonical: one spelling per directory, no aliasing.
            options.registry.start(sessionId, verdict.path, config, caller);
          } else {
            options.registry.start(sessionId, rawDir, config, caller);
          }
          bump(counters, "sessions_started");
          clearGrace();
          respond(res, 200, {});
          return;
        }

        if (url === "/v1/session/end") {
          const entry = options.registry.get(sessionId);
          if (entry?.creator !== undefined && entry.creator !== caller) {
            bump(counters, "forbidden");
            respond(res, 403, {});
            return;
          }
          options.registry.end(sessionId);
          bump(counters, "sessions_ended");
          if (options.registry.count() === 0) armGrace();
          respond(res, 200, {});
          return;
        }

        // -------------------------------------------------------------- hooks
        const bound = options.registry.get(sessionId);
        if (bound?.creator !== undefined && bound.creator !== caller) {
          // A valid credential bound to another session: admitted to the
          // daemon, but not to this session's scope. Fail-open silence, as
          // with every hook-route refusal — Claude Code compatibility — with
          // the `forbidden` counter as the record. The deps below are never
          // built, so this request reads and writes nothing of the session's.
          bump(counters, "forbidden");
          respond(res, 200, {});
          return;
        }
        counters.hooks[event] = (counters.hooks[event] ?? 0) + 1;
        const deps = options.depsFor(sessionId);
        // First touch on a reloaded (unbound) entry claims it for this
        // credential. Bound entries are untouched: `start` alone rebinds.
        options.registry.bindIfAbsent(sessionId, caller);

        // `Approval` answers first and does its bookkeeping afterwards. It is
        // wired up as a fire-and-forget hook, and an http hook cannot be
        // declared `async` (Claude Code only honours that on command hooks), so
        // the daemon makes it asynchronous itself rather than depending on the
        // harness to.
        if (event === "Approval") {
          respond(res, 200, {});
          void runEvent(event, raw, deps).catch(() => undefined);
          return;
        }

        // The deadline cancels in-flight model work, not just this request's
        // verdict: the same budget that counts the overrun aborts the
        // handler's fetch, so nothing keeps running detached to its own
        // timeoutMs. Judgment semantics, timeouts, and retries are
        // unchanged — this is purely lifecycle plumbing.
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), wallClockMs);
        let output: HookOutput | undefined;
        try {
          output = await withDeadlineCounted(runEvent(event, raw, deps, controller.signal), wallClockMs, counters);
        } finally {
          clearTimeout(abortTimer);
        }
        if (environmentDisableOverride() || (options.dataDir !== undefined && isGloballyDisabled(options.dataDir, options.masterSwitchPath, options.requireRootOwnedMasterSwitch ?? true))) {
          respond(res, 200, {});
          return;
        }

        // SessionEnd is how the daemon learns a session is over. The handler
        // itself is empty; the registry is the daemon's, so ending it is too.
        if (event === "SessionEnd") {
          options.registry.end(sessionId);
          bump(counters, "sessions_ended");
          if (options.registry.count() === 0) armGrace();
        }

        respond(res, 200, output ?? {});
      } catch {
        // A bug in a handler must not take the daemon down, and must not block
        // the tool call either. 500 is a non-blocking error to Claude Code.
        bump(counters, "errors");
        try {
          req.resume();
          respond(res, 500, {});
        } catch {
          res.destroy();
        }
      }
    })();
  };

  const server: Server = createServer(onRequest);

  // Loopback only. Not a policy statement, a binding: nothing outside this
  // machine can reach the daemon even if a firewall is wide open.
  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown): void => {
      server.off("listening", onListening);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      handlePort = typeof address === "object" && address !== null ? address.port : options.port;
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, "127.0.0.1");
  });

  touch();

  return {
    port: handlePort,
    startedAt,
    stats: (): DaemonCounters => merge(counters, options.modelStats),
    close: async (): Promise<void> => {
      closing = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      clearGrace();
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(force);
          resolve();
        };
        // Close the listener first so the port is free for a replacement, then
        // let whatever is in flight finish. Idle keep-alive sockets are dropped
        // immediately; anything still working gets the drain budget.
        const force = setTimeout(() => {
          server.closeAllConnections();
          done();
        }, WALL_CLOCK_MS);
        server.close(() => done());
        server.closeIdleConnections();
      });
    },
  };
}

/** `withDeadline`, counting the overruns so they show up in `/jev:status`. */
async function withDeadlineCounted<T>(
  work: Promise<T>,
  ms: number,
  counters: DaemonCounters,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          bump(counters, "deadline_overruns");
          resolve(undefined);
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
