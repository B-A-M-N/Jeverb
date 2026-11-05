/**
 * Architectural dependency rules, enforced statically.
 *
 * Edges come from TypeScript AST traversal (not regex), so value
 * re-exports (`export ... from`), dynamic `import()`, and `import type`
 * are classified by what they actually emit:
 *
 * - No runtime import cycles between source modules.
 * - `control/` and `evidence/` must not depend on `hooks/store.ts` at runtime
 *   (the master-switch behavior lives in `control/`, not in the session store).
 *   The `store-lock.ts` file-lock primitive is an explicit exception.
 * - Leaf modules (AGENTS.md Ownership) must not import their former parent
 *   at runtime: extracted code stays leaf-ward, `import type` excepted.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as ts from "typescript";

const SRC = resolve(__dirname, "../../src");

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith(".ts")) out.push(path);
    }
  };
  walk(SRC);
  return out;
}

interface Edge {
  to: string;
  typeOnly: boolean;
}

/** Resolve a relative module specifier to a known source file, if it names one. */
function resolveTarget(from: string, spec: string, known: Set<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  let target = resolve(dirname(from), spec);
  if (target.endsWith(".js")) target = target.slice(0, -3) + ".ts";
  else if (!target.endsWith(".ts")) target += ".ts";
  return known.has(target) ? target : undefined;
}

/**
 * Runtime vs type-only edges in one source text. `export ... from` counts
 * as runtime unless every re-exported name is type-only; dynamic
 * `import()` always counts as runtime; `import(...)` type positions are
 * types, not call expressions, and are ignored.
 */
export function edgesInSource(file: string, src: string, known: Set<string>): Edge[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const edges: Edge[] = [];
  const add = (spec: string | undefined, typeOnly: boolean): void => {
    if (spec === undefined) return;
    const target = resolveTarget(file, spec, known);
    if (target !== undefined) edges.push({ to: target, typeOnly });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      add(ts.isStringLiteral(spec) ? spec.text : undefined, node.importClause?.isTypeOnly ?? false);
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        const spec = node.moduleSpecifier;
        const named = node.exportClause;
        const allType =
          node.isTypeOnly ||
          (named !== undefined &&
            ts.isNamedExports(named) &&
            named.elements.length > 0 &&
            named.elements.every((e) => e.isTypeOnly));
        add(ts.isStringLiteral(spec) ? spec.text : undefined, allType);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      add(arg !== undefined && ts.isStringLiteral(arg) ? arg.text : undefined, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return edges;
}

function edgesOf(file: string, known: Set<string>): Edge[] {
  return edgesInSource(file, readFileSync(file, "utf8"), known);
}

function runtimeCycles(): string[][] {
  const files = sourceFiles();
  const known = new Set(files);
  const adj = new Map<string, string[]>();
  for (const file of files) {
    adj.set(
      file,
      edgesOf(file, known)
        .filter((e) => !e.typeOnly)
        .map((e) => e.to),
    );
  }
  // Tarjan SCC.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;
  const strong = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1 || (adj.get(v) ?? []).includes(v)) cycles.push(component);
    }
  };
  for (const file of files) if (!index.has(file)) strong(file);
  return cycles;
}

const short = (f: string): string => f.replace(`${SRC}/`, "");

/** Leaf rule over explicit edges: returns `leaf -> target` violation strings. */
export function findLeafViolations(leafRel: string, bannedPrefix: string, edges: Edge[]): string[] {
  const violations: string[] = [];
  for (const edge of edges) {
    if (edge.typeOnly) continue;
    const target = short(edge.to);
    if (target === leafRel) continue;
    if (target.startsWith(bannedPrefix)) violations.push(`${leafRel} -> ${target}`);
  }
  return violations;
}

describe("architectural dependency rules", () => {
  it("has no runtime import cycles", () => {
    const cycles = runtimeCycles();
    expect(
      cycles.map((c) => c.map(short).sort().join(" <-> ")),
      "runtime import cycle detected",
    ).toEqual([]);
  });

  it("keeps leaf modules independent of their former parents at runtime", () => {
    // AGENTS.md Ownership: one-way, leaf-ward. A leaf importing its parent
    // at runtime would reintroduce the cycles this decomposition removed.
    // Paths are SRC-relative on both sides (see `short`): comparing a
    // `src/`-prefixed leaf against stripped targets can never match.
    const leaves: Array<[leaf: string, bannedPrefix: string]> = [
      ["control/master-switch.ts", "hooks/"],
      ["graph/validate.ts", "graph/executor.ts"],
      ["graph/terminal.ts", "graph/executor.ts"],
      ["tools/graph-bindings.ts", "tools/execute-graph.ts"],
      ["hooks/decision-record.ts", "hooks/store.ts"],
      ["hooks/subagent-tasks.ts", "hooks/store.ts"],
      ["hooks/observations.ts", "hooks/store.ts"],
      ["hooks/decision-log.ts", "hooks/store.ts"],
      ["hooks/store-lock.ts", "hooks/store.ts"],
      ["hooks/tripwire.ts", "hooks/store.ts"],
      ["evidence/receipt-validation.ts", "evidence/ledger.ts"],
      ["hooks/handlers/response.ts", "hooks/handlers/"],
      ["hooks/handlers/stop-policy.ts", "hooks/handlers/stop.ts"],
      ["hooks/mcp-policy.ts", "hooks/prefilter.ts"],
    ];
    const known = new Set(sourceFiles());
    const violations: string[] = [];
    for (const [leafRel, bannedPrefix] of leaves) {
      const leaf = resolve(SRC, leafRel);
      if (!known.has(leaf)) {
        violations.push(`missing leaf module: ${leafRel}`);
        continue;
      }
      violations.push(...findLeafViolations(leafRel, bannedPrefix, edgesOf(leaf, known)));
    }
    expect(violations, "leaf module imports its former parent at runtime").toEqual([]);
  });

  it("keeps control/ and evidence/ independent of hooks/store.ts at runtime", () => {
    const files = sourceFiles();
    const known = new Set(files);
    const violations: string[] = [];
    for (const file of files) {
      const rel = short(file);
      if (!rel.startsWith("control/") && !rel.startsWith("evidence/")) continue;
      for (const edge of edgesOf(file, known)) {
        if (edge.typeOnly) continue;
        const target = short(edge.to);
        if (target === "hooks/store-lock.ts") continue; // file-lock primitive: allowed
        if (target === "hooks/store.ts") violations.push(`${rel} -> ${target}`);
      }
    }
    expect(violations, "inverted runtime dependency on hooks/store.ts").toEqual([]);
  });

  it("keeps Stop policy free of mission and control orchestration", () => {
    const known = new Set(sourceFiles());
    const policy = resolve(SRC, "hooks/handlers/stop-policy.ts");
    const forbidden = new Set([
      "mission/session-source.ts",
      "decision/loop.ts",
      "hooks/store.ts",
      "hooks/types.ts",
    ]);
    const violations = edgesOf(policy, known)
      .filter((edge) => !edge.typeOnly && forbidden.has(short(edge.to)))
      .map((edge) => `stop-policy.ts -> ${short(edge.to)}`);
    expect(violations, "Stop policy owns policy construction, not host orchestration").toEqual([]);
  });
});

describe("dependency analyzer", () => {
  const known = new Set(["/x/a.ts", "/x/b.ts"]);
  const edges = (src: string): Edge[] => edgesInSource("/x/a.ts", src, known);

  it("separates value imports from import type", () => {
    expect(edges(`import { x } from "./b";`).map((e) => e.typeOnly)).toEqual([false]);
    expect(edges(`import type { X } from "./b";`).map((e) => e.typeOnly)).toEqual([true]);
    expect(edges(`import "./b";`).map((e) => e.typeOnly)).toEqual([false]);
  });

  it("detects value re-exports that the old import regex missed", () => {
    expect(edges(`export { x } from "./b";`).map((e) => e.typeOnly)).toEqual([false]);
    expect(edges(`export * from "./b";`).map((e) => e.typeOnly)).toEqual([false]);
    expect(edges(`export type { X } from "./b";`).map((e) => e.typeOnly)).toEqual([true]);
    expect(edges(`export { type X } from "./b";`).map((e) => e.typeOnly)).toEqual([true]);
  });

  it("treats dynamic import() as runtime and type import() as inert", () => {
    expect(edges(`const m = await import("./b");`).map((e) => e.typeOnly)).toEqual([false]);
    expect(edges(`const x: import("./b").X | undefined = undefined;`).map((e) => e.typeOnly)).toEqual([]);
  });

  it("ignores bare packages and unknown targets", () => {
    expect(edges(`import { z } from "zod";`)).toEqual([]);
    expect(edges(`import { q } from "./missing";`)).toEqual([]);
  });

  it("flags a prohibited parent edge through the leaf rule", () => {
    const bad: Edge[] = [{ to: join(SRC, "b.ts"), typeOnly: false }];
    expect(findLeafViolations("a.ts", "b.ts", bad)).toEqual(["a.ts -> b.ts"]);
    expect(findLeafViolations("a.ts", "other.ts", bad)).toEqual([]);
    expect(findLeafViolations("a.ts", "b.ts", [{ to: join(SRC, "b.ts"), typeOnly: true }])).toEqual([]);
    expect(findLeafViolations("a.ts", "a.ts", [{ to: join(SRC, "a.ts"), typeOnly: false }])).toEqual([]);
  });
});
