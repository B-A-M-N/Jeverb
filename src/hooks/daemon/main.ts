/**
 * `node hook.mjs daemon` — the long-lived half of the plugin.
 *
 * Same bundle as the hooks, a different argv. That is not a saving on build
 * time, it is the guarantee the whole release rests on: there is exactly one
 * copy of every handler, so the daemon path and the command path cannot drift.
 *
 * What this file owns is everything the handlers do not: one Jev client for the
 * life of the process (so TLS and the connection pool are paid for once), the
 * memo and the concurrency limit in front of it, the session registry, the
 * heartbeat, and a shutdown that frees the port before it drains.
 *
 * Nothing here writes to stdout. The daemon's stdio is redirected into
 * `daemon.log` by whoever spawned it, and a stray `console.log` in a detached
 * process is how you end up with a 400 MB log file.
 */

import { join } from "node:path";
import { buildDecisionModel } from "../../jev/factory.js";
import type { DecisionModel } from "../../decision/types.js";
import { loadHookConfig, type Env, type HookConfig } from "../config.js";
import { isGloballyDisabled, readMasterSwitch } from "../store.js";
import { expectedKeysFrom, keyFingerprint } from "./auth.js";
import { daemonStartupBanner } from "./banner.js";
import { loadOrMintAdminToken, loadOrMintDaemonToken } from "./state-file.js";
import { LimitedModel, MemoizedModel } from "../memo.js";
import { Store } from "../store.js";
import type { Deps } from "../types.js";
import { EvidenceLedger } from "../../evidence/ledger.js";
import { createControlServiceProofPlanClosureRunner, createSessionMissionClosureRunner, resolveTrustedRunnerOptions } from "../../mission/runtime.js";
import { HOOK_VERSION } from "../version.js";
import { PROTECTED_MASTER_SWITCH_PATH, REQUIRE_ROOT_OWNED_SWITCH } from "../../control/constants.js";
import { HEARTBEAT_MS, PROTOCOL } from "./protocol.js";
import { hookConfigFrom, readSessionConfig, sessionConfigOf, SessionRegistry } from "./registry.js";
import { startDaemon, type DaemonHandle } from "./server.js";
import {
  bundleIdentity,
  emptyCounters,
  readDaemonState,
  writeDaemonState,
  type DaemonCounters,
  type DaemonState,
} from "./state-file.js";

/** How long the daemon gives in-flight work after the listener closes. */
const DRAIN_MS = 3500;

/** `--port <n>`, if it is there and usable. */
export function parsePort(argv: readonly string[]): number | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const inline = /^--port=(.*)$/.exec(arg);
    const raw = inline !== null ? inline[1] : arg === "--port" ? argv[i + 1] : undefined;
    if (raw === undefined) continue;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 0 && value <= 65_535) return value;
  }
  return undefined;
}

/**
 * The model stack.
 *
 * Memo outside the limiter on purpose: a hit must not queue behind four real
 * calls to return a result that is already in memory.
 */
export function buildDaemonModel(config: HookConfig): {
  model: DecisionModel | null;
  memo: MemoizedModel | undefined;
} {
  if (config.apiKey === null && config.backend !== "jev-gateway") return { model: null, memo: undefined };
  const client = buildDecisionModel({
    apiKey: config.apiKey ?? undefined,
    backend: config.backend,
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    allowCustomRelay: config.allowCustomRelay,
  });
  const memo = new MemoizedModel(new LimitedModel(client));
  return { model: memo, memo };
}

/**
 * Build the `Deps` for one session.
 *
 * Three sources, in order: the registry (this session said hello), the session
 * file on disk (it said hello to a daemon that has since been replaced), and
 * this daemon's own environment (a session that never said anything, which is
 * what a bare `curl` looks like).
 *
 * The middle case is the one worth having. A plugin update replaces the daemon
 * mid-session, and without it every session in flight would be judged with
 * whatever settings the *new* daemon's environment happened to hold.
 */
export function makeDepsFor(
  config: HookConfig,
  model: DecisionModel | null,
  registry: SessionRegistry,
  missionClosure?: Deps["missionClosure"],
): { depsFor: (sessionId: string) => Deps } {
  const own = sessionConfigOf(config);
  const stores = new Map<string, Store>();
  const ledgers = new Map<string, EvidenceLedger>();
  const storeFor = (dir: string): Store => {
    const existing = stores.get(dir);
    if (existing !== undefined) return existing;
    const store = new Store(dir, {
      masterSwitchPath: config.masterSwitchPath,
      requireRootOwnedMasterSwitch: REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH,
    });
    stores.set(dir, store);
    return store;
  };
  const ledgerFor = (dir: string): EvidenceLedger => {
    const existing = ledgers.get(dir);
    if (existing !== undefined) return existing;
    const ledger = new EvidenceLedger(join(dir, "evidence.log"), {
      ...(process.argv[1] === undefined ? {} : { bundlePath: process.argv[1] }),
      switchPath: config.masterSwitchPath,
      requireRootOwnedSwitch: REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH,
    });
    ledgers.set(dir, ledger);
    return ledger;
  };
  const closureFor = (sessionConfig: HookConfig, store: Store): Deps["missionClosure"] => {
    if (missionClosure !== undefined) return missionClosure;
    if (model === null) return undefined;
    const ledger = ledgerFor(sessionConfig.dataDir);
    const trustedOptions = resolveTrustedRunnerOptions(process.env);
    const fallback = createSessionMissionClosureRunner({
      model,
      config: sessionConfig,
      store,
      ledger,
      now: () => Date.now(),
      adversarial: sessionConfig.adversarialClosure,
      ...trustedOptions,
    });
    return trustedOptions.enableTrustedGraphEvidence === true
      ? createControlServiceProofPlanClosureRunner({
          model,
          config: sessionConfig,
          store,
          ledger,
          now: () => Date.now(),
          adversarial: sessionConfig.adversarialClosure,
          fallback,
        })
      : fallback;
  };

  const depsFor = (sessionId: string): Deps => {
    const entry = registry.get(sessionId);
    if (entry !== undefined) {
      const store = storeFor(entry.dataDir);
      const sessionConfig = hookConfigFrom(entry.config, config.apiKey, entry.dataDir, config.masterSwitchPath);
      const missionClosureForSession = closureFor(sessionConfig, store);
      return {
        model,
        config: sessionConfig,
        store,
        ledger: ledgerFor(entry.dataDir),
        now: () => Date.now(),
        ...(missionClosureForSession === undefined ? {} : { missionClosure: missionClosureForSession }),
      };
    }

    // Unknown session: try the snapshot the session file kept, then give up and
    // use our own. Reading it also re-registers the session, so the next hook
    // on it does not pay for the file read.
    const store = storeFor(config.dataDir);
    const persisted = readSessionConfig(store.readSession(sessionId).config, own);
    if (persisted !== undefined) {
      registry.start(sessionId, config.dataDir, persisted);
      const sessionConfig = hookConfigFrom(persisted, config.apiKey, config.dataDir, config.masterSwitchPath);
      const missionClosureForSession = closureFor(sessionConfig, store);
      return {
        model,
        config: sessionConfig,
        store,
        ledger: ledgerFor(config.dataDir),
        now: () => Date.now(),
        ...(missionClosureForSession === undefined ? {} : { missionClosure: missionClosureForSession }),
      };
    }

    const missionClosureForSession = closureFor(config, store);
    return {
      model,
      config,
      store,
      ledger: ledgerFor(config.dataDir),
      now: () => Date.now(),
      ...(missionClosureForSession === undefined ? {} : { missionClosure: missionClosureForSession }),
    };
  };

  return { depsFor };
}

function stateFrom(
  config: HookConfig,
  handle: DaemonHandle,
  counters: DaemonCounters,
  restarts: number,
  run: DaemonState["state"],
): DaemonState {
  const bundle = bundleIdentity();
  return {
    pid: process.pid,
    port: handle.port,
    version: HOOK_VERSION,
    protocol: PROTOCOL,
    bundle_path: bundle.path,
    bundle_mtime: bundle.mtime,
    data_dir: config.dataDir,
    started_at: handle.startedAt,
    updated_at: Date.now(),
    state: run,
    counters,
    restarts,
  };
}

/**
 * What the model wrappers know that the server cannot.
 *
 * The server never makes a Jev call — a handler does — so it has no way to
 * count them. The memo does, because every call goes through it: a miss is a
 * call that went out, a hit is one that did not, and an error it saw on the way
 * back is an error. Handed to `startDaemon` so `/v1/health` and the state file
 * report the same numbers rather than two different halves of the truth.
 */
function modelStatsOf(memo: MemoizedModel | undefined): (() => Partial<DaemonCounters>) | undefined {
  if (memo === undefined) return undefined;
  return (): Partial<DaemonCounters> => {
    const stats = memo.stats();
    return {
      jev_calls: stats.misses,
      memo_hits: stats.hits,
      jev_timeouts: stats.timeouts,
      jev_errors: stats.errors,
    };
  };
}

export async function runDaemon(argv: readonly string[], env: Env): Promise<void> {
  const config = loadHookConfig(env);
  if (config.disabled || isGloballyDisabled(config.dataDir, config.masterSwitchPath, REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH)) return;
  const startingGeneration = readMasterSwitch(
    config.dataDir,
    false,
    config.masterSwitchPath,
    REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH,
  ).generation;
  const switchStillCurrent = (): boolean => {
    const current = readMasterSwitch(
      config.dataDir,
      false,
      config.masterSwitchPath,
      REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH,
    );
    return !config.disabled && current.effective === "ON" && current.generation === startingGeneration;
  };
  const port = parsePort(argv) ?? config.daemonPort;
  const previous = readDaemonState(config.dataDir);
  const restarts = previous === undefined ? 0 : previous.restarts + 1;

  const { model, memo } = buildDaemonModel(config);
  const modelStats = modelStatsOf(memo);
  const registry = new SessionRegistry();
  const { depsFor } = makeDepsFor(config, model, registry);

  let stopping = false;
  let handle: DaemonHandle | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const shutdown = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    void (async (): Promise<void> => {
      if (handle !== undefined) {
        // `close()` stops the listener first, so a replacement can bind the
        // port while this one is still finishing what it started.
        await Promise.race([handle.close(), new Promise((resolve) => setTimeout(resolve, DRAIN_MS))]);
        writeDaemonState(config.dataDir, stateFrom(config, handle, handle.stats(), restarts, "stopped"));
      }
      process.stderr.write(`[jev-daemon] stopped (${reason})\n`);
      process.exit(0);
    })();
  };

  // Every key the environment holds, not only the one `loadHookConfig` picked:
  // the hooks interpolate both the plugin option and the shell's key — plus
  // the daemon's own local capability token, so loopback posts authenticate
  // even when no provider key is configured anywhere.
  const daemonToken = loadOrMintDaemonToken(config.dataDir);
  const adminToken = loadOrMintAdminToken(config.dataDir);
  const keys = [...expectedKeysFrom(env), ...(daemonToken === undefined ? [] : [daemonToken])];
  try {
    handle = await startDaemon({
      port,
      expectedKeys: keys,
      ...(daemonToken === undefined ? {} : { daemonTokenFingerprint: keyFingerprint(daemonToken) }),
      dataDir: config.dataDir,
      masterSwitchPath: config.masterSwitchPath,
      requireRootOwnedMasterSwitch: REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH,
      allowedDataRoots: [config.dataDir],
      ...(adminToken === undefined ? {} : { adminToken }),
      depsFor,
      registry,
      idleMs: config.daemonIdleMs,
      onExitRequested: () => shutdown("idle"),
      ...(modelStats !== undefined ? { modelStats } : {}),
    });
    // The listener may take time to bind. Do not publish a daemon whose
    // startup crossed an OFF or any intervening switch transition.
    if (!switchStillCurrent()) {
      await handle.close();
      return;
    }
  } catch (error) {
    // The usual cause is something else on the port. Record it so
    // `/jev:status` can say so, and leave: a daemon that cannot listen has
    // nothing to offer, and the hooks fail open without it.
    if (!switchStillCurrent()) return;
    const code = (error as { code?: string }).code;
    const bundle = bundleIdentity();
    writeDaemonState(config.dataDir, {
      pid: process.pid,
      port,
      version: HOOK_VERSION,
      protocol: PROTOCOL,
      bundle_path: bundle.path,
      bundle_mtime: bundle.mtime,
      data_dir: config.dataDir,
      started_at: Date.now(),
      updated_at: Date.now(),
      state: code === "EADDRINUSE" ? "port-conflict" : "stopped",
      counters: emptyCounters(),
      restarts,
    });
    process.stderr.write(`[jev-daemon] cannot listen on 127.0.0.1:${port}: ${String(code ?? error)}\n`);
    process.exit(0);
  }

  const live = handle;
  // Install shutdown handlers before publishing `running`: a supervisor can
  // observe the state file and send SIGTERM immediately. If the signal lands
  // in this startup window without a handler, the process exits with stale
  // running state and no port-release record.
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // A crash in a detached process with nobody watching is still better spent
  // writing `stopped` than leaving a state file that claims to be running.
  process.on("uncaughtException", (error) => {
    process.stderr.write(`[jev-daemon] uncaught: ${String(error)}\n`);
    shutdown("uncaught");
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[jev-daemon] unhandled rejection: ${String(reason)}\n`);
  });

  writeDaemonState(config.dataDir, stateFrom(config, live, live.stats(), restarts, "running"));

  heartbeat = setInterval(() => {
    writeDaemonState(config.dataDir, stateFrom(config, live, live.stats(), restarts, "running"));
  }, HEARTBEAT_MS);
  // Do not hold the loop open on the heartbeat alone: the listener is what
  // keeps this process alive, and it should be the only thing that does.
  heartbeat.unref();

  const banner = daemonStartupBanner({
    version: HOOK_VERSION,
    protocol: PROTOCOL,
    port: live.port,
    dataDir: config.dataDir,
    keyCount: keys.length,
    restarts,
  });
  process.stderr.write(`${banner.line}\n`);
  if (banner.warning !== undefined) process.stderr.write(`${banner.warning}\n`);
}
