import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

type ImportKind =
  | "dynamic-import"
  | "import"
  | "import-equals"
  | "import-type"
  | "require"
  | "re-export";

type ModuleReference = {
  readonly kind: ImportKind;
  readonly line: number;
  readonly specifier: string;
};

type OpaqueImport = {
  readonly kind: "dynamic-import" | "require";
  readonly line: number;
};

type ParsedImports = {
  readonly opaqueImports: readonly OpaqueImport[];
  readonly references: readonly ModuleReference[];
};

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIRECTORY, "../..");
const SOURCE_ROOT = path.join(PROJECT_ROOT, "src");
const TYPESCRIPT_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);
const GUARDED_DIRECTORIES = [
  "inference/",
  "search/",
  "ui/",
  "worker/",
  "workers/",
] as const;
const CONVENTIONAL_ENTRY_BASENAMES = new Set(["app", "entry", "index", "main"]);

function normalizePath(filePath: string): string {
  const normalized = path.normalize(path.resolve(filePath));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sourceRelativePath(filePath: string): string {
  return path.relative(SOURCE_ROOT, filePath).replaceAll(path.sep, "/");
}

function isTypescriptSource(filePath: string): boolean {
  return TYPESCRIPT_EXTENSIONS.has(path.extname(filePath));
}

function listTypescriptSources(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listTypescriptSources(entryPath);
      }
      return entry.isFile() && isTypescriptSource(entryPath) ? [entryPath] : [];
    })
    .sort();
}

function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  if (
    node !== undefined &&
    (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
  ) {
    return node.text;
  }
  return undefined;
}

function importTypeSpecifier(node: ts.ImportTypeNode): string | undefined {
  if (!ts.isLiteralTypeNode(node.argument)) {
    return undefined;
  }
  return stringLiteralValue(node.argument.literal);
}

function parseImports(fileName: string, sourceText: string): ParsedImports {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const references: ModuleReference[] = [];
  const opaqueImports: OpaqueImport[] = [];

  const addReference = (
    kind: ImportKind,
    node: ts.Node,
    specifier: string,
  ): void => {
    references.push({
      kind,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      specifier,
    });
  };

  const addCallReference = (
    kind: "dynamic-import" | "require",
    node: ts.CallExpression,
  ): void => {
    const specifier = stringLiteralValue(node.arguments[0]);
    if (specifier !== undefined) {
      addReference(kind, node, specifier);
      return;
    }
    opaqueImports.push({
      kind,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralValue(node.moduleSpecifier);
      if (specifier !== undefined) {
        addReference("import", node, specifier);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined
    ) {
      const specifier = stringLiteralValue(node.moduleSpecifier);
      if (specifier !== undefined) {
        addReference("re-export", node, specifier);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = stringLiteralValue(node.moduleReference.expression);
      if (specifier !== undefined) {
        addReference("import-equals", node, specifier);
      }
    } else if (ts.isImportTypeNode(node)) {
      const specifier = importTypeSpecifier(node);
      if (specifier !== undefined) {
        addReference("import-type", node, specifier);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      addCallReference("dynamic-import", node);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      addCallReference("require", node);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { opaqueImports, references };
}

function readCompilerOptions(): ts.CompilerOptions {
  const configPath = path.join(PROJECT_ROOT, "tsconfig.json");
  const readResult = ts.readConfigFile(configPath, (fileName) =>
    ts.sys.readFile(fileName),
  );
  if (readResult.error !== undefined) {
    throw new Error(
      ts.flattenDiagnosticMessageText(readResult.error.messageText, "\n"),
    );
  }

  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    PROJECT_ROOT,
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      ts.formatDiagnostics(parsed.errors, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => PROJECT_ROOT,
        getNewLine: () => "\n",
      }),
    );
  }
  return parsed.options;
}

function htmlEntryPoints(sourceFiles: readonly string[]): Set<string> {
  const indexPath = path.join(PROJECT_ROOT, "index.html");
  if (!fs.existsSync(indexPath)) {
    return new Set();
  }

  const sourceFileSet = new Set(sourceFiles.map(normalizePath));
  const entries = new Set<string>();
  const html = fs.readFileSync(indexPath, "utf8");
  const sourceAttributePattern =
    /<script\b[^>]*\bsrc\s*=\s*["']([^"'?#]+)["'][^>]*>/giu;

  for (const match of html.matchAll(sourceAttributePattern)) {
    const source = match[1];
    if (source === undefined || !source.startsWith("/src/")) {
      continue;
    }
    const candidate = normalizePath(
      path.join(PROJECT_ROOT, source.slice(1).replaceAll("/", path.sep)),
    );
    if (sourceFileSet.has(candidate)) {
      entries.add(candidate);
    }
  }
  return entries;
}

function isGuardedRoot(
  filePath: string,
  htmlEntries: ReadonlySet<string>,
): boolean {
  const normalized = normalizePath(filePath);
  if (htmlEntries.has(normalized)) {
    return true;
  }

  const relativePath = sourceRelativePath(filePath);
  if (GUARDED_DIRECTORIES.some((prefix) => relativePath.startsWith(prefix))) {
    return true;
  }
  if (relativePath.includes(".worker.")) {
    return true;
  }

  if (relativePath.includes("/")) {
    return false;
  }
  const parsed = path.parse(relativePath);
  const basename = parsed.name.endsWith(".d")
    ? parsed.name.slice(0, -2)
    : parsed.name;
  return CONVENTIONAL_ENTRY_BASENAMES.has(basename);
}

function findPath(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  start: string,
  predicate: (filePath: string) => boolean,
): string[] | undefined {
  const queue = [start];
  const previous = new Map<string, string | undefined>([[start, undefined]]);

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined) {
      continue;
    }
    if (predicate(current)) {
      const result: string[] = [];
      let cursor: string | undefined = current;
      while (cursor !== undefined) {
        result.push(cursor);
        cursor = previous.get(cursor);
      }
      return result.reverse();
    }

    for (const dependency of graph.get(current) ?? []) {
      if (!previous.has(dependency)) {
        previous.set(dependency, current);
        queue.push(dependency);
      }
    }
  }
  return undefined;
}

describe("production truth import firewall", () => {
  it("recognizes every supported TypeScript dependency form", () => {
    const parsed = parseImports(
      "fixture.ts",
      `
        import runtime from "./runtime";
        import type { Model } from "./type-only";
        import legacy = require("./import-equals");
        export * from "./barrel";
        export type { Contract } from "./type-barrel";
        const lazy = import("./dynamic");
        const cjs = require("./require");
        type Query = import("./import-type").Query;
        const unknownLazy = import(moduleName);
      `,
    );

    expect(
      parsed.references.map(({ kind, specifier }) => [kind, specifier]),
    ).toEqual([
      ["import", "./runtime"],
      ["import", "./type-only"],
      ["import-equals", "./import-equals"],
      ["re-export", "./barrel"],
      ["re-export", "./type-barrel"],
      ["dynamic-import", "./dynamic"],
      ["require", "./require"],
      ["import-type", "./import-type"],
    ]);
    expect(parsed.opaqueImports).toEqual([
      { kind: "dynamic-import", line: 10 },
    ]);
  });

  it("prevents guarded production paths and the evaluation hook boundary from reaching simulator truth", () => {
    const sourceFiles = listTypescriptSources(SOURCE_ROOT);
    const normalizedSources = new Map(
      sourceFiles.map((filePath) => [normalizePath(filePath), filePath]),
    );
    const compilerOptions = readCompilerOptions();
    const graph = new Map<string, Set<string>>();
    const opaqueByFile = new Map<string, readonly OpaqueImport[]>();

    for (const sourceFile of sourceFiles) {
      const normalizedSource = normalizePath(sourceFile);
      const parsed = parseImports(
        sourceFile,
        fs.readFileSync(sourceFile, "utf8"),
      );
      opaqueByFile.set(normalizedSource, parsed.opaqueImports);
      const dependencies = new Set<string>();

      for (const reference of parsed.references) {
        const resolution = ts.resolveModuleName(
          reference.specifier,
          sourceFile,
          compilerOptions,
          ts.sys,
        ).resolvedModule;
        if (resolution === undefined) {
          continue;
        }
        const normalizedDependency = normalizePath(resolution.resolvedFileName);
        if (normalizedSources.has(normalizedDependency)) {
          dependencies.add(normalizedDependency);
        }
      }
      graph.set(normalizedSource, dependencies);
    }

    const htmlEntries = htmlEntryPoints(sourceFiles);
    const guardedRoots = sourceFiles
      .map(normalizePath)
      .filter((filePath) => isGuardedRoot(filePath, htmlEntries));
    const simulatorPrefix = `${normalizePath(
      path.join(SOURCE_ROOT, "simulator"),
    )}${path.sep}`;
    const isSimulatorFile = (filePath: string): boolean =>
      filePath.startsWith(simulatorPrefix);
    const violations: string[] = [];
    const evaluationHookBoundary = normalizePath(
      path.join(SOURCE_ROOT, "simulator", "evaluation-user-policy.ts"),
    );
    const simulatorTruth = normalizePath(
      path.join(SOURCE_ROOT, "simulator", "truth.ts"),
    );
    const evaluationTruthPath = findPath(
      graph,
      evaluationHookBoundary,
      (filePath) => filePath === simulatorTruth,
    );
    if (evaluationTruthPath !== undefined) {
      violations.push(
        `evaluation hook truth dependency: ${evaluationTruthPath
          .map(sourceRelativePath)
          .join(" -> ")}`,
      );
    }
    const evaluationOpaquePath = findPath(
      graph,
      evaluationHookBoundary,
      (filePath) => (opaqueByFile.get(filePath)?.length ?? 0) > 0,
    );
    if (evaluationOpaquePath !== undefined) {
      violations.push(
        `evaluation hook unverifiable import: ${evaluationOpaquePath
          .map(sourceRelativePath)
          .join(" -> ")}`,
      );
    }

    for (const guardedRoot of guardedRoots) {
      const simulatorPath = findPath(graph, guardedRoot, isSimulatorFile);
      if (simulatorPath !== undefined) {
        violations.push(
          `simulator dependency: ${simulatorPath
            .map(sourceRelativePath)
            .join(" -> ")}`,
        );
      }

      const opaquePath = findPath(
        graph,
        guardedRoot,
        (filePath) => (opaqueByFile.get(filePath)?.length ?? 0) > 0,
      );
      if (opaquePath !== undefined) {
        const opaqueFile = opaquePath.at(-1);
        if (opaqueFile !== undefined) {
          for (const opaqueImport of opaqueByFile.get(opaqueFile) ?? []) {
            violations.push(
              `unverifiable ${opaqueImport.kind}: ${opaquePath
                .map(sourceRelativePath)
                .join(" -> ")}:${opaqueImport.line}`,
            );
          }
        }
      }
    }

    expect(
      violations,
      [
        "Guarded production code must not reach src/simulator/**.",
        "The evaluation user-policy boundary must not reach simulator truth.",
        "Dynamic imports and require calls must use a string literal so this",
        "transitive check cannot be bypassed.",
        ...violations,
      ].join("\n"),
    ).toEqual([]);
  });
});
