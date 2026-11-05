/**
 * Packaged plugin integrity: the files a local-directory install carries
 * must be present and self-consistent. Fails with specifics, not a bare
 * nonzero exit, so CI output names the missing piece.
 *
 * Two modes:
 * - default: validate the source checkout (fast pre-publish gate).
 * - --candidate DIR: validate a frozen install candidate before it is
 *   installed. Fails when either review file is missing, invalid, or
 *   byte-different from the source checkout ("inconsistently sourced").
 *   Prints one line per diagnostic dimension so packaging validity,
 *   backend/model identity, provider availability, calibration, and
 *   protected-operation authorization stay separate claims.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadReviewConfig } from "../src/review/load-config.js";

const root = new URL("../", import.meta.url).pathname;
const failures: string[] = [];
const notes: string[] = [];

function needFile(base: string, rel: string): void {
  const issue = packageFileIssue(base, rel);
  if (issue !== undefined) failures.push(`${issue}: ${rel}`);
}

function needJson(base: string, rel: string): Record<string, unknown> | undefined {
  const path = join(base, rel);
  const issue = packageFileIssue(base, rel);
  if (issue !== undefined) {
    failures.push(`${issue}: ${rel}`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    failures.push(`invalid JSON: ${rel}`);
    return undefined;
  }
}

/** Require a relative, contained path whose every component is symlink-free. */
function packageFileIssue(base: string, file: string): string | undefined {
  if (isAbsolute(file)) return "uses an absolute path";
  const root = resolve(base);
  const target = resolve(root, file);
  const relativeTarget = relative(root, target);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
    return "escapes package root";
  }
  let current = root;
  const parts = relativeTarget === "" ? [] : relativeTarget.split(sep);
  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return "package root is not a real directory";
  } catch {
    return "package root is missing";
  }
  if (parts.length === 0) return "is not a regular file";
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return "missing file";
    }
    if (stat.isSymbolicLink()) return "contains a symlink";
    if (index < parts.length - 1 && !stat.isDirectory()) return "contains a non-directory component";
    if (index === parts.length - 1 && !stat.isFile()) return "is not a regular file";
  }
  return undefined;
}

function checkManifest(base: string): void {
  const manifest = needJson(base, ".muse-plugin/plugin.json");
  if (manifest === undefined) return;
  const caps = (manifest.capabilities ?? {}) as Record<string, unknown>;
  const hooks = Array.isArray(caps.hooks) ? (caps.hooks as Array<Record<string, unknown>>) : [];
  if (hooks.length === 0) failures.push("manifest declares no hooks");
  for (const hook of hooks) {
    const command = hook.command;
    if (!Array.isArray(command) || command.length < 2 || command[0] !== "node") {
      failures.push(`hook ${String(hook.id ?? "?")} has no node argv command`);
      continue;
    }
    const bundle = String(command[1]);
    const issue = packageFileIssue(base, bundle);
    if (issue !== undefined) failures.push(`hook ${String(hook.id ?? "?")} ${issue}: ${bundle}`);
  }
  const servers = Array.isArray(caps.mcpServers) ? (caps.mcpServers as Array<Record<string, unknown>>) : [];
  if (servers.length === 0) failures.push("manifest declares no MCP servers");
  for (const server of servers) {
    const command = server.command;
    if (!Array.isArray(command) || command.length < 2 || command[0] !== "node") {
      failures.push(`mcp server ${String(server.id ?? "?")} has no node argv command`);
      continue;
    }
    const bundle = String(command[1]);
    const issue = packageFileIssue(base, bundle);
    if (issue !== undefined) failures.push(`mcp server ${String(server.id ?? "?")} ${issue}: ${bundle}`);
  }
  for (const [manifestPath, pluginId, dir] of [[".muse-plugin/plugin.json", "jeverb", "plugin/commands"], ["jev-control-plugin/.muse-plugin/plugin.json", "jev", "jev-control-plugin/commands"]] as const) {
    const commandManifest = needJson(base, manifestPath);
    if (commandManifest === undefined) continue;
    if (commandManifest.name !== pluginId) failures.push(`${manifestPath} has incorrect plugin id`);
    const commandCaps = (commandManifest.capabilities ?? {}) as Record<string, unknown>;
    const commands = Array.isArray(commandCaps.commands) ? commandCaps.commands as Array<Record<string, unknown>> : [];
    if (pluginId === "jeverb") {
      if (commands.length !== 0) failures.push(`${manifestPath} must not expose model-mediated switch commands`);
      continue;
    }
    for (const id of ["off", "on"]) {
      const path = pluginId === "jev" ? `commands/${id}.md` : `plugin/commands/${id}.md`;
      if (commands.find((item) => item.id === id)?.path !== path) failures.push(`${manifestPath} must declare ${id} at ${path}`);
      needFile(base, `${dir}/${id}.md`);
    }
  }
}

function checkSource(): void {
  needFile(root, "jev-control-plugin/.muse-plugin/plugin.json");
  needFile(root, "plugin/dist/hook.mjs");
  needFile(root, "plugin/dist/mcp.mjs");
  needFile(root, "config/review/checks.json");
  needFile(root, "config/review/policy.json");
  needFile(root, "THIRD_PARTY_NOTICES.md");
  needFile(root, "LICENSE");
  checkManifest(root);
}

/**
 * Validate a frozen candidate WITHOUT installing it. `sourceRoot` is the
 * checkout the candidate must match byte-for-byte on the review contract.
 */
export function checkCandidate(candidateDir: string, sourceRoot: string = root): string[] {
  const problems: string[] = [];
  const candidateRoot = resolve(candidateDir);
  const at = (rel: string) => join(candidateRoot, rel);

  // 1. Packaging validity: the install set is complete and self-consistent.
  for (const rel of [
    "plugin/dist/hook.mjs",
    "plugin/dist/mcp.mjs",
    ".muse-plugin/plugin.json",
    "jev-control-plugin/.muse-plugin/plugin.json",
    "config/review/checks.json",
    "config/review/policy.json",
  ]) {
    const issue = packageFileIssue(candidateRoot, rel);
    if (issue !== undefined) problems.push(`candidate ${issue}: ${rel}`);
  }
  try {
    const manifest = JSON.parse(readFileSync(at(".muse-plugin/plugin.json"), "utf8")) as Record<string, unknown>;
    const caps = (manifest.capabilities ?? {}) as Record<string, unknown>;
    for (const hook of (Array.isArray(caps.hooks) ? caps.hooks : []) as Array<Record<string, unknown>>) {
      const command = hook.command;
      if (!Array.isArray(command) || command.length < 2 || command[0] !== "node") {
        problems.push(`candidate hook ${String(hook.id ?? "?")} has no node argv command`);
        continue;
      }
      const issue = packageFileIssue(candidateRoot, String(command[1]));
      if (issue !== undefined) problems.push(`candidate hook ${String(hook.id ?? "?")} ${issue}: ${String(command[1])}`);
    }
    const servers = Array.isArray(caps.mcpServers) ? (caps.mcpServers as Array<Record<string, unknown>>) : [];
    for (const server of servers) {
      const command = server.command;
      if (!Array.isArray(command) || command.length < 2 || command[0] !== "node") {
        problems.push(`candidate mcp server ${String(server.id ?? "?")} has no node argv command`);
        continue;
      }
      const issue = packageFileIssue(candidateRoot, String(command[1]));
      if (issue !== undefined) problems.push(`candidate mcp server ${String(server.id ?? "?")} ${issue}: ${String(command[1])}`);
    }
  } catch {
    problems.push("candidate manifest unreadable");
  }
  for (const [manifestPath, pluginId, prefix] of [[".muse-plugin/plugin.json", "jeverb", "plugin/commands"], ["jev-control-plugin/.muse-plugin/plugin.json", "jev", "jev-control-plugin/commands"]] as const) {
    try {
      const plugin = JSON.parse(readFileSync(at(manifestPath), "utf8")) as { name?: string; capabilities?: { commands?: Array<{ id?: string; path?: string }> } };
      if (plugin.name !== pluginId) problems.push(`candidate ${manifestPath} has wrong plugin id`);
      if (pluginId === "jeverb") {
        if ((plugin.capabilities?.commands?.length ?? 0) !== 0) problems.push(`candidate ${manifestPath} exposes model-mediated switch commands`);
        continue;
      }
      for (const id of ["off", "on"]) {
        const expectedPath = pluginId === "jev" ? `commands/${id}.md` : `plugin/commands/${id}.md`;
        if (plugin.capabilities?.commands?.find((command) => command.id === id)?.path !== expectedPath || !existsSync(at(`${prefix}/${id}.md`))) {
          problems.push(`candidate ${manifestPath} missing exact ${id} command declaration/file`);
        }
      }
    } catch { problems.push(`candidate ${manifestPath} unreadable`); }
  }

  // 2-4. Review contract: present, valid, and consistently sourced.
  // loadReviewConfig with an explicit root proves the candidate resolves
  // its own files (no CWD substitution) instead of inheriting the checkout.
  const loaded = loadReviewConfig([candidateRoot]);
  if (loaded.status === "absent") problems.push("candidate review config absent");
  else if (loaded.status === "partial") problems.push(`candidate review config partial: ${loaded.invalid}`);
  else if (loaded.status === "invalid") problems.push(`candidate review config invalid: ${loaded.invalid}`);
  if (loaded.source !== undefined) {
    const sourceRelative = relative(candidateRoot, loaded.source);
    if (sourceRelative === ".." || sourceRelative.startsWith(`..${sep}`) || isAbsolute(sourceRelative)) {
      problems.push(`candidate review resolved outside the package: ${loaded.source}`);
    }
  }
  for (const name of ["checks.json", "policy.json"] as const) {
    const candidatePath = at(`config/review/${name}`);
    const sourcePath = join(sourceRoot, "config", "review", name);
    if (existsSync(candidatePath) && existsSync(sourcePath)) {
      const candidateBytes = readFileSync(candidatePath, "utf8");
      const sourceBytes = readFileSync(sourcePath, "utf8");
      if (candidateBytes !== sourceBytes) {
        problems.push(`candidate config/review/${name} differs from the source checkout (inconsistently sourced)`);
      }
    }
  }
  return problems;
}

function diagnoseCandidate(candidateDir: string): void {
  const loaded = loadReviewConfig([candidateDir]);
  const line = (dimension: string, verdict: string) => notes.push(`${dimension}: ${verdict}`);
  line("packaging", failures.length === 0 ? "complete (bundles, manifest, review files present)" : "INCOMPLETE (see failures)");
  const calibration = loaded.calibration;
  line(
    "backend/model identity",
    calibration.backend !== undefined || calibration.model !== undefined
      ? `${calibration.backend ?? "?"} / ${calibration.model ?? calibration.modelVersion ?? "?"} (from candidate policy provenance)`
      : "unknown (no usable review provenance in candidate)",
  );
  line("provider availability", "not probed: this check sends no inference and reads no credentials");
  line(
    "calibration",
    loaded.status === "ready"
      ? `ready (calibrated for this backend/model, questionHash ${loaded.questionHash.slice(0, 12)}…)`
      : `${loaded.status}${loaded.invalid === undefined ? "" : ` — ${loaded.invalid}`}`,
  );
  line(
    "protected-operation authorization",
    loaded.status === "ready"
      ? "review may judge (fail-closed states still apply per call)"
      : "review disabled by config state: protected operations must fail closed until the config is ready",
  );
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--candidate");
  if (flag !== -1) {
    const candidateDir = process.argv[flag + 1];
    if (candidateDir === undefined || candidateDir.startsWith("--")) {
      console.error("usage: tsx scripts/plugin-integrity-check.ts [--candidate DIR]");
      process.exit(2);
    }
    for (const problem of checkCandidate(candidateDir)) failures.push(problem);
    diagnoseCandidate(candidateDir);
    for (const note of notes) console.log(`integrity: ${note}`);
    if (failures.length > 0) {
      for (const failure of failures) console.error(`integrity: ${failure}`);
      process.exit(1);
    }
    console.log("candidate integrity ok");
    return;
  }
  checkSource();
  if (failures.length > 0) {
    for (const failure of failures) console.error(`integrity: ${failure}`);
    process.exit(1);
  }
  console.log("plugin integrity ok");
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) await main();
