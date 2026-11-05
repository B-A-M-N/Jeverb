/**
 * The hook runtime. One process, one event, one JSON object on stdout — or
 * nothing at all, which is the common case.
 *
 * Three rules shape this file:
 *
 * 1. **Fail open, silently.** Every failure — no key, a timeout, a network
 *    error, malformed stdin, a bug in a handler — ends as exit 0 with empty
 *    stdout. The error goes to the decision log. A permission hook that breaks
 *    someone's session because an API was down is worse than no hook.
 * 2. **stdout is protocol.** Nothing else is ever written there.
 * 3. **Bounded time.** The handler races a hard wall-clock timer well inside
 *    the 5-second `timeout` declared in hooks.json, so Claude Code never has to
 *    kill us.
 *
 * It must also stay small: no MCP SDK, no zod. Everything it imports is either
 * a node builtin or part of the dependency-free decision core.
 *
 * Since 0.4.0 the same binary has three other jobs: `daemon` runs the loopback
 * server the `type: "http"` hooks talk to, `daemon-ctl` is what `/jev:daemon`
 * calls, and `SessionStart` starts or replaces the daemon after running its own
 * handler. Everything about that is still fail-open: SessionStart exits 0 with
 * or without a daemon, and a session with no daemon is a session with no hooks,
 * not a broken one.
 */

import { join } from "node:path";
import { buildDecisionModel } from "../jev/factory.js";
import { UNIFIED_POLICY_VERSION, type DecisionModel } from "../decision/types.js";
import { EvidenceLedger } from "../evidence/ledger.js";
import { loadHookConfig, resolveMuseDataDir, writeAdversarialClosure, type HookConfig } from "./config.js";
import { expectedKeysFrom, keyFingerprint } from "./daemon/auth.js";
import { ensureDaemon, probeHealth, replaceDaemon, stopDaemon, type EnsureResult } from "./daemon/control.js";
import { daemonTokenPath, loadOrMintDaemonToken } from "./daemon/state-file.js";
import { runDaemon } from "./daemon/main.js";
import { PROTOCOL } from "./daemon/protocol.js";
import { sessionConfigOf } from "./daemon/registry.js";
import { HANDLERS, runEvent, withDeadline, withDeadlineResult, WALL_CLOCK_MS } from "./dispatch.js";
import { calibrateReport, daemonReport, daemonView, statusReport, whyReport, type WhyFilter } from "./report.js";
import { Store, readMasterSwitch } from "./store.js";
import type { Deps, HookInput, HookOutput } from "./types.js";
import { createControlServiceProofPlanClosureRunner, createSessionMissionClosureRunner, resolveTrustedRunnerOptions } from "../mission/runtime.js";
import { isGitCommit } from "./handlers/commit.js";
import { normalizeToolName } from "./types.js";
import { PROTECTED_MASTER_SWITCH_PATH, REQUIRE_ROOT_OWNED_SWITCH } from "../control/constants.js";
import type { HostProofPlanInput } from "../mission/proof-plan.js";

export { HANDLERS, runEvent, WALL_CLOCK_MS } from "./dispatch.js";

/**
 * Budget for the daemon half of SessionStart.
 *
 * SessionStart's `timeout` is 5 s. The handler itself makes no network call, so
 * nearly all of it is available — but a spawn plus a health wait plus a session
 * registration should not get anywhere near it, and if it does, exiting without
 * a daemon beats being killed.
 */
export const SESSION_START_DAEMON_MS = 3500;

/** `POST /v1/session/start` is one small loopback request. Give it little. */
const SESSION_POST_MS = 700;

/**
 * Ledger opts bound to the same protected control state that gates
 * enforcement. A receipt suppressed by any lesser signal would let
 * enforcement proceed without its evidence trail.
 */
function ledgerSwitchOpts(config: { masterSwitchPath: string }): {
  switchPath: string;
  requireRootOwnedSwitch: boolean;
} {
  return {
    switchPath: config.masterSwitchPath,
    requireRootOwnedSwitch: REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH,
  };
}

/**
 * Trusted-evidence runner args from explicit operator opt-in. Returns `{}`
 * (no trusted keys at all) unless `JEVERB_TRUSTED_GRAPH_EVIDENCE=1` is set
 * in the host environment — hook transports may sanitize env, so an
 * unsupplied value keeps the trusted path OFF rather than half-enabling
 * it. Structured host state (associations, verdicts) is never derived here.
 */
function trustedRunnerArgs(): { enableTrustedGraphEvidence?: true; trustedVerifierIds?: string[] } {
  const resolved = resolveTrustedRunnerOptions(process.env);
  return {
    ...(resolved.enableTrustedGraphEvidence === true ? { enableTrustedGraphEvidence: true as const } : {}),
    ...(resolved.trustedVerifierIds === undefined ? {} : { trustedVerifierIds: resolved.trustedVerifierIds }),
  };
}

export function buildDeps(
  config: HookConfig,
  model?: DecisionModel | null,
  missionClosure?: Deps["missionClosure"],
): Deps {
  const resolved =
    model !== undefined
      ? model
      : config.apiKey === null && config.backend !== "jev-gateway"
        ? null
        : buildDecisionModel({
            apiKey: config.apiKey ?? undefined,
            backend: config.backend,
            baseUrl: config.baseUrl,
            model: config.model,
            timeoutMs: config.timeoutMs,
            maxRetries: config.maxRetries,
            allowCustomRelay: config.allowCustomRelay,
          });
  const store = new Store(config.dataDir, {
    masterSwitchPath: config.masterSwitchPath,
    requireRootOwnedMasterSwitch: REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH,
  });
  const ledger = new EvidenceLedger(
    join(config.dataDir, "evidence.log"),
    { ...(process.argv[1] === undefined ? {} : { bundlePath: process.argv[1] }), ...ledgerSwitchOpts(config) },
  );
  const trustedOptions = trustedRunnerArgs();
  const defaultClosureRunner = resolved === null ? undefined : createSessionMissionClosureRunner({
    model: resolved,
    config,
    store,
    ledger,
    now: () => Date.now(),
    adversarial: config.adversarialClosure,
    ...trustedOptions,
  });
  const closureRunner = missionClosure ?? (defaultClosureRunner === undefined
    ? undefined
    : trustedOptions.enableTrustedGraphEvidence === true
      ? createControlServiceProofPlanClosureRunner({
          model: resolved as DecisionModel,
          config,
          store,
          ledger,
          now: () => Date.now(),
          adversarial: config.adversarialClosure,
          fallback: defaultClosureRunner,
        })
      : defaultClosureRunner);
  return {
    model: resolved,
    config,
    store,
    now: () => Date.now(),
    // The bundle path anchors the candidate-file fallback: hook transports
    // sanitize env and may resolve host-owned data dirs, but the install
    // root is always reachable from argv.
    ledger,
    ...(closureRunner === undefined ? {} : { missionClosure: closureRunner }),
  };
}

export async function runCommand(command: string, args: string[], deps: Deps): Promise<string | undefined> {
  switch (command) {
    case "status":
      return statusReport(deps.config, deps.store, deps.now(), await daemonView(deps.config, deps.now()));
    case "why": {
      // `why`, `why 5`, `why trips`, `why 5 trips`: the count and the filter
      // are recognized by shape, so the order the user types them in does not
      // matter and a typo falls back to the default rather than to nothing.
      const numeric = args.map((arg) => Number(arg)).find((value) => Number.isFinite(value) && value > 0);
      const filter = args.map((arg) => arg.toLowerCase()).find((arg): arg is WhyFilter =>
        arg === "notes" || arg === "trips" || arg === "all",
      );
      return whyReport(deps.store, numeric === undefined ? 3 : Math.floor(numeric), filter ?? "all");
    }
    case "calibrate":
      return calibrateReport(deps.config, deps.store);
    case "disable":
    case "enable": {
      const disabled = command === "disable";
      return `jev ${disabled ? "OFF" : "ON"} not changed: this command has no trusted operator authorization channel. Use the host-authorized control interface when available.`;
    }
    case "adversarial": {
      // `/jev:adversarial [on|off|status]`: the operator toggle for the
      // closure pair. Persists to the install-scoped data-dir config, the
      // same trust boundary as the planted credential — never session state.
      const sub = (args[0] ?? "status").toLowerCase();
      if (sub === "status" || sub === "") {
        const calibrated = deps.config.missionClosurePolicy.adversarialCalibrationVersion;
        return [
          `adversarial closure pair: ${deps.config.adversarialClosure ? "on" : "off"}`,
          `  adversarial calibration: ${calibrated ?? "missing — pair mode gathers evidence until it is measured"}`,
          `  single-judge closure keeps operating either way.`,
        ].join("\n");
      }
      if (sub !== "on" && sub !== "off") {
        return `usage: adversarial [on|off|status] — currently ${deps.config.adversarialClosure ? "on" : "off"}`;
      }
      const written = writeAdversarialClosure(deps.config.dataDir, sub === "on");
      if (!written.ok) return `adversarial closure not changed: ${written.reason}`;
      return `adversarial closure pair ${sub === "on" ? "enabled" : "disabled"} for this install.\n  ${written.path}\n  Takes effect on the next hook invocation; daemon sessions pick it up when the session (re)starts.`;
    }
    default:
      return undefined;
  }
}

const COMMANDS = new Set(["status", "why", "calibrate", "disable", "enable", "adversarial"]);

/**
 * `/jev:daemon <status|stop|restart>`.
 *
 * `restart` only stops, on purpose. These run through the Bash tool, whose
 * process may be sandboxed, and a daemon that inherited that sandbox would be a
 * daemon that cannot read the data directory or reach the network. The MCP
 * watchdog picks it up within ten seconds, and the next SessionStart certainly
 * does.
 */
async function runDaemonCtl(action: string, config: HookConfig, now: number): Promise<string> {
  const port = config.daemonPort;
  switch (action) {
    case "status":
      return daemonReport(config, await daemonView(config, now), now).join("\n");
    case "stop": {
      const result = await stopDaemon(config.dataDir, port);
      const after = daemonReport(config, await daemonView(config, now), now).join("\n");
      const headline =
        result === "stopped"
          ? `jev daemon stopped (port ${port}).`
          : result === "not-running"
            ? `jev daemon was not running on port ${port}.`
            : `jev daemon on port ${port} did not stop; its pid is still alive.`;
      return `${headline}\n\n${after}`;
    }
    case "restart": {
      const result = await stopDaemon(config.dataDir, port);
      return (
        `${result === "stopped" ? "jev daemon stopped" : `jev daemon was not running on port ${port}`}.\n` +
        "A fresh one is not started from here: this command runs through the Bash tool, whose process may be\n" +
        "sandboxed, and a daemon that inherited that sandbox could not read the data directory. The MCP\n" +
        "server's watchdog starts a replacement within ten seconds, and the next session start does too.\n" +
        "Nothing is broken in the meantime: with no daemon the http hooks fail open and say nothing."
      );
    }
    default:
      return "usage: /jev:daemon status | stop | restart";
  }
}

/** What the user is told when the daemon could not be made to run. */
function daemonSystemMessage(result: EnsureResult, port: number): string | undefined {
  if (result === "conflict") {
    return (
      `[jev] Something other than jev is listening on 127.0.0.1:${port}, so jev's hooks are inactive for this ` +
      `session — they post to that port and whatever is there is not answering as jev. Nothing is blocked and ` +
      `nothing is being sent to it beyond the hook payload. Free the port, or set the jev daemon's port with ` +
      `JEV_DAEMON_PORT and update the plugin's hooks.json URL to match, then restart the session.`
    );
  }
  if (result === "failed") {
    // Deliberately not "the daemon failed": SessionStart gives it about two
    // seconds, which is what fits under the hook's own timeout, and a loaded
    // machine can take longer than that to start a Node process. The daemon may
    // well be up already. The MCP server's watchdog checks every ten seconds.
    return (
      `[jev] jev's judgment daemon did not confirm it was listening on 127.0.0.1:${port} within the time ` +
      `SessionStart has to wait, so the hooks that post to it may be inactive at the start of this session. ` +
      `They fail open: nothing is blocked either way. It may simply have been slow to start — /jev:daemon ` +
      `status says whether it is up now, and the daemon's own output is in daemon.log next to the session files.`
    );
  }
  return undefined;
}

/**
 * The bundle to run as the daemon, or `undefined` when there is not one.
 *
 * Under `tsx` (the dev and test path) `argv[1]` is a TypeScript file that plain
 * `node` cannot execute, so the daemon is simply not started; the tests that
 * want one spawn it explicitly. `JEV_DAEMON_DISABLE=1` turns it off everywhere,
 * which is how the rest of the suite keeps its hands off the real port.
 */
export function daemonBundlePath(env: NodeJS.ProcessEnv = process.env, scriptPath = process.argv[1]): string | undefined {
  if ((env.JEV_DAEMON_DISABLE ?? "").trim() === "1") return undefined;
  if (scriptPath === undefined || scriptPath === "") return undefined;
  if (!scriptPath.endsWith(".mjs") && !scriptPath.endsWith(".js") && !scriptPath.endsWith(".cjs")) return undefined;
  return scriptPath;
}

export type MasterCommand = "off" | "on";

/** Match only a complete control prompt. This deliberately does no interpretation. */
export function parseMasterCommand(prompt: unknown): MasterCommand | null {
  if (typeof prompt !== "string") return null;
  const value = prompt.trim();
  return value === "/jev:off" || value === "/jev:on" ? value.slice(5) as MasterCommand : null;
}

export function rejectUnverifiedMuseMasterCommand(prompt: unknown): Record<string, unknown> | null {
  const action = parseMasterCommand(prompt);
  if (action === null) return null;
  return {
    decision: "block",
    reason: `Jeverb control unavailable: Muse does not provide trusted operator-origin evidence to hooks, and Jeverb has no protected local control service. No state changed.`,
  };
}

/** `POST` a small JSON body to the daemon. Resolves to the status and body. */
async function postJson(
  port: number,
  path: string,
  body: unknown,
  apiKey: string | null,
  timeoutMs: number,
): Promise<{ status: number; body: unknown } | undefined> {
  const { request } = await import("node:http");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { status: number; body: unknown } | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const payload = Buffer.from(JSON.stringify(body ?? {}), "utf8");
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          "content-length": payload.byteLength,
          "x-jev-protocol": String(PROTOCOL),
          ...(apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          } catch {
            parsed = undefined;
          }
          finish({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on("error", () => finish(undefined));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(undefined);
    }, timeoutMs + 50);
    req.on("timeout", () => {
      req.destroy();
      finish(undefined);
    });
    req.on("error", () => finish(undefined));
    req.end(payload);
  });
}

/**
 * SessionStart's second half: make sure the daemon is up, then tell it about
 * this session.
 *
 * Order matters. `ensureDaemon` first, because there is nothing to register
 * with otherwise; the registration second, because a daemon that does not know
 * this session's settings would judge it with its own. A 401 is not reported as
 * an authorization problem — it means the daemon holding the port was
 * configured with a different key, which makes it a stale daemon, so it gets
 * replaced and the registration is tried once more.
 */
async function startDaemonForSession(
  config: HookConfig,
  sessionId: string,
  bundlePath: string,
): Promise<{ result: EnsureResult; systemMessage?: string }> {
  const initialSwitch = readMasterSwitch(
    config.dataDir,
    false,
    config.masterSwitchPath,
    REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH,
  );
  const switchStillCurrent = (): boolean => {
    const current = readMasterSwitch(
      config.dataDir,
      false,
      config.masterSwitchPath,
      REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH,
    );
    return !config.disabled && current.effective === "ON" && current.generation === initialSwitch.generation;
  };
  if (!switchStillCurrent()) return { result: "failed" };
  // Fingerprints of every key this environment holds, so `ensureDaemon`
  // replaces a running daemon that is missing one: a key changed since it
  // started takes effect at the next session start. The daemon's local
  // capability token counts too: a daemon that lost its token file (or never
  // minted one) is stale for the same reason a rotated provider key is.
  const daemonToken = loadOrMintDaemonToken(config.dataDir);
  const options = {
    dataDir: config.dataDir,
    port: config.daemonPort,
    bundlePath,
    env: process.env,
    keyFingerprints: [...expectedKeysFrom(process.env), ...(daemonToken === undefined ? [] : [daemonToken])].map(
      keyFingerprint,
    ),
  };
  let result = await ensureDaemon(options);
  if (!switchStillCurrent()) {
    if (result === "started" || result === "replaced") await stopDaemon(config.dataDir, config.daemonPort);
    return { result: "failed" };
  }
  if (result === "conflict") {
    const message = daemonSystemMessage(result, config.daemonPort);
    return { result, ...(message !== undefined ? { systemMessage: message } : {}) };
  }

  // Register even after a `failed`, which mostly means "did not confirm inside
  // the budget" rather than "will never start". A daemon that came up half a
  // second late still wants to know about this session, and the attempt costs
  // one refused loopback connection if it really is not there.
  const body = {
    session_id: sessionId,
    data_dir: config.dataDir,
    config: sessionConfigOf(config),
    protocol: PROTOCOL,
  };
  // The provider key when there is one, else the daemon's local capability
  // token: session registration is privileged and never rides on a bare
  // session id, so keyless installs authenticate with the token minted above.
  const sessionCredential = config.apiKey ?? daemonToken ?? null;
  let reply = await postJson(config.daemonPort, "/v1/session/start", body, sessionCredential, SESSION_POST_MS);
  if (!switchStillCurrent()) {
    if (result === "started" || result === "replaced") await stopDaemon(config.dataDir, config.daemonPort);
    return { result: "failed" };
  }
  if (reply?.status === 401) {
    result = await replaceDaemon(options);
    if (!switchStillCurrent()) {
      if (result === "started" || result === "replaced") await stopDaemon(config.dataDir, config.daemonPort);
      return { result: "failed" };
    }
    if (result === "conflict" || result === "failed") {
      const message = daemonSystemMessage(result, config.daemonPort);
      return { result, ...(message !== undefined ? { systemMessage: message } : {}) };
    }
    reply = await postJson(config.daemonPort, "/v1/session/start", body, sessionCredential, SESSION_POST_MS);
    if (!switchStillCurrent()) {
      if (result === "started" || result === "replaced") await stopDaemon(config.dataDir, config.daemonPort);
      return { result: "failed" };
    }
  }

  // Only now is a `failed` worth telling the user about: the registration is
  // the second, later chance to find the daemon, and it just missed too.
  if (result === "failed" && reply === undefined) {
    const message = daemonSystemMessage("failed", config.daemonPort);
    return { result, ...(message !== undefined ? { systemMessage: message } : {}) };
  }

  // Keyless installs lose hook coverage silently without this: the daemon
  // holds the minted token, but the http transport can only present what is
  // in the hook environment. Name the exact export — the path, never the
  // value — so the degradation is visible and recoverable instead of silent.
  // Keyed installs and installs that already export the token hear nothing.
  if (reply !== undefined) {
    const providerKey = (config.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.JEV_PLUGIN_API_KEY ?? "").trim();
    const tokenExported = (process.env.JEV_DAEMON_TOKEN ?? "").trim() !== "";
    if (providerKey === "" && !tokenExported && daemonToken !== undefined) {
      const message =
        `jev http hooks cannot authenticate to the loopback daemon: no provider key is configured and ` +
        `JEV_DAEMON_TOKEN is not exported, so hot-path hooks will be refused (and fail open). ` +
        `To enable them, run: export JEV_DAEMON_TOKEN=$(cat ${daemonTokenPath(config.dataDir)})`;
      return { result, systemMessage: message };
    }
  }

  // The daemon may have something to say. Normally it does not.
  const replyBody = reply?.body;
  if (typeof replyBody === "object" && replyBody !== null) {
    const message = (replyBody as { systemMessage?: unknown }).systemMessage;
    if (typeof message === "string" && message.trim() !== "") return { result, systemMessage: message };
  }
  return { result };
}

/**
 * The `UserPromptSubmit` command fallback.
 *
 * `hooks.json` gives UserPromptSubmit both an http entry and this one, so the
 * very first prompt of a session is covered even if the daemon is still coming
 * up. Both would otherwise record the prompt twice, so this probes the port
 * first — a couple of milliseconds in-process, not the 70–80 ms a shell probe
 * costs — and says nothing at all if the daemon answered. `nextPrompts` drops
 * an identical consecutive prompt, so even a lost race is harmless.
 */
async function shouldRunFallback(config: HookConfig): Promise<boolean> {
  const probe = await probeHealth(config.daemonPort, 150);
  return probe.kind !== "jev";
}

export async function main(argv: string[] = process.argv): Promise<void> {
  // Administrative controls are model-independent and run before all normal
  // event initialization. Mutations go only through the OS-authorized service.
  if (argv[2] === "control") {
    const action = argv[3] ?? "status";
    try {
      if (action === "off" || action === "on") {
        const { setControlState } = await import("../control/client.js");
        const result = await setControlState(action);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }
      if (action === "status") {
        const { controlStatus } = await import("../control/client.js");
        const state = await controlStatus();
        const active = state.effective === "ON";
        process.stdout.write(`${JSON.stringify({ ...state, hookBehavior: active ? "active" : "suppressed", mcpBehavior: active ? "active" : "suppressed", daemonWatchdogBehavior: active ? "active" : "suppressed", pluginLoaded: true, operationallyEnabled: active })}\n`);
        return;
      }
      if (action === "attest-pass" || action === "attest-fail") {
        const [missionId, missionRevision, evidenceRevision, candidate] = argv.slice(4);
        if (!missionId || !missionRevision || !evidenceRevision || !candidate) {
          process.stderr.write(`${JSON.stringify({ ok: false, error: "usage: control attest-pass|attest-fail <mission-id> <mission-revision> <evidence-revision> <candidate>" })}\n`);
          process.exitCode = 2;
          return;
        }
        const { attestIndependentVerification } = await import("../control/client.js");
        const result = await attestIndependentVerification({
          result: action === "attest-pass" ? "pass" : "fail",
          missionId,
          missionRevision,
          evidenceRevision,
          candidate,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }
      if (action === "proof-plan-set") {
        const [sessionId, mappingPath] = argv.slice(4);
        if (!sessionId || !mappingPath) {
          process.stderr.write(`${JSON.stringify({ ok: false, error: "usage: control proof-plan-set <session-id> <host-mapping.json>" })}\n`);
          process.exitCode = 2;
          return;
        }
        const { readFileSync } = await import("node:fs");
        const { createSessionMissionClosureSource } = await import("../mission/session-source.js");
        const { buildHostProofPlanPayload } = await import("../mission/proof-plan.js");
        const { hostProofPlanContentDigest } = await import("../mission/proof-plan.js");
        const { loadHookConfig } = await import("./config.js");
        const { Store } = await import("./store.js");
        const { setProofPlan } = await import("../control/client.js");
        const { analyzeCriterionTypeScriptStructure } = await import("../mission/structural-analysis.js");
        const { proofObligationId } = await import("../mission/proof-obligations.js");
        const config = loadHookConfig(process.env);
        const store = new Store(config.dataDir, { masterSwitchPath: config.masterSwitchPath });
        const contract = store.readSession(sessionId).mission_contract;
        if (contract === undefined) throw new Error("session has no explicit user-authored mission contract");
        const raw = readFileSync(mappingPath);
        if (raw.byteLength > 16_384) throw new Error("host proof-plan mapping exceeds 16 KiB");
        const mapping = JSON.parse(raw.toString("utf8")) as HostProofPlanInput;
        const plan = buildHostProofPlanPayload(contract, mapping);
        const associations = plan.criteria.flatMap((criterion) => criterion.producers.map((producer) => ({
          criterionId: criterion.criterionId,
          runId: producer.runId,
          nodeId: producer.nodeId,
          ...(producer.attemptId === undefined ? {} : { attemptId: producer.attemptId }),
        })));
        const snapshot = await createSessionMissionClosureSource({
          store,
          dataDir: config.dataDir,
          now: () => Date.now(),
          enableTrustedGraphEvidence: true,
          criterionProducerAssociations: associations,
        }).load(sessionId, contract.missionId);
        if (snapshot.candidateDigest === undefined) throw new Error("host plan snapshot has no current candidate identity");
        for (const criterion of snapshot.criteria) {
          const planned = plan.criteria.find((row) => row.criterionId === criterion.id);
          if (planned === undefined || criterion.graphEvidence?.length !== planned.producers.length ||
              criterion.graphEvidence.some((row) => row.state !== "bound" || row.provenance !== "host:journal-projection/v2")) {
            throw new Error(`host plan producer mapping is not fully present in the current journal for ${criterion.id}`);
          }
          analyzeCriterionTypeScriptStructure({
            root: plan.workspaceRoot,
            files: planned.codeFiles,
            criterionId: criterion.id,
            proofObligationId: proofObligationId(criterion.id, criterion.statement),
            missionRevision: contract.missionRevision,
            candidateDigest: snapshot.candidateDigest,
          });
        }
        process.stderr.write(`${JSON.stringify({
          review: "The next PolicyKit approval stores this exact host proof plan.",
          missionId: plan.missionId,
          missionRevision: plan.missionRevision,
          objective: contract.objective,
          objectiveSha256: plan.objectiveSha256,
          planDigest: hostProofPlanContentDigest(plan),
          criteria: plan.criteria.map(({ criterionId, requirementSha256, producers, codeFiles, probeActions, repairActions }) => ({
            criterionId,
            requirement: contract.criteria.find((entry) => entry.id === criterionId)?.statement,
            requirementSha256,
            testCommand: mapping.criteria.find((entry) => entry.criterionId === criterionId)?.testCommand,
            producers,
            codeFiles,
            ...(probeActions === undefined ? {} : { approvedProbeActions: probeActions.map(({ id, description, command, commandSha256, producers, nodeId, maxExecutions }) => ({
              id, description, command, commandSha256, producers, nodeId, maxExecutions,
            })) }),
            ...(repairActions === undefined ? {} : { approvedRepairActions: repairActions.map(({ id, description, command, commandSha256, producers, nodeId, maxExecutions }) => ({
              id, description, command, commandSha256, producers, nodeId, maxExecutions,
            })) }),
          })),
        })}\n`);
        const stored = await setProofPlan(plan);
        process.stdout.write(`${JSON.stringify({ ok: true, missionId: stored.missionId, planDigest: stored.planDigest, receiptCorrelationId: stored.receiptCorrelationId })}\n`);
        return;
      }
      if (action === "proof-plan-status") {
        const missionId = argv[4];
        if (!missionId) {
          process.stderr.write(`${JSON.stringify({ ok: false, error: "usage: control proof-plan-status <mission-id>" })}\n`);
          process.exitCode = 2;
          return;
        }
        const { proofPlanStatus } = await import("../control/client.js");
        process.stdout.write(`${JSON.stringify(await proofPlanStatus(missionId))}\n`);
        return;
      }
      process.stderr.write(`${JSON.stringify({ ok: false, error: "usage: control off|on|status|attest-pass|attest-fail|proof-plan-set|proof-plan-status" })}\n`);
      process.exitCode = 2;
    }
    catch (error) {
      process.stderr.write(`${JSON.stringify({ ok: false, action, error: error instanceof Error ? error.message : String(error) })}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (argv[2] === "muse") {
    const event = argv[3] ?? "";
    let dataDir: string;
    try {
      dataDir = resolveMuseDataDir(process.env);
    } catch (error) {
      process.stderr.write(`[jeverb] muse_data_dir_unavailable event=${event}: ${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }
    const config = loadHookConfig({ ...process.env, JEV_HOOKS_DATA_DIR: dataDir });
    const { isGloballyDisabled } = await import("./store.js");
    let raw = "";
    // UserPromptSubmit is the sole pre-model control channel. Read its bounded
    // payload before the OFF short circuit so /jev:on remains reachable.
    if (event === "UserPromptSubmit") {
      const { readStdinText } = await import("../hosts/muse/io.js");
      try {
        raw = process.stdin.isTTY === true ? "" : await readStdinText();
      } catch {
        if (config.disabled || isGloballyDisabled(config.dataDir, config.masterSwitchPath, REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH)) return;
        process.stderr.write(`[jeverb] hook_input_error event=${event}: stdin read failed\n`);
        return;
      }
      let candidate: unknown;
      try {
        candidate = JSON.parse(raw);
      } catch {
        candidate = undefined;
      }
      if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
        const prompt = (candidate as { prompt?: unknown }).prompt;
        if (parseMasterCommand(prompt) !== null) {
          try {
            process.stdout.write(JSON.stringify(rejectUnverifiedMuseMasterCommand(prompt)));
          } catch (error) {
            process.stdout.write(JSON.stringify({ decision: "block", reason: `Jeverb control failed: ${error instanceof Error ? error.message : String(error)}` }));
          }
          return;
        }
      }
    } else if (config.disabled || isGloballyDisabled(config.dataDir, config.masterSwitchPath, REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH)) {
      return;
    }
    if (config.disabled || isGloballyDisabled(config.dataDir, config.masterSwitchPath, REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH)) return;

    const { dispatchEvent, recordDeadlineExceeded, recordInitError, recordInputFailure, recordProtectedInitDeny } = await import("./unified.js");
    const { toMuseOutput } = await import("../hosts/muse/outputs.js");
    const { ReviewService } = await import("../review/service.js");
    const { loadReviewConfig } = await import("../review/load-config.js");
    const { redact } = await import("./redact.js");
    const { readStdinText } = await import("../hosts/muse/io.js");
    if (event !== "UserPromptSubmit") {
      try {
        raw = process.stdin.isTTY === true ? "" : await readStdinText();
      } catch (error) {
        const ledger = new EvidenceLedger(
          join(config.dataDir, "evidence.log"),
          { ...(process.argv[1] === undefined ? {} : { bundlePath: process.argv[1] }), ...ledgerSwitchOpts(config) },
        );
        recordInputFailure(ledger, event, error);
        process.stderr.write(`[jeverb] hook_input_error event=${event}: stdin read failed\n`);
        return;
      }
    }
    let input: Parameters<typeof dispatchEvent>[1];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      const ledger = new EvidenceLedger(
        join(config.dataDir, "evidence.log"),
        { ...(process.argv[1] === undefined ? {} : { bundlePath: process.argv[1] }), ...ledgerSwitchOpts(config) },
      );
      recordInputFailure(ledger, event, error);
      process.stderr.write(`[jeverb] hook_input_error event=${event}: malformed JSON\n`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      const ledger = new EvidenceLedger(
        join(config.dataDir, "evidence.log"),
        { ...(process.argv[1] === undefined ? {} : { bundlePath: process.argv[1] }), ...ledgerSwitchOpts(config) },
      );
      recordInputFailure(ledger, event, new TypeError("expected a JSON object"));
      process.stderr.write(`[jeverb] hook_input_error event=${event}: expected a JSON object\n`);
      return;
    }
    input = parsed as HookInput;
    // Parse first, construct second: a model-construction failure (bad
    // backend/model pair, unapproved relay) must still leave a typed
    // receipt, so the ledger is built independently of the model.
    let deps: ReturnType<typeof buildDeps>;
    try {
      deps = buildDeps(config);
    } catch (err) {
      const rawCommand = typeof input.tool_input?.command === "string" ? input.tool_input.command : undefined;
      const protectedCommit = config.commitEnforcement === "mandatory" && event === "PreToolUse" && normalizeToolName(input.tool_name) === "Bash" && isGitCommit(rawCommand);
      let protectedCommitDecision: Awaited<ReturnType<typeof failClosedMuseCommitOnInitError>>;
      try {
        protectedCommitDecision = await failClosedMuseCommitOnInitError(event, input, config, err);
      } catch {
        protectedCommitDecision = undefined;
      }
      if (protectedCommitDecision !== undefined) {
        const output = toMuseOutput(event as never, protectedCommitDecision);
        if (output !== undefined) process.stdout.write(JSON.stringify(output));
      } else if (protectedCommit) {
        const ledger = new EvidenceLedger(
          join(config.dataDir, "evidence.log"),
          { ...(process.argv[1] === undefined ? {} : { bundlePath: process.argv[1] }), ...ledgerSwitchOpts(config) },
        );
        recordProtectedInitDeny(ledger, event, input, err);
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "[jev] model initialization or review dispatch failed; refusing protected commit",
          },
        }));
      } else {
        const ledger = new EvidenceLedger(
          join(config.dataDir, "evidence.log"),
          { ...(process.argv[1] === undefined ? {} : { bundlePath: process.argv[1] }), ...ledgerSwitchOpts(config) },
        );
        recordInitError(ledger, event, input, err);
      }
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      process.stderr.write(`[jeverb] model_init_error event=${event}: ${redact(message).slice(0, 300)}\n`);
      return;
    }
    // Bundle-relative resolution: works from a checkout and from the
    // installed plugin cache. Absent/partial/invalid configs fail closed
    // inside the review service; uncalibrated ones refuse to judge. A
    // configured qualification manifest is re-verified here, at the
    // enforcement boundary, before any calibrated claim is honored.
    const { gateReviewOnManifest } = await import("../review/load-config.js");
    const { HOOK_VERSION } = await import("./version.js");
    const baseLoaded = loadReviewConfig();
    const loaded = gateReviewOnManifest(
      baseLoaded,
      {
        backend: config.backend,
        model: config.model,
        modelVersion: baseLoaded.calibration.modelVersion ?? config.model,
        adapterVersion: HOOK_VERSION,
      },
      (message) => process.stderr.write(`[jeverb] ${message}\n`),
    );
    const review = new ReviewService(deps.model, {
      checks: (loaded.checks ?? []) as never,
      policy: loaded.policy,
      ...(loaded.status !== undefined ? { status: loaded.status } : {}),
      ...(loaded.invalid !== undefined ? { invalid: loaded.invalid } : {}),
      expectedCalibration: {
        backend: config.backend,
        model: config.model,
        questionHash: loaded.questionHash,
        ...(loaded.calibration.modelVersion === undefined ? {} : { modelVersion: loaded.calibration.modelVersion }),
        ...(loaded.calibration.calibrationVersion === undefined ? {} : { calibrationVersion: loaded.calibration.calibrationVersion }),
        ...(loaded.calibration.datasetRevision === undefined ? {} : { datasetRevision: loaded.calibration.datasetRevision }),
        ...(loaded.calibration.evaluationHash === undefined ? {} : { evaluationHash: loaded.calibration.evaluationHash }),
      },
    });
    const outputGeneration = deps.store.masterSwitchStatus().generation;
    const outputStillCurrent = (): boolean => {
      const current = deps.store.masterSwitchStatus();
      return !config.disabled && current.effective === "ON" && current.generation === outputGeneration;
    };
    const settled = await withDeadlineResult(dispatchEvent(event, input, { ...deps, review, authorizationHost: "muse" }), WALL_CLOCK_MS);
    if (!outputStillCurrent()) return;
    if (settled.timedOut) {
      // The deadline expired before the judgment settled: record a typed
      // timeout receipt instead of a fabricated "did not judge", stay
      // silent on stdout, and fail open. The detached judgment may still
      // land its own receipt under the same decision id.
      const ledger = new EvidenceLedger(
        join(config.dataDir, "evidence.log"),
        { ...(process.argv[1] === undefined ? {} : { bundlePath: process.argv[1] }), ...ledgerSwitchOpts(config) },
      );
      recordDeadlineExceeded(ledger, event, input, WALL_CLOCK_MS);
      process.stderr.write(`[jeverb] hook_deadline_exceeded event=${event} budget_ms=${WALL_CLOCK_MS}\n`);
      return;
    }
    const output = settled.value === undefined ? undefined : toMuseOutput(event as never, settled.value);
    if (!outputStillCurrent()) return;
    if (output !== undefined) process.stdout.write(JSON.stringify(output));
    return;
  }

  const event = argv[2] ?? "";

  // The daemon parses its own configuration: it is not serving one session's
  // hook, it is about to serve everybody's.
  if (event === "daemon") {
    const config = loadHookConfig(process.env);
    const { isGloballyDisabled } = await import("./store.js");
    if (config.disabled || isGloballyDisabled(config.dataDir, config.masterSwitchPath, REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH)) return;
    await runDaemon(argv.slice(3), process.env);
    return;
  }

  const config = loadHookConfig();

  if (event === "daemon-ctl") {
    const action = argv[3] ?? "status";
    const { isGloballyDisabled } = await import("./store.js");
    if ((config.disabled || isGloballyDisabled(config.dataDir, config.masterSwitchPath, REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH)) && action !== "status") return;
    const text = await runDaemonCtl(action, config, Date.now());
    process.stdout.write(`${text}\n`);
    return;
  }

  if (event === "disable" || event === "enable" || event === "status") {
    if (event === "status") {
      const store = new Store(config.dataDir, {
        masterSwitchPath: config.masterSwitchPath,
        requireRootOwnedMasterSwitch: REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH,
      });
      const text = await statusReport(config, store, Date.now(), await daemonView(config, Date.now()));
      process.stdout.write(`${text}\n`);
      return;
    }
    process.stdout.write(`jev hooks ${event === "disable" ? "disable" : "enable"} not changed: no protected operator control service is configured.\n`);
    return;
  }

  const { isGloballyDisabled } = await import("./store.js");
  if (config.disabled || isGloballyDisabled(config.dataDir, config.masterSwitchPath, REQUIRE_ROOT_OWNED_SWITCH && config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH)) return;

  // Same ledger-first rule as the Muse path: a model-construction failure
  // leaves a typed receipt instead of a silent exit. No parsed input exists
  // this early on the command path, so the receipt carries the event with an
  // unknown session rather than nothing at all.
  let deps: ReturnType<typeof buildDeps>;
  try {
    deps = buildDeps(config);
  } catch (err) {
    const { recordInitError } = await import("./unified.js");
    const { redact } = await import("./redact.js");
    const ledger = new EvidenceLedger(
      join(config.dataDir, "evidence.log"),
      { ...(process.argv[1] === undefined ? {} : { bundlePath: process.argv[1] }), ...ledgerSwitchOpts(config) },
    );
    recordInitError(ledger, event, {} as never, err);
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    process.stderr.write(`[jeverb] model_init_error event=${event}: ${redact(message).slice(0, 300)}\n`);
    return;
  }

  if (COMMANDS.has(event)) {
    // Reports are for a person, so they may write plain text and take their
    // time; they still must not throw.
    const text = await runCommand(event, argv.slice(3), deps);
    if (text !== undefined) process.stdout.write(`${text}\n`);
    return;
  }

  if (!(event in HANDLERS)) return;

  const fallback = argv.includes("--fallback");
  if (fallback && !(await shouldRunFallback(config))) return;

  const { readStdinText } = await import("../hosts/muse/io.js");
  let raw: string;
  try {
    raw = process.stdin.isTTY === true ? "" : await readStdinText();
  } catch (error) {
    if (deps.ledger !== undefined) {
      const { recordInputFailure } = await import("./unified.js");
      recordInputFailure(deps.ledger, event, error);
    }
    process.stderr.write(`[jeverb] hook_input_error event=${event}: stdin read failed\n`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (deps.ledger !== undefined) {
      const { recordInputFailure } = await import("./unified.js");
      recordInputFailure(deps.ledger, event, error);
    }
    process.stderr.write(`[jeverb] hook_input_error event=${event}: malformed JSON object\n`);
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const error = new TypeError("expected a JSON object");
    if (deps.ledger !== undefined) {
      const { recordInputFailure } = await import("./unified.js");
      recordInputFailure(deps.ledger, event, error);
    }
    process.stderr.write(`[jeverb] hook_input_error event=${event}: expected a JSON object\n`);
    return;
  }
  const hookInput = parsed as HookInput;
  const legacyOutputGeneration = deps.store.masterSwitchStatus().generation;
  const legacyOutputStillCurrent = (): boolean => {
    const current = deps.store.masterSwitchStatus();
    return !config.disabled && current.effective === "ON" && current.generation === legacyOutputGeneration;
  };
  let output: HookOutput | undefined;
  try {
    // The deadline cancels in-flight model work, not just this caller's
    // verdict: the same budget that marks the race timed out aborts the
    // handler's fetch, so nothing keeps running detached to its own
    // timeoutMs. Judgment semantics, timeouts, and retries are unchanged —
    // this is purely lifecycle plumbing.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), WALL_CLOCK_MS);
    let settled: { value: HookOutput | undefined; timedOut: boolean };
    try {
      settled = await withDeadlineResult(runEvent(event, raw, deps, controller.signal), WALL_CLOCK_MS);
    } finally {
      clearTimeout(abortTimer);
    }
    if (!legacyOutputStillCurrent()) return;
    if (settled.timedOut) {
      if (deps.ledger !== undefined) {
        const { recordDeadlineExceeded } = await import("./unified.js");
        recordDeadlineExceeded(deps.ledger, event, hookInput, WALL_CLOCK_MS);
      }
      process.stderr.write(`[jeverb] hook_deadline_exceeded event=${event} budget_ms=${WALL_CLOCK_MS}\n`);
      return;
    }
    output = settled.value;
  } catch (error) {
    if (deps.ledger !== undefined) {
      const { recordRuntimeFailure } = await import("./unified.js");
      recordRuntimeFailure(deps.ledger, event, hookInput, error);
    }
    process.stderr.write(`[jeverb] hook_runtime_error event=${event}: handler failed\n`);
    return;
  }

  // SessionStart is the only event that also runs the daemon's control plane.
  // It happens after the handler so that a slow or failing spawn can never
  // delay or suppress the one thing SessionStart exists to say.
  let merged: HookOutput | undefined = output;
  if (event === "SessionStart" && legacyOutputStillCurrent()) {
    const bundlePath = daemonBundlePath();
    if (bundlePath !== undefined) {
      let sessionId = "unknown";
      try {
        const parsed = JSON.parse(raw) as { session_id?: unknown };
        if (typeof parsed.session_id === "string" && parsed.session_id.trim() !== "") sessionId = parsed.session_id;
      } catch {
        // No session id: the daemon will fall back to its own config.
      }
      const started = await withDeadline(
        startDaemonForSession(config, sessionId, bundlePath),
        SESSION_START_DAEMON_MS,
      );
      if (!legacyOutputStillCurrent()) {
        if (started?.result === "started" || started?.result === "replaced") await stopDaemon(config.dataDir, config.daemonPort);
        return;
      }
      if (started?.systemMessage !== undefined) {
        merged = {
          ...(merged ?? {}),
          systemMessage:
            merged?.systemMessage === undefined
              ? started.systemMessage
              : `${merged.systemMessage}\n${started.systemMessage}`,
        };
      }
      // Keep the snapshot on disk too, so a daemon replaced later in this
      // session can reload this session's settings instead of using its own.
      try {
        deps.store.updateSession(sessionId, (state) => ({ ...state, config: sessionConfigOf(config) }), deps.now());
      } catch {
        // Best effort, like everything else this store does.
      }
    }
  }

  if (!legacyOutputStillCurrent()) return;
  if (merged !== undefined) process.stdout.write(JSON.stringify(merged));
}

/**
 * A malformed or unusable model/backend configuration must not turn a
 * protected commit into an implicit allow. Keep this exception narrow: other
 * hook events retain the documented typed-error/degraded path.
 */
export async function failClosedMuseCommitOnInitError(
  event: string,
  input: Parameters<(typeof import("./unified.js"))['dispatchEvent']>[1],
  config: HookConfig,
  error: unknown,
): Promise<Awaited<ReturnType<(typeof import("./unified.js"))['dispatchEvent']>> | undefined> {
  if (event !== "PreToolUse" || input.tool_name !== "Bash") return undefined;
  if (config.commitEnforcement !== "mandatory") return undefined;
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : undefined;
  const { isGitCommit } = await import("./handlers/commit.js");
  if (!isGitCommit(command)) return undefined;

  const [{ dispatchEvent, newDecisionId }, { ReviewService }, { loadReviewConfig }] = await Promise.all([
    import("./unified.js"),
    import("../review/service.js"),
    import("../review/load-config.js"),
  ]);
  const deps = buildDeps(config, null);
  const loaded = loadReviewConfig();
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const review = new ReviewService(null, {
    checks: (loaded.checks ?? []) as never,
    policy: loaded.policy,
    status: "invalid",
    invalid: `Jev model initialization failed (${errorName}); refusing protected commit`,
    expectedCalibration: { backend: config.backend, model: config.model },
  });
  const decision = await dispatchEvent(event, input, { ...deps, review, authorizationHost: "muse" });
  return decision ?? {
    event,
    enforcement: "deny",
    source: "deterministic",
    reasons: ["[jev] model initialization or review dispatch failed; refusing protected commit"],
    evidence: [],
    judgment: "MODEL_INITIALIZATION_ERROR",
    policyVersion: UNIFIED_POLICY_VERSION,
    decisionId: newDecisionId(),
  };
}
