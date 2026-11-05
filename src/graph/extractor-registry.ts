import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export interface ExtractorPluginModule {
  name: string;
  modulePath: string;
  root: string;
  contentHash: string;
  scope: "project" | "global";
}

const EXTENSIONS = [".mjs", ".js", ".ts"] as const;
const PLUGIN_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_MODULE_BYTES = 256 * 1024;
const MAX_PLUGIN_TREE_FILES = 128;
const MAX_PLUGIN_TREE_BYTES = 4 * 1024 * 1024;

function safeRoot(path: string, scope: "project" | "global"): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    if (scope === "global") {
      if ((stat.mode & 0o022) !== 0) return undefined;
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return undefined;
    }
    const real = realpathSync(path);
    const resolved = resolve(path);
    if (real !== resolved) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

function hashRoot(root: string): string | undefined {
  const entries: Array<{ path: string; bytes: Buffer }> = [];
  let totalBytes = 0;
  const walk = (dir: string): boolean => {
    let names: string[];
    try { names = readdirSync(dir).sort(); }
    catch { return false; }
    for (const name of names) {
      const path = join(dir, name);
      let stat;
      try { stat = lstatSync(path); }
      catch { return false; }
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        if (!walk(path)) return false;
      } else if (stat.isFile()) {
        if (entries.length >= MAX_PLUGIN_TREE_FILES) return false;
        totalBytes += stat.size;
        if (totalBytes > MAX_PLUGIN_TREE_BYTES) return false;
        entries.push({ path: relative(root, path).split("\\").join("/"), bytes: readFileSync(path) });
      }
    }
    return true;
  };
  if (!walk(root)) return undefined;
  const hash = createHash("sha256");
  for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path, "utf8").update("\0").update(entry.bytes).update("\0");
  }
  return hash.digest("hex");
}

function scanRoot(root: string, scope: "project" | "global"): ExtractorPluginModule[] {
  const contentHash = hashRoot(root);
  if (contentHash === undefined) return [];
  let names: string[];
  try { names = readdirSync(root).sort(); }
  catch { return []; }
  const found = new Map<string, ExtractorPluginModule>();
  const ambiguous = new Set<string>();
  for (const filename of names) {
    const extension = EXTENSIONS.find((candidate) => filename.endsWith(candidate));
    if (extension === undefined) continue;
    const name = filename.slice(0, -extension.length);
    if (!PLUGIN_NAME.test(name) || name.endsWith(".d")) continue;
    const modulePath = join(root, filename);
    try {
      const stat = lstatSync(modulePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MODULE_BYTES) continue;
      const real = realpathSync(modulePath);
      const rel = relative(root, real);
      if (rel.startsWith("..") || dirname(real) !== root) continue;
      if (found.has(name)) ambiguous.add(name);
      else found.set(name, { name, modulePath: real, root, contentHash, scope });
    } catch {
      // Unsafe/transient entries are omitted and explicit references fail visibly.
    }
  }
  for (const name of ambiguous) found.delete(name);
  return [...found.values()];
}

/** Project modules shadow global modules by name; unsafe paths are ignored. */
export function discoverExtractorPlugins(workspaceRoot: string): Map<string, ExtractorPluginModule> {
  const projectDir = resolve(workspaceRoot, ".jev", "extractors");
  // Read HOME at call time so tests and embedded worker threads honor scoped
  // home overrides instead of a cached OS-level home directory.
  const home = process.env.HOME?.trim() || homedir();
  const globalDir = resolve(home, ".config", "jev-agent", "extractors");
  const projectRoot = safeRoot(projectDir, "project");
  const globalRoot = safeRoot(globalDir, "global");
  const plugins = new Map<string, ExtractorPluginModule>();
  if (globalRoot !== undefined) {
    for (const plugin of scanRoot(globalRoot, "global")) plugins.set(plugin.name, plugin);
  }
  if (projectRoot !== undefined) {
    for (const plugin of scanRoot(projectRoot, "project")) plugins.set(plugin.name, plugin);
  }
  return plugins;
}
