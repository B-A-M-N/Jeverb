/**
 * Bounded TypeScript structure evidence for a host-declared code obligation.
 *
 * This module reports syntax and compiler-resolved symbol relationships only.
 * It does not assert behavior, completeness, or verification. Paths must be
 * explicitly supplied by a trusted host and are read through the existing
 * symlink-safe verifier boundary.
 */
import { createHash } from "node:crypto";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { readVerifierFileBytes, type VerifierFs } from "./verifiers.js";

export const STRUCTURAL_ANALYSIS_VERSION = "typescript-structure/1";
export const MAX_STRUCTURAL_FILES = 16;
export const MAX_STRUCTURAL_FILE_BYTES = 256 * 1024;
export const MAX_STRUCTURAL_SYMBOLS = 256;
export const MAX_STRUCTURAL_IMPORTS = 128;
export const MAX_STRUCTURAL_CALLS = 512;

export interface CodeStructureSymbol {
  id: string;
  path: string;
  name: string;
  kind: "function" | "method" | "class" | "interface" | "type" | "variable";
  line: number;
}

export interface CodeStructureImport {
  path: string;
  specifier: string;
  line: number;
  resolution: "compiler-resolved" | "unresolved";
  resolvedPath?: string;
}

export interface CodeStructureCall {
  path: string;
  callerSymbolId?: string;
  callee: string;
  line: number;
  relation: "compiler-resolved" | "syntactic-unresolved";
  targetSymbolId?: string;
}

export interface CriterionCodeStructureEvidence {
  version: typeof STRUCTURAL_ANALYSIS_VERSION;
  criterionId: string;
  proofObligationId: string;
  missionRevision: string;
  candidateDigest: string;
  provenance: "host:typescript-compiler/v1";
  fileDigests: Array<{ path: string; sha256: string }>;
  symbols: CodeStructureSymbol[];
  imports: CodeStructureImport[];
  calls: CodeStructureCall[];
  evidenceDigest: string;
  limitations: readonly [
    "static structure only; no behavior is verified",
    "compiler resolution is limited to the host-declared file set",
  ];
}

const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const symbolId = (path: string, name: string, line: number): string =>
  `sym-${sha256(`${path.length}:${path}${name.length}:${name}${line}`).slice(0, 24)}`;

function sourceName(node: ts.Node, source: ts.SourceFile): string {
  const name = (node as ts.NamedDeclaration).name;
  if (name !== undefined) return name.getText(source).slice(0, 160);
  return `anonymous@${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
}

function symbolKind(node: ts.Node): CodeStructureSymbol["kind"] | undefined {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return "variable";
  return undefined;
}

/** Analyze explicit TypeScript/TSX paths and bind observations to one obligation. */
export function analyzeCriterionTypeScriptStructure(args: {
  root: string;
  files: readonly string[];
  criterionId: string;
  proofObligationId: string;
  missionRevision: string;
  candidateDigest: string;
  fs?: VerifierFs;
}): CriterionCodeStructureEvidence {
  if (!HEX64.test(args.missionRevision) || !HEX64.test(args.candidateDigest) ||
      args.criterionId.trim() === "" || args.proofObligationId.trim() === "") {
    throw new Error("structural analysis requires bounded obligation and revision identities");
  }
  if (!Array.isArray(args.files) || args.files.length === 0 || args.files.length > MAX_STRUCTURAL_FILES) {
    throw new Error(`structural analysis requires 1..${MAX_STRUCTURAL_FILES} host-declared files`);
  }
  const root = resolve(args.root);
  const loaded = new Map<string, { path: string; text: string; digest: string }>();
  for (const declaredPath of [...new Set(args.files)]) {
    const absolute = resolve(root, declaredPath);
    const path = relative(root, absolute);
    if (path === "" || path.startsWith(`..${sep}`) || path === ".." || absolute === root) {
      throw new Error("structural analysis path escapes its host root");
    }
    if (!/\.(?:ts|tsx|mts|cts)$/.test(path)) throw new Error("structural analysis accepts TypeScript source paths only");
    const bytes = readVerifierFileBytes(root, path, args.fs);
    if (bytes.byteLength > MAX_STRUCTURAL_FILE_BYTES) throw new Error("structural analysis source exceeds the per-file size bound");
    const absolutePath = resolve(root, path);
    loaded.set(absolutePath, { path, text: bytes.toString("utf8"), digest: sha256(bytes) });
  }

  const options: ts.CompilerOptions = {
    allowJs: false,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host = ts.createCompilerHost(options, true);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const isDeclared = (fileName: string): boolean => loaded.has(resolve(fileName));
  const resolveDeclaredModule = (specifier: string, containingFile: string): string | undefined => {
    if (!specifier.startsWith(".")) return undefined;
    const base = resolve(dirname(containingFile), specifier);
    const candidates = [base];
    for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
      if (/\.(?:js|jsx|mjs|cjs)$/.test(base)) candidates.push(base.replace(/\.(?:js|jsx|mjs|cjs)$/, extension));
      else if (!/\.(?:ts|tsx|mts|cts)$/.test(base)) candidates.push(`${base}${extension}`);
    }
    return candidates.find((candidate) => loaded.has(resolve(candidate)));
  };
  host.fileExists = (fileName) => isDeclared(fileName) || originalFileExists(fileName) && ts.getDefaultLibFilePath(options) === resolve(fileName);
  host.readFile = (fileName) => {
    const entry = loaded.get(resolve(fileName));
    if (entry !== undefined) return entry.text;
    return ts.getDefaultLibFilePath(options) === resolve(fileName) ? originalReadFile(fileName) : undefined;
  };
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const entry = loaded.get(resolve(fileName));
    if (entry !== undefined) return ts.createSourceFile(fileName, entry.text, languageVersion, true);
    if (ts.getDefaultLibFilePath(options) === resolve(fileName)) {
      return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    }
    return undefined;
  };
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map((specifier) => {
    const declared = resolveDeclaredModule(specifier, containingFile);
    return declared === undefined ? undefined : {
      resolvedFileName: declared,
      extension: declared.endsWith(".tsx") ? ts.Extension.Tsx : declared.endsWith(".mts") ? ts.Extension.Mts : declared.endsWith(".cts") ? ts.Extension.Cts : ts.Extension.Ts,
      isExternalLibraryImport: false,
    };
  });
  const program = ts.createProgram([...loaded.keys()], options, host);
  const checker = program.getTypeChecker();
  const symbols: CodeStructureSymbol[] = [];
  const imports: CodeStructureImport[] = [];
  const calls: CodeStructureCall[] = [];
  const byDeclaration = new Map<ts.Node, CodeStructureSymbol>();

  for (const source of program.getSourceFiles()) {
    const entry = loaded.get(resolve(source.fileName));
    if (entry === undefined) continue;
    const visitDeclarations = (node: ts.Node): void => {
      const kind = symbolKind(node);
      if (kind !== undefined && symbols.length < MAX_STRUCTURAL_SYMBOLS) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const name = sourceName(node, source);
        const symbol = { id: symbolId(entry.path, name, line), path: entry.path, name, kind, line };
        symbols.push(symbol);
        byDeclaration.set(node, symbol);
      }
      if (ts.isImportDeclaration(node) && imports.length < MAX_STRUCTURAL_IMPORTS && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const resolved = resolveDeclaredModule(specifier, source.fileName) ??
          ts.resolveModuleName(specifier, source.fileName, options, host).resolvedModule?.resolvedFileName;
        const resolvedEntry = resolved === undefined ? undefined : loaded.get(resolve(resolved));
        imports.push({
          path: entry.path,
          specifier: specifier.slice(0, 200),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          resolution: resolvedEntry === undefined ? "unresolved" : "compiler-resolved",
          ...(resolvedEntry === undefined ? {} : { resolvedPath: resolvedEntry.path }),
        });
      }
      ts.forEachChild(node, visitDeclarations);
    };
    visitDeclarations(source);

    const visitCalls = (node: ts.Node, current?: CodeStructureSymbol): void => {
      const own = byDeclaration.get(node) ?? current;
      if (ts.isCallExpression(node) && calls.length < MAX_STRUCTURAL_CALLS) {
        const expression = node.expression;
        const apparent = expression.getText(source).slice(0, 200);
        let target = checker.getSymbolAtLocation(expression);
        if (target !== undefined && (target.flags & ts.SymbolFlags.Alias) !== 0) {
          try { target = checker.getAliasedSymbol(target); } catch { target = undefined; }
        }
        const declaration = target?.valueDeclaration ?? target?.declarations?.[0];
        const targetSource = declaration?.getSourceFile();
        const targetEntry = targetSource === undefined ? undefined : loaded.get(resolve(targetSource.fileName));
        const targetName = target?.getName();
        const targetLine = declaration === undefined || targetSource === undefined
          ? undefined
          : targetSource.getLineAndCharacterOfPosition(declaration.getStart(targetSource)).line + 1;
        calls.push({
          path: entry.path,
          ...(own === undefined ? {} : { callerSymbolId: own.id }),
          callee: apparent,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          relation: targetEntry === undefined ? "syntactic-unresolved" : "compiler-resolved",
          ...(targetEntry === undefined || targetName === undefined || targetLine === undefined
            ? {}
            : { targetSymbolId: symbolId(targetEntry.path, targetName, targetLine) }),
        });
      }
      ts.forEachChild(node, (child) => visitCalls(child, own));
    };
    visitCalls(source);
  }

  const fileDigests = [...loaded.values()].map(({ path, digest }) => ({ path, sha256: digest })).sort((a, b) => a.path.localeCompare(b.path));
  symbols.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.id.localeCompare(b.id));
  imports.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  calls.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.callee.localeCompare(b.callee));
  const binding = {
    version: STRUCTURAL_ANALYSIS_VERSION as typeof STRUCTURAL_ANALYSIS_VERSION,
    criterionId: args.criterionId,
    proofObligationId: args.proofObligationId,
    missionRevision: args.missionRevision,
    candidateDigest: args.candidateDigest,
    provenance: "host:typescript-compiler/v1" as const,
    fileDigests,
    symbols,
    imports,
    calls,
    limitations: [
      "static structure only; no behavior is verified",
      "compiler resolution is limited to the host-declared file set",
    ] as const,
  };
  return { ...binding, evidenceDigest: sha256(JSON.stringify(binding)) };
}
