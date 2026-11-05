/**
 * Constrained execution for graph shell nodes.
 *
 * `workspaceRoot` is a starting directory, not a boundary: without
 * isolation a node can read absolute paths, climb out with `..`, reach the
 * network, and inherit the operator's secrets from the environment. This
 * runner owns the controls that make a shell node more than an approved
 * `bash -c` string:
 *
 * - isolation backend is mandatory: every node runs inside `bwrap`
 *   (bubblewrap). If the binary is missing or fails its confinement probe,
 *   execution is refused outright — there is no silent downgrade to an
 *   unrestricted shell, because a filtered environment and a working
 *   directory are NOT filesystem isolation;
 * - filesystem exposure is the approved workspace (bound at `/work`,
 *   read-only under the inspect profile or `readOnlyWorkspace`) plus the
 *   minimal read-only toolchain (`/usr`, `/bin`, `/lib`, `/lib64`) and
 *   kernel pseudo-filesystems (`/proc`, `/dev`). Host configuration
 *   (`/etc`, `/opt`) is deliberately NOT bound. Nothing else is visible —
 *   not the operator's home, not credentials, not daemon state;
 * - environment allowlist: only `PATH`, `HOME` (`/work`), `LANG`, and
 *   `TMPDIR` (`/tmp`) survive, so provider keys, daemon tokens, and
 *   session material never cross into node execution;
 * - hard resource ceilings (address space, process count, file size, CPU
 *   seconds) via the execution profile or an explicit operator override;
 * - network namespace is unshared unless the policy explicitly allows
 *   network access;
 * - bounded time and output, caller-abort propagation, and orphan reaping
 *   through bubblewrap's namespace lifecycle.
 *
 * A timeout kill or a death by signal leaves side effects uncertain, so both
 * report `outcome_unknown` and force reconciliation instead of a silent
 * retry or a success claim. Plain command failure (nonzero exit) is an
 * ordinary failure.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { limitsFor, type ResourceLimits, type SandboxProfile } from "./policy.js";

export interface ShellRunOptions {
  workspaceRoot: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Remaining graph budget in ms. The effective timeout is the smaller of
   * this and `timeoutMs`, so a per-node budget can never overrun a
   * nearly-spent graph budget.
   */
  deadlineMs?: number;
  allowNetwork: boolean;
  maxOutputBytes?: number;
  /** Execution profile selecting the resource-limit preset. */
  profile?: SandboxProfile;
  /** Explicit operator override; otherwise the profile preset applies. */
  resourceLimits?: ResourceLimits;
  /**
   * Bind the workspace read-only (`inspect` profile implies this). Nodes
   * keep a writable `/tmp` tmpfs for scratch.
   */
  readOnlyWorkspace?: boolean;
  /** Explicit dependency outputs, isolated from shell source and inherited env. */
  bindings?: Record<string, string>;
}

export interface ExtractorPluginRunOptions {
  workspaceRoot: string;
  modulePath: string;
  pluginRoot: string;
  pluginName: string;
  expectedHash: string;
  phase: "metadata" | "run";
  input: unknown;
  config: Record<string, unknown>;
  timeoutMs: number;
  allowNetwork: boolean;
  signal?: AbortSignal;
  onExec?: (command: string) => Promise<string>;
  onArtifact?: (content: string) => Promise<string>;
}

export interface ShellRunResult {
  /** Trimmed stdout on success, bounded by `maxOutputBytes`. */
  output: string;
  /**
   * Always true: a node that cannot prove confinement never runs, so a
   * returned result was produced inside the sandbox.
   */
  sandboxed: boolean;
  /**
   * True when stdout reached the configured cap and was cut. The digest
   * in the run journal then attests to the truncated excerpt, not the
   * complete command output — callers must not mistake it for full
   * evidence.
   */
  truncated: boolean;
  /** Which stream hit the cap and what the cap was, when truncated. */
  truncationReason?: string;
}

/** Env vars a shell node inherits. Everything else is dropped — in
 * particular provider keys (`*_API_KEY`), daemon capability tokens, and
 * session material never cross into node execution. */
const SAFE_ENV: { PATH: string; HOME: string; LANG: string } = {
  PATH: "/usr/bin:/bin",
  HOME: "/work",
  LANG: "C.UTF-8",
};

let probeResult: boolean | undefined;

/**
 * Whether the confinement backend is operational. More than a binary
 * presence check: runs the production sandbox argv against a probe
 * workspace and requires a canary file outside it to stay unreadable while
 * a file inside stays usable. Cached per process; a backend that breaks
 * mid-process fails closed on every node, not just the next probe.
 */
export async function isSandboxAvailable(): Promise<boolean> {
  if (probeResult !== undefined) return probeResult;
  try {
    probeResult = await probeConfinement();
  } catch {
    probeResult = false;
  }
  return probeResult;
}

/**
 * System paths every node needs: the toolchain (`/usr`, `/bin`) and the
 * dynamic loader (`/lib`, `/lib64` — symlinks on usr-merged systems, which
 * bwrap resolves when binding). Bound read-only: the node can execute the
 * toolchain but cannot modify it. Deliberately NOT bound: `/etc` and `/opt`
 * (host configuration is not a runtime dependency — a node has no business
 * reading it), and everything else on the host.
 */
function systemBinds(): string[] {
  return ["--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64"];
}

/**
 * Resource ceilings, applied inside the sandbox before the command runs.
 * Each dimension is set hard (`-H`) then soft (`-S`), failures silenced:
 * where the kernel permits it the hard limit locks the ceiling (the
 * sandboxed process cannot raise it); otherwise the soft limit still
 * contains accidents and runaway recursion — only a command that
 * deliberately re-raises its own soft limits escapes that layer, and
 * memory/process-count are independently locked by the systemd scope
 * around the sandbox. Dimensions: address space (`-v`), process count
 * (`-u`, bounds fork bombs and fan-out), single-file size (`-f`), and CPU
 * seconds (`-t`; wall-clock is bounded separately by the node timeout).
 */
function limitPrefix(limits: ResourceLimits, skipVirtualMemoryLimit = false): string {
  const dims: Array<[string, number]> = [
    ["v", Math.max(1024, Math.floor(limits.maxMemoryMb * 1024))],
    ["u", Math.max(1, Math.floor(limits.maxProcesses))],
    ["f", Math.max(2, Math.floor(limits.maxFileBytes / 512))],
    ["t", Math.max(1, Math.floor(limits.maxCpuSeconds))],
  ];
  const parts = dims
    .filter(([flag]) => !(skipVirtualMemoryLimit && flag === "v"))
    .flatMap(([flag, value]) => [`ulimit -H -${flag} ${value} 2>/dev/null`, `ulimit -S -${flag} ${value} 2>/dev/null`]);
  return `${parts.join("; ")}; `;
}

function bwrapArgv(
  workspaceRoot: string,
  opts: { allowNetwork: boolean; readOnlyWorkspace: boolean; profile: SandboxProfile; resourceLimits?: ResourceLimits; bindings?: Record<string, string>; extraRoBinds?: Array<{ source: string; target: string }>; extraRwBinds?: Array<{ source: string; target: string }>; skipVirtualMemoryLimit?: boolean },
  command: string,
): string[] {
  const readOnly = opts.readOnlyWorkspace || opts.profile === "inspect";
  const argv = [
    ...systemBinds(),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...(readOnly ? ["--ro-bind", workspaceRoot, "/work"] : ["--bind", workspaceRoot, "/work"]),
    ...(opts.extraRoBinds?.length ? ["--dir", "/plugins", ...opts.extraRoBinds.flatMap(({ source, target }) => ["--ro-bind", source, target])] : []),
    ...(opts.extraRwBinds?.length ? ["--dir", "/rpc", ...opts.extraRwBinds.flatMap(({ source, target }) => ["--bind", source, target])] : []),
    "--chdir",
    "/work",
    // Explicit namespaces, not --unshare-all: --unshare-all also unshares
    // the network namespace, which would silently keep an explicitly
    // allowed network isolated. The network namespace is unshared only when
    // the policy denies network access.
    "--unshare-user",
    "--unshare-ipc",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-cgroup",
  ];
  if (!opts.allowNetwork) argv.push("--unshare-net");
  const bindings = Object.entries(opts.bindings ?? {}).sort(([a], [b]) => a.localeCompare(b));
  argv.push(
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--setenv",
    "PATH",
    SAFE_ENV.PATH,
    "--setenv",
    "HOME",
    SAFE_ENV.HOME,
    "--setenv",
    "LANG",
    SAFE_ENV.LANG,
    "--setenv",
    "TMPDIR",
    "/tmp",
    ...bindings.flatMap(([name, value]) => ["--setenv", name, value]),
    "bash",
    "-c",
    limitPrefix(
      limitsFor({
        profile: opts.profile,
        ...(opts.resourceLimits === undefined ? {} : { resourceLimits: opts.resourceLimits }),
      }),
      opts.skipVirtualMemoryLimit,
    ) + command,
  );
  return argv;
}

/**
 * Resource-control scope around every node: a transient systemd user scope
 * with hard memory/process ceilings. This is the mechanism that bounds
 * what namespaces alone cannot — resident memory, fork bombs, and process
 * fan-out. `MemorySwapMax=0` keeps MemoryMax firm (no swap escape hatch).
 * If the scope backend is missing, the node does not run degraded: the
 * confinement probe fails and execution is refused outright.
 */
function scopeArgv(limits: ResourceLimits): string[] {
  return [
    "--user",
    "--scope",
    "--quiet",
    `--property=MemoryMax=${Math.max(16, Math.floor(limits.maxMemoryMb))}M`,
    `--property=TasksMax=${Math.max(8, Math.floor(limits.maxProcesses))}`,
    "--property=MemorySwapMax=0",
    "--",
  ];
}

function runBwrap(
  workspaceRoot: string,
  opts: {
    allowNetwork: boolean;
    readOnlyWorkspace: boolean;
    profile: SandboxProfile;
    resourceLimits?: ResourceLimits;
    bindings?: Record<string, string>;
    extraRoBinds?: Array<{ source: string; target: string }>;
    extraRwBinds?: Array<{ source: string; target: string }>;
    skipVirtualMemoryLimit?: boolean;
  },
  command: string,
  execOpts: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  const limits = limitsFor({
    profile: opts.profile,
    ...(opts.resourceLimits === undefined ? {} : { resourceLimits: opts.resourceLimits }),
  });
  return new Promise((resolve, reject) => {
    execFile(
      "systemd-run",
      [...scopeArgv(limits), "bwrap", ...bwrapArgv(workspaceRoot, opts, command)],
      { timeout: execOpts.timeoutMs, maxBuffer: execOpts.maxOutputBytes, signal: execOpts.signal },
      (error, stdout, stderr) => {
        if (error) {
          (error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stdout = stdout;
          (error as NodeJS.ErrnoException & { stderr?: string }).stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function nodePermissionFlag(): string {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13) ? "--permission" : "--experimental-permission";
}

function snapshotPluginRoot(sourceRoot: string, expectedHash: string): string {
  const snapshot = mkdtempSync(join(tmpdir(), "jeverb-extractor-plugin-"));
  const entries: Array<{ path: string; bytes: Buffer }> = [];
  let totalBytes = 0;
  const copyTree = (source: string, target: string, relativeDir: string): void => {
    const names = readdirSync(source).sort();
    for (const name of names) {
      const sourcePath = join(source, name);
      const targetPath = join(target, name);
      const relativePath = relativeDir === "" ? name : `${relativeDir}/${name}`;
      const stat = lstatSync(sourcePath);
      if (stat.isSymbolicLink()) throw new Error("plugin tree contains a symbolic link");
      if (stat.isDirectory()) {
        mkdirSync(targetPath, { mode: 0o700 });
        copyTree(sourcePath, targetPath, relativePath);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        if (entries.length >= 128 || totalBytes > 4 * 1024 * 1024) throw new Error("plugin tree exceeds its file or size limit");
        const bytes = readFileSync(sourcePath);
        writeFileSync(targetPath, bytes, { mode: 0o400, flag: "wx" });
        entries.push({ path: relativePath, bytes });
      }
    }
  };
  const freezeTree = (target: string): void => {
    for (const name of readdirSync(target)) {
      const path = join(target, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) freezeTree(path);
      chmodSync(path, stat.isDirectory() ? 0o500 : 0o400);
    }
  };
  try {
    copyTree(sourceRoot, snapshot, "");
    const hash = createHash("sha256");
    for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
      hash.update(entry.path, "utf8").update("\0").update(entry.bytes).update("\0");
    }
    if (hash.digest("hex") !== expectedHash) throw new Error("plugin tree changed after the graph was fingerprinted");
    freezeTree(snapshot);
    return snapshot;
  } catch (error) {
    rmSync(snapshot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Execute a project/global extractor module in a separate, read-only OS
 * sandbox. Node's permission model blocks fs writes, child processes, workers,
 * and network by default; bubblewrap supplies the actual filesystem and
 * network namespaces (Node documents its permission model as a seat belt,
 * not a boundary against malicious code). `fetch` is exposed only when the
 * operator already enabled graph networking. `exec` and artifact writes are
 * parent-RPC operations so each uses graph policy and durable storage.
 */
export async function runExtractorPluginConstrained(opts: ExtractorPluginRunOptions): Promise<string> {
  if (!(await isSandboxAvailable())) {
    throw new Error("refusing extractor plugin: the confinement backend is unavailable; plugin code never runs without isolation");
  }
  const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
  if (/\.ts$/.test(opts.modulePath) && !(nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6))) {
    throw new Error("TypeScript extractor plugins require Node.js 22.6 or newer; use .js/.mjs on older runtimes");
  }
  const payload = Buffer.from(JSON.stringify({ input: opts.input, config: opts.config }), "utf8").toString("base64url");
  if (Buffer.byteLength(payload, "utf8") > 96 * 1024) throw new Error("extractor plugin input exceeds 96 KiB");
  const modulePath = opts.modulePath;
  const relativeModule = relative(opts.pluginRoot, modulePath);
  if (relativeModule === "" || relativeModule === ".." || relativeModule.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || relativeModule.includes("\0") || relativeModule.startsWith("/")) {
    throw new Error("extractor plugin module is outside its approved plugin root");
  }
  const stagedPluginRoot = snapshotPluginRoot(opts.pluginRoot, opts.expectedHash);
  const pluginTarget = "/plugins/extractors";
  const insideModule = `${pluginTarget}${relativeModule.startsWith("/") ? relativeModule : `/${relativeModule}`}`;
  const script = [
    "const mod = await import(process.env.JEV_EXTRACTOR_MODULE);",
    "const plugin = mod.default ?? mod;",
    "if (!plugin || typeof plugin.run !== 'function') throw new Error('plugin must export a default object with run(input, config, ctx)');",
    "if (plugin.name !== process.env.JEV_EXTRACTOR_NAME) throw new Error('plugin name must match its module filename');",
    "if (typeof plugin.description !== 'string' || !plugin.inputSchema || !plugin.outputSchema) throw new Error('plugin must declare description, inputSchema, and outputSchema');",
    "const metadata = { name: plugin.name, description: plugin.description, inputSchema: plugin.inputSchema, outputSchema: plugin.outputSchema, ...(plugin.configSchema === undefined ? {} : { configSchema: plugin.configSchema }) };",
    "let envelope = { metadata };",
    "if (process.env.JEV_EXTRACTOR_PHASE === 'run') {",
    "  const { input, config } = JSON.parse(Buffer.from(process.env.JEV_EXTRACTOR_PAYLOAD, 'base64url').toString('utf8'));",
    "  const { createConnection } = await import('node:net');",
    "  const rpc = createConnection(process.env.JEV_EXTRACTOR_RPC);",
    "  await new Promise((resolve, reject) => { rpc.once('connect', resolve); rpc.once('error', reject); });",
    "  let rpcBuffer = ''; let rpcSeq = 0; const rpcPending = new Map();",
    "  rpc.on('data', (chunk) => { rpcBuffer += chunk.toString('utf8'); if (rpcBuffer.length > 65536) { rpc.destroy(new Error('RPC response buffer exceeded')); return; } let index; while ((index = rpcBuffer.indexOf('\\n')) >= 0) { const line = rpcBuffer.slice(0, index); rpcBuffer = rpcBuffer.slice(index + 1); if (!line) continue; let message; try { message = JSON.parse(line); } catch { rpc.destroy(new Error('invalid RPC response')); return; } const pending = rpcPending.get(message.id); if (pending) { rpcPending.delete(message.id); message.ok ? pending.resolve(message.output) : pending.reject(new Error(message.error || 'plugin helper denied')); } } });",
    "  function rpcRequest(type, fields) { return new Promise((resolve, reject) => { const id = String(++rpcSeq); rpcPending.set(id, { resolve, reject }); rpc.write(JSON.stringify({ type, id, ...fields }) + '\\n'); }); }",
    "  function rpcExec(command) { return rpcRequest('exec', { command }); }",
    "  async function rpcArtifact(data) { let content; try { content = JSON.stringify(data); } catch { throw new Error('artifact data is not JSON serializable'); } if (content === undefined) throw new Error('artifact data is not JSON serializable'); if (Buffer.byteLength(content, 'utf8') > 4 * 1024 * 1024) throw new Error('artifact data exceeds 4 MiB'); return rpcRequest('artifact', { content }); }",
    "  const ctx = { cwd: process.env.JEV_EXTRACTOR_CWD, signal: AbortSignal.timeout(Number(process.env.JEV_EXTRACTOR_TIMEOUT_MS)), log: (...args) => console.error(...args), fetch: process.env.JEV_EXTRACTOR_ALLOW_NETWORK === 'true' ? globalThis.fetch.bind(globalThis) : async () => { throw new Error('plugin network is disabled by graph policy'); }, exec: rpcExec, artifact: rpcArtifact };",
    "  const output = await plugin.run(input, config, ctx);",
    "  rpc.end();",
    "  envelope = { metadata, output };",
    "}",
    "const serialized = JSON.stringify(envelope);",
    "if (serialized === undefined) throw new Error('plugin output is not JSON serializable');",
    "process.stdout.write(serialized);",
  ].join("\n");
  const stripTypes = /\.ts$/.test(modulePath) ? " --experimental-strip-types" : "";
  const command = `node ${nodePermissionFlag()} --allow-fs-read=/plugins/extractors${stripTypes} --input-type=module -e ${shellQuote(script)}`;
  const runSignal = opts.signal;
  const emptyWorkspace = mkdtempSync(join(tmpdir(), "jeverb-extractor-work-"));
  const rpcDir = mkdtempSync(join(tmpdir(), "jeverb-extractor-rpc-"));
  const rpcSocket = join(rpcDir, "rpc.sock");
  let rpcCalls = 0;
  let rpcListening = false;
  const rpcServer = createServer((socket) => {
    const assertActive = (): void => {
      if (runSignal?.aborted) throw new Error("graph execution cancelled");
    };
    if (runSignal?.aborted) {
      socket.destroy();
      return;
    }
    const abortSocket = (): void => { socket.destroy(new Error("graph execution cancelled")); };
    runSignal?.addEventListener("abort", abortSocket, { once: true });
    socket.once("close", () => runSignal?.removeEventListener("abort", abortSocket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 5 * 1024 * 1024) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void (async () => {
          let id = "";
          try {
            const request = JSON.parse(line) as Record<string, unknown>;
            id = typeof request.id === "string" && /^[0-9]{1,8}$/.test(request.id) ? request.id : "";
            if (id === "" || (request.type !== "exec" && request.type !== "artifact")) throw new Error("invalid plugin helper request");
            assertActive();
            rpcCalls += 1;
            if (rpcCalls > 8) throw new Error("plugin helper call limit exceeded");
            let output: string;
            if (request.type === "exec") {
              if (typeof request.command !== "string" || request.command.length === 0 || request.command.length > 8192) throw new Error("invalid plugin exec request");
              if (opts.onExec === undefined) throw new Error("plugin exec is unavailable under the current policy");
              output = await opts.onExec(request.command);
            } else {
              if (typeof request.content !== "string" || Buffer.byteLength(request.content, "utf8") > 4 * 1024 * 1024) throw new Error("invalid plugin artifact request");
              try { JSON.parse(request.content) as unknown; } catch { throw new Error("invalid plugin artifact JSON"); }
              if (opts.onArtifact === undefined) throw new Error("plugin artifacts are unavailable under the current policy");
              output = await opts.onArtifact(request.content);
            }
            assertActive();
            socket.write(`${JSON.stringify({ id, ok: true, output: output.slice(0, 16 * 1024) })}\n`);
          } catch (error) {
            const message = error instanceof Error ? error.message : "plugin exec denied";
            socket.write(`${JSON.stringify({ id, ok: false, error: message.slice(0, 500) })}\n`);
          }
        })();
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      rpcServer.once("error", reject);
      rpcServer.listen(rpcSocket, () => { rpcListening = true; resolve(); });
    });
    const result = await runBwrap(
      // Extractor code receives only its own read-only module tree and an
      // empty cwd. The actual project tree (which may contain credentials)
      // is not mounted into the plugin process.
      emptyWorkspace,
      {
        allowNetwork: opts.allowNetwork,
        readOnlyWorkspace: true,
        profile: "inspect",
        skipVirtualMemoryLimit: true,
        extraRoBinds: [{ source: stagedPluginRoot, target: pluginTarget }],
        extraRwBinds: [{ source: rpcDir, target: "/rpc" }],
        bindings: {
          JEV_EXTRACTOR_MODULE: insideModule,
          JEV_EXTRACTOR_NAME: opts.pluginName,
          JEV_EXTRACTOR_PHASE: opts.phase,
          JEV_EXTRACTOR_RPC: "/rpc/rpc.sock",
          JEV_EXTRACTOR_ALLOW_NETWORK: String(opts.allowNetwork),
          JEV_EXTRACTOR_CWD: opts.workspaceRoot,
          JEV_EXTRACTOR_PAYLOAD: payload,
          JEV_EXTRACTOR_TIMEOUT_MS: String(Math.max(1, Math.floor(opts.timeoutMs))),
        },
      },
      command,
      { timeoutMs: opts.timeoutMs, maxOutputBytes: 96 * 1024, ...(runSignal === undefined ? {} : { signal: runSignal }) },
    );
    if (Buffer.byteLength(result.stdout, "utf8") > 64 * 1024) throw new Error("extractor plugin output exceeds 64 KiB");
    return result.stdout;
  } catch (error) {
    if (runSignal?.aborted) throw new Error("cancelled: extractor plugin aborted");
    const failure = error as NodeJS.ErrnoException & { stderr?: unknown };
    // execFile embeds the complete argv in `message`, which includes the
    // bounded base64 input payload. Plugin stderr is also untrusted and may
    // contain source data or credentials. Surface only the process code.
    const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
    const deniedPermission = /permission:\s*'([^']+)'/i.exec(stderr)?.[1];
    const detail = `${typeof failure.code === "number" ? `sandbox process failed (exit ${failure.code})` : "sandbox process failed"}${deniedPermission === undefined ? "" : `; Node denied ${deniedPermission}`}`;
    throw new Error(`extractor plugin failed in constrained runner: ${detail.slice(0, 500)}`);
  } finally {
    if (rpcListening) await new Promise<void>((resolve) => rpcServer.close(() => resolve()));
    rmSync(rpcDir, { recursive: true, force: true });
    rmSync(emptyWorkspace, { recursive: true, force: true });
    rmSync(stagedPluginRoot, { recursive: true, force: true });
  }
}

/**
 * Prove the backend confines before any node relies on it: a canary file
 * outside the probe workspace must stay unreadable inside the sandbox while
 * a file written to `/work` round-trips to the host. Uses the production
 * argv builder, so the probe exercises the real configuration — including
 * the network-denying namespaces.
 */
async function probeConfinement(): Promise<boolean> {
  const base = mkdtempSync(join(tmpdir(), "jeverb-probe-"));
  try {
    const canary = join(base, "canary-secret");
    writeFileSync(canary, `probe-secret\n`, { mode: 0o600 });
    const work = join(base, "work");
    mkdirSync(work, { recursive: true });
    const quoted = `'${canary.replace(/'/g, `'"'"'`)}'`;
    const out = await runBwrap(
      work,
      { allowNetwork: false, readOnlyWorkspace: false, profile: "implement" },
      `test ! -e ${quoted} && echo probe-ok > /work/ok && cat /work/ok`,
      {
        timeoutMs: 15_000,
        maxOutputBytes: 10_000,
      },
    );
    if (out.stdout.trim() !== "probe-ok") return false;
    if (readFileSync(join(work, "ok"), "utf8") !== "probe-ok\n") return false;
    // Resource-control proof: a 200MB allocation under a 50MB memory
    // ceiling must die, not complete. A rejection that names a missing
    // backend (no systemd user bus, no bwrap) means limits are
    // unavailable — fail closed. Any other failure mode (OOM kill, signal
    // death, 128+ exit) proves the ceiling killed it.
    const tight = {
      allowNetwork: false,
      readOnlyWorkspace: false,
      profile: "implement" as const,
      resourceLimits: { maxMemoryMb: 50, maxProcesses: 64, maxFileBytes: 10 * 1024 * 1024, maxCpuSeconds: 30 },
    };
    try {
      const survived = await runBwrap(work, tight, `x=$(printf '%0200000000d' 0); echo survived:\${#x}`, {
        timeoutMs: 20_000,
        maxOutputBytes: 10_000,
      });
      if (survived.stdout.includes("survived:")) return false;
      return true;
    } catch (error) {
      // Classify by cause, not by command name: execFile prefixes every
      // message with the argv ("Command failed: systemd-run ..."), so
      // matching "systemd-run" would mistake every kill for a missing
      // backend. Only binary absence (ENOENT) and bus failures mean the
      // limits backend is unavailable — fail closed. A kill (signal, OOM,
      // 128+ exit) proves the ceiling fired.
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") return false;
      const msg = String(errno.message ?? error);
      if (/Failed to connect to bus|System has not been booted|Failed to create bus|DBUS_SESSION/.test(msg)) {
        return false;
      }
      return true;
    }
  } catch {
    return false;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

export async function runShellConstrained(command: string, opts: ShellRunOptions): Promise<ShellRunResult> {
  const maxOutputBytes = opts.maxOutputBytes ?? 200_000;
  const bindings = Object.entries(opts.bindings ?? {});
  if (bindings.length > 32) throw new Error("refusing shell execution: more than 32 output bindings");
  let bindingBytes = 0;
  for (const [name, value] of bindings) {
    if (!/^JIVE_REF_[A-Z][A-Z0-9_]{0,60}$/.test(name) || value.includes("\0") || value.length > 64 * 1024) {
      throw new Error(`refusing shell execution: invalid or oversized output binding ${JSON.stringify(name)}`);
    }
    bindingBytes += Buffer.byteLength(value, "utf8");
  }
  if (bindingBytes > 256 * 1024) throw new Error("refusing shell execution: total output bindings exceed 256 KiB");
  // The node never outlives the graph: clamp to the remaining budget.
  const effectiveTimeoutMs =
    opts.deadlineMs === undefined ? opts.timeoutMs : Math.max(1, Math.min(opts.timeoutMs, opts.deadlineMs));
  if (!(await isSandboxAvailable())) {
    throw new Error(
      "refusing shell execution: the confinement backend is unavailable (bwrap missing or its confinement probe failed); untrusted graph commands never run without isolation.",
    );
  }
  try {
    const { stdout } = await runBwrap(
      opts.workspaceRoot,
      {
        allowNetwork: opts.allowNetwork,
        readOnlyWorkspace: opts.readOnlyWorkspace ?? false,
        profile: opts.profile ?? "implement",
        ...(opts.resourceLimits === undefined ? {} : { resourceLimits: opts.resourceLimits }),
        ...(opts.bindings === undefined ? {} : { bindings: opts.bindings }),
      },
      command,
      {
        timeoutMs: effectiveTimeoutMs,
        maxOutputBytes,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      },
    );
    // The cap is enforced by execFile's maxBuffer, so a success return is
    // almost always under it; slice defensively anyway so the returned
    // output, the journal digest, and the cap can never disagree.
    const truncated = stdout.length > maxOutputBytes;
    return {
      output: stdout.slice(0, maxOutputBytes),
      sandboxed: true,
      truncated,
      ...(truncated ? { truncationReason: `stdout-exceeded-maxOutputBytes-${maxOutputBytes}` } : {}),
    };
  } catch (error) {
    // Aborted by the graph/host: cancellation, handled upstream.
    if (opts.signal?.aborted) {
      throw new Error("cancelled: shell node aborted");
    }
    const errno = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stderr?: unknown };
    // Output flood: execFile killed the child when stdout+stderr passed
    // maxBuffer. The captured prefix is bounded, but the process died
    // mid-stream, so side effects are uncertain — outcome_unknown, with
    // the truncation recorded so no caller mistakes the prefix for the
    // complete output.
    if (errno.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer length exceeded/.test(String(errno.message ?? ""))) {
      throw new Error(
        `outcome_unknown: shell node output exceeded maxOutputBytes=${maxOutputBytes} and was truncated; ` +
          `side effects uncertain, reconciliation required. ${String(errno.stderr ?? errno.message).slice(0, 500)}`,
      );
    }
    // Killed by the timeout, or dead by signal (OOM kill, seccomp, crash):
    // the process may or may not have completed its side effects. Report
    // that uncertainty explicitly so callers must reconcile instead of
    // silently retrying or succeeding.
    // Note: execFile reports `signal: null` (not undefined) when the process
    // exits with a code, so only a string signal means death by signal.
    // bwrap additionally masks a signal-killed child as exit code 128+signo,
    // indistinguishable from a command that exits 137 on purpose. By shell
    // convention 128+ means signal death, so treat it as uncertain: a
    // command that deliberately exits 128+ is reported as outcome_unknown
    // rather than failed — a conservative over-approximation, documented
    // here so no caller mistakes it for a precise signal report.
    const exitCode = typeof errno.code === "number" ? errno.code : undefined;
    if (errno.killed === true || typeof errno.signal === "string" || (exitCode !== undefined && exitCode >= 128)) {
      const via =
        errno.killed === true
          ? `timed out after ${effectiveTimeoutMs}ms`
          : typeof errno.signal === "string"
            ? `terminated by ${errno.signal}`
            : `exited with code ${exitCode} (probable signal death; bwrap masks the signal)`;
      throw new Error(
        `outcome_unknown: shell node ${via}; side effects uncertain, reconciliation required. ${String(
          errno.stderr ?? errno.message,
        ).slice(0, 500)}`,
      );
    }
    // Only bwrap's own diagnostics (always "bwrap:"-prefixed) count as a
    // confinement failure: a command that merely prints "No such file or
    // directory" is an ordinary failure, and both fail the node either way.
    if (/^bwrap:/m.test(String(errno.stderr ?? errno.message))) {
      throw new Error(
        `refusing shell execution: the sandbox failed to establish confinement (${String(
          errno.stderr ?? errno.message,
        ).slice(0, 300)}); the command did not run.`,
      );
    }
    throw new Error(`shell node failed: ${String(errno.stderr ?? errno.message).slice(0, 1000)}`);
  }
}
