/**
 * Purpose: own the lifetime of temporary directories created by tests.
 * Owner: test fixture cleanup; callers own each directory's contents.
 * Cleanup runs after the importing test file completes, so a test may share
 * its private root across cases without leaving it behind for later runs.
 */

import { chmodSync, lstatSync, mkdtempSync as createTempDirectory, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";

const directories = new Set<string>();

function makeDirectoriesRemovable(path: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  chmodSync(path, stat.mode | 0o700);
  for (const entry of readdirSync(path)) {
    makeDirectoriesRemovable(join(path, entry));
  }
}

afterAll(() => {
  for (const directory of directories) {
    makeDirectoriesRemovable(directory);
    rmSync(directory, { recursive: true, force: true });
  }
  directories.clear();
});

/** Create and register a unique test root for cleanup after this test file. */
export function mkdtempSync(prefix: string): string {
  const directory = createTempDirectory(prefix);
  directories.add(directory);
  return directory;
}
