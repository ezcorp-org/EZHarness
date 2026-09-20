#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { REPO_ROOT } from "./coverage-config.ts";

export interface SourceInput {
  path: string;
  source: string;
}

export interface BoundaryViolation {
  path: string;
  line: number;
  rule: "validator-code-generation" | "f13-duplicate" | "f13-required-import";
  message: string;
}

export interface RequiredImport {
  factoryPath: string;
  sharedModule: string;
}

const VALIDATOR_PATHS = new Set([
  "packages/@ezcorp/factory-sdk/src/expressions.ts",
  "packages/@ezcorp/factory-sdk/src/validation.ts",
]);

export const SHARED_REUSE_MODULES = [
  "packages/@ezcorp/extension-runner/src/podman.ts",
  // The second pinned guest language extends the shared runner rather than
  // forking its launch path, so it is shared under the same C13 row (W02).
  "packages/@ezcorp/extension-runner/src/materials.ts",
  "packages/@ezcorp/extension-runner/src/python.ts",
  "packages/@ezcorp/extension-runner/src/dependencies.ts",
  "packages/@ezcorp/extension-runner/src/index.ts",
  "src/extensions/v4/lifecycle.ts",
  "src/extensions/project-pull-request-broker.ts",
  // The broker's own GitHub transport. C10 requires the factory release adapter to reuse the
  // pull-request broker's host-held credential path rather than open its own; sharing the
  // transport is what makes that an executable boundary (W07).
  "src/extensions/project-github-transport.ts",
  "src/extensions/secrets-store.ts",
  "src/extensions/credential-broker.ts",
  "src/extensions/network-broker.ts",
  "src/extensions/host-api-broker.ts",
  "src/extensions/v4/deliveries.ts",
  "src/delivery-queue/durable-delivery-queue.ts",
  "src/extensions/lifecycle-recovery-scheduler.ts",
  "src/extensions/v4/blobs.ts",
  // The v4 content digest, split out of `blobs.ts` so a caller that only hashes bytes does not
  // carry an S3 client. Shared under the same C13 row as the blob store it came from (W10).
  "src/extensions/v4/digest.ts",
  "src/db/queries/audit-log.ts",
  "src/extensions/host-maintenance-daemon.ts",
] as const;

// Every factory module that implements a C13 row must import its named shared
// implementation. This makes reuse an executable boundary, not a review note.
//
// COMPLETE, not a sample. W18 derived this list from the real integ/w00 import
// graph: 46 edges exist, 12 were declared, so 34 reuse relationships were
// un-gated and a work package could have dropped one without any check
// noticing. scripts/factory-c13-inventory.test.ts re-derives the graph on
// every run and fails when an edge has no row here, so the next package that
// starts reusing a shared module must append its row rather than wait for an
// audit. Regenerate with that test's `sharedImportEdges` helper; keep the
// rows sorted by factory path so appends from different packages merge.
export const REQUIRED_SHARED_IMPORTS: readonly RequiredImport[] = [
  { factoryPath: "src/factory/archive-writer.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/artifact-access.ts", sharedModule: "src/db/queries/audit-log.ts" },
  { factoryPath: "src/factory/artifact-access.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/admission-origin.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/child-artifacts.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/release-github.ts", sharedModule: "src/extensions/project-github-transport.ts" },
  { factoryPath: "src/factory/release-github.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/release-profile.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/artifacts.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/assurance-commands.ts", sharedModule: "src/db/queries/audit-log.ts" },
  { factoryPath: "src/factory/assurance-commands.ts", sharedModule: "src/delivery-queue/durable-delivery-queue.ts" },
  { factoryPath: "src/factory/assurance-commands.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/assurance.ts", sharedModule: "src/db/queries/audit-log.ts" },
  { factoryPath: "src/factory/assurance.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/attempt-queue.ts", sharedModule: "src/delivery-queue/durable-delivery-queue.ts" },
  { factoryPath: "src/factory/budgets.ts", sharedModule: "src/db/queries/audit-log.ts" },
  { factoryPath: "src/factory/budgets.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/child-release-mode.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/child-runs.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/command-authority.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/compute-admissions.ts", sharedModule: "src/delivery-queue/durable-delivery-queue.ts" },
  { factoryPath: "src/factory/definitions.ts", sharedModule: "src/db/queries/audit-log.ts" },
  { factoryPath: "src/factory/definitions.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/executions.ts", sharedModule: "src/db/queries/audit-log.ts" },
  { factoryPath: "src/factory/executions.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/grants.ts", sharedModule: "src/db/queries/audit-log.ts" },
  { factoryPath: "src/factory/grants.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/inbox.ts", sharedModule: "src/delivery-queue/durable-delivery-queue.ts" },
  { factoryPath: "src/factory/lazy-input.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/legacy-workflow/adapter.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/legacy-workflow/classification.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/legacy-workflow/import.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/native-runner-policy.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/outbox.ts", sharedModule: "src/delivery-queue/durable-delivery-queue.ts" },
  { factoryPath: "src/factory/package-preparation.ts", sharedModule: "src/db/queries/audit-log.ts" },
  { factoryPath: "src/factory/package-preparation.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/protected-command-effects.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/reference-code/freeze.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/reference-code/freeze.ts", sharedModule: "src/extensions/v4/digest.ts" },
  { factoryPath: "src/factory/reference-code/generate.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/reference-code/generate.ts", sharedModule: "src/extensions/v4/digest.ts" },
  { factoryPath: "src/factory/reference-code/review.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/reference-code/snapshot.ts", sharedModule: "src/extensions/v4/digest.ts" },
  { factoryPath: "src/factory/reference-code/static-claims.ts", sharedModule: "src/extensions/v4/digest.ts" },
  { factoryPath: "src/factory/reference-code/workspace.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/records.ts", sharedModule: "src/db/queries/audit-log.ts" },
  { factoryPath: "src/factory/records.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/reference-data/csv.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/reference-data/guest.ts", sharedModule: "packages/@ezcorp/extension-runner/src/index.ts" },
  { factoryPath: "src/factory/reference-data/guest.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  // The hardened material read-back is re-exported from the runner's entry
  // point and the package publishes no subpath for it, so the declared edge is
  // the entry point. `materials.ts` is in SHARED_REUSE_MODULES above, which is
  // what makes a second implementation of `listRunnerMaterials` or
  // `openRunnerMaterial` a duplicate violation rather than a matter of taste.
  { factoryPath: "src/factory/reference-data/materials.ts", sharedModule: "packages/@ezcorp/extension-runner/src/index.ts" },
  { factoryPath: "src/factory/reference-data/materials.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/reference-data/pack.ts", sharedModule: "packages/@ezcorp/extension-runner/src/index.ts" },
  { factoryPath: "src/factory/reference-data/reconcile.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/release-adapters.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/release-s3-publication.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/release-authority.ts", sharedModule: "src/db/queries/audit-log.ts" },
  { factoryPath: "src/factory/release-authority.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/artifact-materials.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/artifacts.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/executions.ts", sharedModule: "src/db/queries/audit-log.ts" },
  { factoryPath: "src/factory/executions.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/artifacts.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/releases.ts", sharedModule: "src/db/queries/audit-log.ts" },
  { factoryPath: "src/factory/releases.ts", sharedModule: "src/delivery-queue/durable-delivery-queue.ts" },
  { factoryPath: "src/factory/releases.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/run-controls.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/run-lifecycle.ts", sharedModule: "src/db/queries/audit-log.ts" },
  { factoryPath: "src/factory/run-lifecycle.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/runner/attempt-runtime.ts", sharedModule: "packages/@ezcorp/extension-runner/src/index.ts" },
  { factoryPath: "src/factory/runner/native.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/runner/python-guest.ts", sharedModule: "packages/@ezcorp/extension-runner/src/index.ts" },
  { factoryPath: "src/factory/runner/supervisor.ts", sharedModule: "packages/@ezcorp/extension-runner/src/index.ts" },
  { factoryPath: "src/factory/service-credentials.ts", sharedModule: "src/db/queries/audit-log.ts" },
  { factoryPath: "src/factory/service-credentials.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/task-admission.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/task-completions.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/task-outcomes.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/task-stops.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/transition-artifacts.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/usage-settlement.ts", sharedModule: "src/extensions/v4/blobs.ts" },
  { factoryPath: "src/factory/validator-materials.ts", sharedModule: "src/extensions/v4/blobs.ts" },
];

function parse(input: SourceInput): ts.SourceFile {
  return ts.createSourceFile(input.path, input.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function callName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return `${callName(expression.expression) ?? ""}.${expression.name.text}`;
  return undefined;
}

function validatorViolations(input: SourceInput, validatorPaths: ReadonlySet<string>): BoundaryViolation[] {
  if (!validatorPaths.has(input.path)) return [];
  const sourceFile = parse(input);
  const violations: BoundaryViolation[] = [];
  const add = (node: ts.Node, message: string) => violations.push({
    path: input.path,
    line: lineOf(sourceFile, node),
    rule: "validator-code-generation",
    message,
  });

  function visit(node: ts.Node): void {
    if (ts.isRegularExpressionLiteral(node)) add(node, "regular expressions are forbidden in the deterministic validator");
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      if (/^(?:node:)?(?:child_process|cluster|dgram|dns|http|https|net|tls|vm|worker_threads)$/.test(moduleName)) {
        add(node, `runtime module '${moduleName}' is forbidden in the deterministic validator`);
      }
    }
    if (ts.isIdentifier(node) && [
      "eval",
      "Function",
      "RegExp",
      "fetch",
      "WebSocket",
      "XMLHttpRequest",
      "EventSource",
      "globalThis",
      "Reflect",
    ].includes(node.text)) {
      const parent = node.parent;
      const isDeclarationName = (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node;
      const isPropertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (!isDeclarationName && !isPropertyName) add(node, `'${node.text}' is forbidden in the deterministic validator`);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const name = callName(node);
      if (name && (
        ["Date.now", "performance.now", "process.hrtime", "Bun.nanoseconds", "Bun.spawn", "Bun.spawnSync", "Math.random", "crypto.randomUUID", "crypto.getRandomValues"].includes(name)
        || ["eval", "Function", "RegExp", "fetch", "WebSocket", "XMLHttpRequest", "EventSource", "constructor"].includes(node.name.text)
      )) add(node, `'${name}' is forbidden in the deterministic validator`);
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      const name = node.argumentExpression.text;
      if (["eval", "Function", "RegExp", "fetch", "WebSocket", "XMLHttpRequest", "EventSource", "constructor", "spawn", "spawnSync", "now", "random", "randomUUID", "getRandomValues", "hrtime", "nanoseconds"].includes(name)) {
        add(node, `computed access to '${name}' is forbidden in the deterministic validator`);
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = callName(node.expression);
      if (name === "Date" && (!node.arguments || node.arguments.length === 0)) {
        add(node, "an argument-free Date reads ambient time");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return violations;
}

interface FunctionSignature {
  name: string;
  parameters: number;
  requiredParameters: number;
}

interface ClassSignature {
  name: string;
  fingerprint: string;
  node: ts.ClassDeclaration;
  file: ts.SourceFile;
}

function signature(name: string, parameters: ts.NodeArray<ts.ParameterDeclaration>): FunctionSignature {
  return {
    name,
    parameters: parameters.length,
    requiredParameters: parameters.filter((parameter) => !parameter.questionToken && !parameter.initializer && !parameter.dotDotDotToken).length,
  };
}

function declaredFunctions(input: SourceInput, exportedOnly: boolean): Array<FunctionSignature & { node: ts.Node; file: ts.SourceFile }> {
  const file = parse(input);
  const functions: Array<FunctionSignature & { node: ts.Node; file: ts.SourceFile }> = [];
  const isExported = (node: ts.Node) => ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && (!exportedOnly || isExported(statement))) {
      functions.push({ ...signature(statement.name.text, statement.parameters), node: statement, file });
    }
    if (ts.isVariableStatement(statement) && (!exportedOnly || isExported(statement))) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
          functions.push({ ...signature(declaration.name.text, declaration.initializer.parameters), node: declaration, file });
        }
      }
    }
  }
  return functions;
}

function declaredClasses(input: SourceInput, exportedOnly: boolean): ClassSignature[] {
  const file = parse(input);
  const classes: ClassSignature[] = [];
  const isExported = (node: ts.Node) => ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  for (const statement of file.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name || (exportedOnly && !isExported(statement))) continue;
    const members = statement.members.flatMap((member) => {
      if (ts.isConstructorDeclaration(member)) return [`constructor/${signature("constructor", member.parameters).requiredParameters}/${member.parameters.length}`];
      if (ts.isMethodDeclaration(member) && member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) {
        const item = signature(member.name.text, member.parameters);
        return [`${item.name}/${item.requiredParameters}/${item.parameters}`];
      }
      return [];
    }).sort();
    classes.push({ name: statement.name.text, fingerprint: members.join(";"), node: statement, file });
  }
  return classes;
}

// A workspace package is imported by name, so its bare specifier must resolve
// to the package entry point before a required-import rule can name it.
const WORKSPACE_PACKAGE_ENTRIES: Readonly<Record<string, string>> = {
  "@ezcorp/extension-runner": "packages/@ezcorp/extension-runner/src/index.ts",
  "@ezcorp/extension-contract": "packages/@ezcorp/extension-contract/src/index.ts",
};

function normalizedImportPath(factoryPath: string, specifier: string): string {
  const workspaceEntry = WORKSPACE_PACKAGE_ENTRIES[specifier];
  if (workspaceEntry) return workspaceEntry;
  const absolute = resolve(REPO_ROOT, factoryPath, "..", specifier);
  const withExtension = absolute.endsWith(".ts") ? absolute : `${absolute}.ts`;
  return relative(REPO_ROOT, withExtension).replaceAll("\\", "/");
}

export function checkFactoryBoundaries(
  factoryFiles: readonly SourceInput[],
  sharedFiles: readonly SourceInput[],
  requiredImports: readonly RequiredImport[] = REQUIRED_SHARED_IMPORTS,
  validatorPaths: ReadonlySet<string> = VALIDATOR_PATHS,
): BoundaryViolation[] {
  const violations = factoryFiles.flatMap((file) => validatorViolations(file, validatorPaths));
  const sharedSignatures = new Map<string, FunctionSignature>();
  for (const shared of sharedFiles) {
    for (const item of declaredFunctions(shared, true)) {
      sharedSignatures.set(`${item.name}/${item.requiredParameters}/${item.parameters}`, item);
    }
  }

  const sharedClasses = new Map<string, ClassSignature>();
  for (const shared of sharedFiles) {
    for (const item of declaredClasses(shared, true)) sharedClasses.set(`${item.name}/${item.fingerprint}`, item);
  }

  for (const factory of factoryFiles) {
    for (const item of declaredFunctions(factory, false)) {
      const key = `${item.name}/${item.requiredParameters}/${item.parameters}`;
      if (sharedSignatures.has(key)) {
        violations.push({
          path: factory.path,
          line: lineOf(item.file, item.node),
          rule: "f13-duplicate",
          message: `function '${item.name}' duplicates a C13 shared-module signature (${item.requiredParameters} required, ${item.parameters} total parameters)`,
        });
      }
    }
    for (const item of declaredClasses(factory, false)) {
      if (sharedClasses.has(`${item.name}/${item.fingerprint}`)) {
        violations.push({
          path: factory.path,
          line: lineOf(item.file, item.node),
          rule: "f13-duplicate",
          message: `class '${item.name}' duplicates a C13 shared-module API signature`,
        });
      }
    }
  }

  const byPath = new Map(factoryFiles.map((file) => [file.path, file]));
  for (const requirement of requiredImports) {
    const input = byPath.get(requirement.factoryPath);
    if (!input) {
      violations.push({ path: requirement.factoryPath, line: 1, rule: "f13-required-import", message: "factory module is missing" });
      continue;
    }
    const file = parse(input);
    const imports = file.statements.flatMap((statement) => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      ? [normalizedImportPath(input.path, statement.moduleSpecifier.text)]
      : []);
    if (!imports.includes(requirement.sharedModule)) {
      violations.push({
        path: input.path,
        line: 1,
        rule: "f13-required-import",
        message: `must import the C13 shared module '${requirement.sharedModule}'`,
      });
    }
  }
  return violations;
}

/**
 * The validator closure: the roots plus every local module they reach
 * transitively. Exported so the recursion itself is testable — the whole point
 * of following imports is that a helper two hops away cannot hide code
 * generation, and only a multi-hop case proves that.
 */
export function localImportClosure(factoryFiles: readonly SourceInput[], roots: ReadonlySet<string>): Set<string> {
  const byPath = new Map(factoryFiles.map((file) => [file.path, file]));
  const closure = new Set(roots);
  const pending = [...roots];
  while (pending.length > 0) {
    const path = pending.pop()!;
    const input = byPath.get(path);
    if (!input) continue;
    for (const statement of parse(input).statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith(".")) continue;
      const imported = normalizedImportPath(path, statement.moduleSpecifier.text);
      if (byPath.has(imported) && !closure.has(imported)) {
        closure.add(imported);
        pending.push(imported);
      }
    }
  }
  return closure;
}

async function sourceInput(path: string): Promise<SourceInput> {
  return { path, source: await Bun.file(resolve(REPO_ROOT, path)).text() };
}

export async function inspectRepositoryBoundaries(): Promise<BoundaryViolation[]> {
  const roots = [
    "packages/@ezcorp/factory-sdk/src",
    "src/factory",
    "web/src/lib/factory",
    "web/src/routes/api/factories",
  ];
  if (!existsSync(resolve(REPO_ROOT, roots[0]!))) throw new Error("factory SDK source root is missing");
  const factoryPaths = roots.flatMap((root) => existsSync(resolve(REPO_ROOT, root))
    ? [...new Bun.Glob("**/*.ts").scanSync({ cwd: resolve(REPO_ROOT, root) })]
      .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".d.ts"))
      .map((path) => `${root}/${path}`)
    : []).sort();
  for (const required of VALIDATOR_PATHS) {
    if (!factoryPaths.includes(required)) throw new Error(`required validator source is missing: ${required}`);
  }
  const factoryFiles = await Promise.all(factoryPaths.map(sourceInput));
  return checkFactoryBoundaries(
    factoryFiles,
    await Promise.all(SHARED_REUSE_MODULES.map(sourceInput)),
    REQUIRED_SHARED_IMPORTS,
    localImportClosure(factoryFiles, VALIDATOR_PATHS),
  );
}

export async function runBoundaryCheck(options: {
  inspect?: () => Promise<BoundaryViolation[]>;
  log?: Pick<Console, "log" | "error">;
} = {}): Promise<number> {
  const inspect = options.inspect ?? inspectRepositoryBoundaries;
  const log = options.log ?? console;
  const violations = await inspect();
  if (violations.length > 0) {
    for (const violation of violations) log.error(`${violation.path}:${violation.line} [${violation.rule}] ${violation.message}`);
    return 1;
  }
  log.log("Factory boundary checks passed (F07 deterministic validator and F13 shared-module reuse).");
  return 0;
}

export const FACTORY_BOUNDARY_MAIN_RESULT = import.meta.main ? await runBoundaryCheck() : undefined;
if (FACTORY_BOUNDARY_MAIN_RESULT !== undefined) process.exitCode = FACTORY_BOUNDARY_MAIN_RESULT;
