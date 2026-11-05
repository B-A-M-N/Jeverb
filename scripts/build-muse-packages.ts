/**
 * Build the two Muse plugin roots in the owned `dist/muse-plugins` output.
 * This module owns sibling staging, publish rollback, and stale-transaction
 * recovery; only a demonstrably dead builder's artifacts may be reaped.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const JEVERB_FILES = [
  ".muse-plugin/plugin.json",
  "plugin",
  "skills",
  "config/review",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
] as const;
const JEV_FILES = [
  ["jev-control-plugin/.muse-plugin/plugin.json", ".muse-plugin/plugin.json"],
  ["jev-control-plugin/commands", "commands"],
] as const;

function copyRequired(source: string, destination: string): void {
  if (!existsSync(source)) throw new Error(`missing Muse package input: ${source}`);
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`refusing symlink in Muse package: ${source}`);
  if (stat.isDirectory()) {
    for (const child of readdirSync(source)) copyRequired(join(source, child), join(destination, child));
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { errorOnExist: true, force: false });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function removeBuildArtifact(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`refusing to remove unexpected Muse package build artifact: ${path}`);
  }
  rmSync(path, { recursive: true, force: false });
}

/** Restore or reap only artifacts whose recorded builder process is gone. */
function recoverInterruptedBuild(outDir: string, outParent: string): void {
  const outputName = basename(outDir);
  const stagePrefix = `.${outputName}.stage-`;
  const previousSuffix = ".previous";
  const names = readdirSync(outParent).filter((name) => name.startsWith(stagePrefix));
  if (names.length === 0) return;

  const stages = new Set<string>();
  const backups = new Set<string>();
  const owners = new Set<number>();
  for (const name of names) {
    const isBackup = name.endsWith(previousSuffix);
    const stageName = isBackup ? name.slice(0, -previousSuffix.length) : name;
    const ownerAndSuffix = stageName.slice(stagePrefix.length);
    const ownerText = ownerAndSuffix.slice(0, ownerAndSuffix.indexOf("-"));
    const owner = Number(ownerText);
    if (!Number.isSafeInteger(owner) || owner <= 0 || !ownerAndSuffix.includes("-")) {
      throw new Error(`refusing to recover malformed Muse package build artifact: ${join(outParent, name)}`);
    }
    const path = join(outParent, name);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`refusing to recover unexpected Muse package build artifact: ${path}`);
    }
    owners.add(owner);
    (isBackup ? backups : stages).add(path);
  }

  const liveOwners = [...owners].filter(processIsAlive);
  if (liveOwners.length > 0) {
    throw new Error(`another Muse package build is active (pid ${liveOwners.join(", ")})`);
  }

  if (!existsSync(outDir)) {
    if (backups.size > 1) {
      throw new Error(`multiple interrupted Muse package backups need manual recovery: ${outParent}`);
    }
    const [backup] = backups;
    if (backup !== undefined) renameSync(backup, outDir);
  }

  for (const stage of stages) if (existsSync(stage)) removeBuildArtifact(stage);
  for (const backup of backups) if (existsSync(backup)) removeBuildArtifact(backup);
}

export function buildMusePackages(outDir = join(sourceRoot, "dist", "muse-plugins"), root = sourceRoot): void {
  const resolvedRoot = realpathSync(root);
  const resolvedOut = resolve(outDir);
  const outParent = realpathSync(dirname(resolvedOut));
  const actualOut = join(outParent, basename(resolvedOut));
  const canonicalOut = resolve(resolvedRoot, "dist", "muse-plugins");
  const fromRoot = relative(resolvedRoot, actualOut);
  const insideRoot = fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
  const isOwnedOutput = actualOut === canonicalOut;
  const requestedDefault = resolvedOut === resolve(resolvedRoot, "dist", "muse-plugins");

  if (requestedDefault && !isOwnedOutput) {
    throw new Error("refusing Muse package output through a symlinked dist directory");
  }

  // Only the dedicated generated output may be replaced when populated.
  // Custom paths exist for isolated tests; they must be empty and outside
  // the source tree so a mistaken path can never erase project data.
  if (insideRoot && !isOwnedOutput) {
    throw new Error(`refusing to write Muse packages inside the source tree: ${outDir}`);
  }
  if (isOwnedOutput) recoverInterruptedBuild(actualOut, outParent);
  const hadOutput = existsSync(resolvedOut);
  if (hadOutput) {
    const existing = lstatSync(resolvedOut);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`refusing to replace non-directory or symlink output: ${outDir}`);
    }
    if (!isOwnedOutput && readdirSync(resolvedOut).length > 0) {
      throw new Error(`refusing to replace non-empty custom output directory: ${outDir}`);
    }
  }

  const stagingDir = mkdtempSync(join(outParent, `.${basename(resolvedOut)}.stage-${process.pid}-`));
  const backupDir = `${stagingDir}.previous`;
  try {
    const jeverbDir = join(stagingDir, "jeverb");
    const jevDir = join(stagingDir, "jev");
    mkdirSync(jeverbDir, { recursive: true });
    mkdirSync(jevDir, { recursive: true });
    for (const rel of JEVERB_FILES) copyRequired(join(root, rel), join(jeverbDir, rel));
    for (const [from, to] of JEV_FILES) copyRequired(join(root, from), join(jevDir, to));

    if (hadOutput) renameSync(resolvedOut, backupDir);
    try {
      renameSync(stagingDir, resolvedOut);
    } catch (error) {
      if (hadOutput) renameSync(backupDir, resolvedOut);
      throw error;
    }
    if (hadOutput) rmSync(backupDir, { recursive: true, force: false });
  } catch (error) {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`) {
  try {
    const out = join(sourceRoot, "dist", "muse-plugins");
    if (process.argv[2] !== undefined && resolve(process.argv[2]) !== resolve(out)) {
      throw new Error("custom CLI output paths are unsupported; use the owned dist/muse-plugins directory");
    }
    buildMusePackages(out);
    process.stdout.write(`Muse packages: ${join(out, "jeverb")} and ${join(out, "jev")}\n`);
  } catch (error) {
    process.stderr.write(`build-muse-packages: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
