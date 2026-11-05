/**
 * Assemble a deterministic, symlink-free Muse install candidate.
 *
 * The install candidate is a filtered copy of this checkout: only the files
 * Muse needs at runtime. A previous registration (digest 09ee47c0) shipped
 * without config/review/, silently disabling review calibration, because
 * nothing enforced the file set. This assembler is that enforcement: every
 * candidate carries the exact review bytes, walks only regular files, and
 * emits a content manifest whose digest identifies the candidate.
 *
 * Usage: tsx scripts/assemble-candidate.ts --out DIR
 *
 * Never touches credentials, never sends inference, never installs anything.
 */
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE_STAGE = /^\.jeverb-candidate\.(\d+)\.(\d+)\.([0-9a-f-]{36})\.tmp$/;
const STALE_CANDIDATE_STAGE_MS = 60 * 60 * 1000;

/** Exact relative paths (or directory prefixes ending in /) shipped in order. */
const INCLUDE = [
  ".muse-plugin/plugin.json",
  "jev-control-plugin/",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "config/review/checks.json",
  "config/review/policy.json",
  "plugin/",
  "skills/",
] as const;

export interface CandidateManifest {
  version: 1;
  entries: Array<{ path: string; sha256: string; bytes: number }>;
}

function listFiles(dir: string, base: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = base === "" ? name : `${base}/${name}`;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to package symlink: ${rel}`);
    }
    if (stat.isDirectory()) {
      listFiles(full, rel, out);
    } else if (stat.isFile()) {
      out.push(rel);
    } else {
      throw new Error(`refusing to package non-regular file: ${rel}`);
    }
  }
}

function sha256File(path: string): { sha256: string; bytes: number } {
  const data = readFileSync(path);
  return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length };
}

/** Remove only old private staging dirs whose recorded process is gone. */
function reapCandidateStages(parent: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  if (names.length > 4096) return;
  for (const name of names) {
    const match = CANDIDATE_STAGE.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    const createdAt = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(createdAt)) continue;
    const path = join(parent, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
        now - stat.mtimeMs <= STALE_CANDIDATE_STAGE_MS) continue;
    try {
      process.kill(pid, 0);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
    }
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Preserve any path that could not be safely removed.
    }
  }
}

/**
 * Copy the exact runtime file set into outDir and return the manifest.
 * Throws (never partial-packages silently): any missing required file,
 * any review byte mismatch, or any non-regular file aborts the assembly.
 */
export function assembleCandidate(outDir: string, sourceRoot: string = root): CandidateManifest {
  const resolvedOut = resolve(outDir);
  const outputParent = realpathSync(dirname(resolvedOut));
  const actualOut = join(outputParent, basename(resolvedOut));
  const resolvedSource = realpathSync(sourceRoot);
  const fromSource = relative(resolvedSource, actualOut);
  const insideSource = fromSource === "" || (!isAbsolute(fromSource) && fromSource !== ".." && !fromSource.startsWith(`..${sep}`));
  if (insideSource) throw new Error(`refusing to assemble a candidate inside the source tree: ${outDir}`);

  let outputWasEmpty = false;
  if (existsSync(resolvedOut)) {
    const existing = lstatSync(resolvedOut);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`refusing to replace non-directory or symlink candidate output: ${outDir}`);
    }
    if (readdirSync(resolvedOut).length > 0) {
      throw new Error(`refusing to replace non-empty candidate output directory: ${outDir}`);
    }
    outputWasEmpty = true;
  }

  const relPaths: string[] = [];
  for (const item of INCLUDE) {
    const full = join(sourceRoot, item);
    if (!existsSync(full)) throw new Error(`missing required package path: ${item}`);
    if (item.endsWith("/")) {
      listFiles(full, item.slice(0, -1), relPaths);
    } else {
      if (!lstatSync(full).isFile() || lstatSync(full).isSymbolicLink()) {
        throw new Error(`required package path is not a regular file: ${item}`);
      }
      relPaths.push(item);
    }
  }
  relPaths.sort();
  for (const [manifestPath, pluginId] of [[".muse-plugin/plugin.json", "jeverb"], ["jev-control-plugin/.muse-plugin/plugin.json", "jev"]] as const) {
    const manifest = JSON.parse(readFileSync(join(sourceRoot, manifestPath), "utf8")) as { name?: string; capabilities?: { commands?: Array<{ id?: string; path?: string }> } };
    if (manifest.name !== pluginId) throw new Error(`${manifestPath} must have plugin id ${pluginId}`);
    if (pluginId === "jeverb" && (manifest.capabilities?.commands?.length ?? 0) !== 0) {
      throw new Error(`${manifestPath} must not declare model-mediated switch commands`);
    }
    if (pluginId === "jeverb") continue;
    for (const id of ["off", "on"]) {
      const command = manifest.capabilities?.commands?.find((item) => item.id === id);
      const expectedPath = pluginId === "jev" ? `commands/${id}.md` : `plugin/commands/${id}.md`;
      if (command?.path !== expectedPath) throw new Error(`${manifestPath} must declare ${id} at ${expectedPath}`);
      if (!relPaths.includes(pluginId === "jev" ? `jev-control-plugin/${expectedPath}` : expectedPath)) {
        throw new Error(`candidate is missing command file: ${expectedPath}`);
      }
    }
  }
  reapCandidateStages(outputParent);
  const stagingDir = join(outputParent, `.jeverb-candidate.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  mkdirSync(stagingDir, { mode: 0o700 });
  const entries: CandidateManifest["entries"] = [];
  try {
    for (const rel of relPaths) {
      const from = join(sourceRoot, rel);
      const to = join(stagingDir, rel);
      mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
      cpSync(from, to);
      const { sha256, bytes } = sha256File(to);
      // The review contract ships byte-exact: the copy must hash identically
      // to the source checkout, or the candidate is inconsistently sourced.
      const srcHash = sha256File(from).sha256;
      if ((rel === "config/review/checks.json" || rel === "config/review/policy.json") && sha256 !== srcHash) {
        throw new Error(`review file copy mismatch (impossible without tampering): ${rel}`);
      }
      entries.push({ path: rel, sha256, bytes });
    }
    const manifest: CandidateManifest = { version: 1, entries };
    writeFileSync(join(stagingDir, "CANDIDATE-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (outputWasEmpty) rmdirSync(resolvedOut);
    renameSync(stagingDir, resolvedOut);
    return manifest;
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    if (outputWasEmpty && !existsSync(resolvedOut)) mkdirSync(resolvedOut, { mode: 0o755 });
    throw error;
  }
}

/** Stable candidate digest: sha256 over the canonical manifest JSON. */
export function candidateDigest(manifest: CandidateManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

async function main(): Promise<void> {
  const outFlag = process.argv.indexOf("--out");
  const outDir = outFlag === -1 ? undefined : process.argv[outFlag + 1];
  if (outDir === undefined || outDir.startsWith("--")) {
    console.error("usage: tsx scripts/assemble-candidate.ts --out DIR");
    process.exit(2);
  }
  try {
    const manifest = assembleCandidate(resolve(outDir));
    console.log(`candidate: ${resolve(outDir)}`);
    console.log(`files: ${manifest.entries.length}`);
    console.log(`digest: ${candidateDigest(manifest)}`);
  } catch (error) {
    console.error(`assemble-candidate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`) {
  await main();
}
