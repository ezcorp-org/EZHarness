/**
 * C02's process boundaries, as an executable gate rather than a review note.
 *
 * The requirement index records C02.1 as implemented with the note "No boundary
 * test enforces the confinement". These are that test. Four claims, each
 * derived from the source rather than from a list someone maintains:
 *
 *   1. Only the Node orchestration process links `@temporalio/*`.
 *   2. That process holds no product database, object-store, or provider
 *      credential.
 *   3. The host supervisor holds only host identity, and never the host key.
 *   4. A runner's authority is attempt-scoped and cannot be substituted.
 *
 * The walk distinguishes a VALUE import from a TYPE import, because that is the
 * distinction the boundary is actually about: `import type { X }` is erased and
 * links nothing at runtime, so a module that names another module's type has
 * not taken on its dependencies. A regex over `from "..."` cannot tell the two
 * apart and would report the supervisor as holding a database handle it never
 * touches.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { signFactoryAttemptToken, verifyFactoryAttemptToken } from "../factory/attempt-token";
import type { FactoryAttemptAuthority } from "../factory/executions";
import type { FactoryRunnerSupervisorOptions } from "../factory/runner/supervisor";

const REPO_ROOT = resolve(import.meta.dir, "../..");

interface ModuleImports {
  readonly local: readonly string[];
  readonly bare: readonly string[];
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
}

/** True when the whole declaration is erased at compile time. */
function typeOnly(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  // `import { type A, type B } from "x"` also erases entirely.
  const named = clause.namedBindings;
  if (clause.name === undefined && named !== undefined && ts.isNamedImports(named)) {
    return named.elements.length > 0 && named.elements.every((element) => element.isTypeOnly);
  }
  return false;
}

function resolveLocal(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier.replace(/\.js$/, ""));
  for (const candidate of [base.endsWith(".ts") ? base : `${base}.ts`, `${base}/index.ts`, base]) {
    if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Every runtime import of one module: local files and bare package specifiers. */
function runtimeImports(file: string): ModuleImports {
  const source = parse(file);
  const local: string[] = [];
  const bare: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !typeOnly(node)) {
      const specifier = node.moduleSpecifier.text;
      const resolved = resolveLocal(file, specifier);
      if (resolved) local.push(resolved);
      else bare.push(specifier);
    }
    // A dynamic import is always a runtime link.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0]!)) {
      const specifier = node.arguments[0]!.text;
      const resolved = resolveLocal(file, specifier);
      if (resolved) local.push(resolved);
      else bare.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { local, bare };
}

interface Closure {
  readonly files: readonly string[];
  /** Bare specifier to the repo-relative files that import it. */
  readonly bare: ReadonlyMap<string, readonly string[]>;
}

function runtimeClosure(roots: readonly string[]): Closure {
  const seen = new Set<string>();
  const bare = new Map<string, string[]>();
  const pending = roots.map((root) => resolve(REPO_ROOT, root));
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const imports = runtimeImports(file);
    for (const specifier of imports.bare) {
      const importers = bare.get(specifier) ?? [];
      importers.push(relative(REPO_ROOT, file));
      bare.set(specifier, importers);
    }
    pending.push(...imports.local);
  }
  return { files: [...seen].map((file) => relative(REPO_ROOT, file)).sort(), bare };
}

function sourceFiles(root: string): string[] {
  const absolute = resolve(REPO_ROOT, root);
  if (!existsSync(absolute)) return [];
  return [...new Bun.Glob("**/*.ts").scanSync({ cwd: absolute })]
    .filter((path) => !path.endsWith(".d.ts"))
    .map((path) => `${root}/${path}`)
    .sort();
}

/** The one process C02 allows to link Temporal. */
const NODE_ORCHESTRATION_ROOTS = [
  "src/factory/orchestration-process.ts",
  "packages/@ezcorp/factory-orchestrator/src/process.ts",
];

const PRODUCT_SOURCE_ROOTS = ["src", "web/src", "packages", "scripts", "worker/src"];

describe("C02.1 only the Node orchestration process links Temporal", () => {
  test("no source outside the orchestrator package imports @temporalio/*", () => {
    const offenders: string[] = [];
    for (const root of PRODUCT_SOURCE_ROOTS) {
      for (const file of sourceFiles(root)) {
        if (file.startsWith("packages/@ezcorp/factory-orchestrator/")) continue;
        const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
        const visit = (node: ts.Node): void => {
          const specifier = ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : undefined;
          if (specifier?.startsWith("@temporalio/")) offenders.push(`${file} -> ${specifier}`);
          ts.forEachChild(node, visit);
        };
        visit(ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("only the orchestrator package declares a Temporal dependency", () => {
    const manifests = ["package.json", "web/package.json", "worker/package.json",
      ...[...new Bun.Glob("@ezcorp/*/package.json").scanSync({ cwd: resolve(REPO_ROOT, "packages") })].map((path) => `packages/${path}`)];
    const declaring: string[] = [];
    for (const manifest of manifests) {
      const absolute = resolve(REPO_ROOT, manifest);
      if (!existsSync(absolute)) continue;
      const parsed = JSON.parse(readFileSync(absolute, "utf8")) as Record<string, Record<string, string> | undefined>;
      const named = [...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})]
        .filter((name) => name.startsWith("@temporalio/"));
      if (named.length > 0) declaring.push(manifest);
    }
    expect(declaring).toEqual(["packages/@ezcorp/factory-orchestrator/package.json"]);
  });

  test("the orchestration process really does link Temporal, so the rule is not vacuous", () => {
    const closure = runtimeClosure(NODE_ORCHESTRATION_ROOTS);
    const temporal = [...closure.bare.keys()].filter((specifier) => specifier.startsWith("@temporalio/")).sort();
    expect(temporal).toEqual(["@temporalio/activity", "@temporalio/client", "@temporalio/common", "@temporalio/worker"]);
  });
});

/**
 * A package whose presence in a runtime closure means that closure can hold a
 * product credential.
 *
 * This is the load-bearing half of the rule and it is EXHAUSTIVE over the
 * closure rather than a list of paths: a credential-bearing module cannot be
 * reached without also reaching the client it holds the credential for, so a
 * new one under an unlisted path is caught by the package it must import. The
 * file list below is a redundant second reading, kept because it names the
 * offender directly when it does fire.
 */
const CREDENTIAL_PACKAGES = [
  "@aws-sdk/",        // object storage
  "drizzle-orm",      // the product database
  "@electric-sql/",   // embedded PGlite
  "postgres",
  "pg",
  "bun",              // Bun.sql, Bun.file — the Node process uses none of it
] as const;

function credentialPackages(closure: Closure): string[] {
  return [...closure.bare.keys()]
    .filter((specifier) => CREDENTIAL_PACKAGES.some((name) => specifier === name || specifier.startsWith(name)))
    .sort();
}

describe("C02.1 the Node orchestration process holds no product credential", () => {
  test("its runtime closure reaches no client that could hold one", () => {
    expect(credentialPackages(runtimeClosure(NODE_ORCHESTRATION_ROOTS))).toEqual([]);
  });

  test("the classifier is not vacuous: a module that DOES hold credentials is caught", () => {
    // Without this, a classifier that matched nothing would pass the rule above
    // forever. The product database connection is the clearest positive case.
    expect(credentialPackages(runtimeClosure(["src/db/connection.ts"])).length).toBeGreaterThan(0);
    expect(credentialPackages(runtimeClosure(["src/extensions/v4/blobs.ts"])).some((name) => name.startsWith("@aws-sdk/"))).toBe(true);
  });

  test("no credential-bearing product module is in the closure either", () => {
    const closure = runtimeClosure(NODE_ORCHESTRATION_ROOTS);
    const forbiddenFiles = closure.files.filter((file) =>
      file.startsWith("src/db/")
      || file.startsWith("src/providers/")
      || file.startsWith("src/memory/")
      || file === "src/extensions/v4/blobs.ts"
      || file === "src/extensions/credential-broker.ts"
      || file === "src/extensions/secrets-store.ts"
      || file === "src/extensions/host-api-broker.ts");
    expect(forbiddenFiles).toEqual([]);
  });

  test("it still holds the tenant payload codec, which is the one key it must have", () => {
    // C02 puts payload encryption in the Node process, so this is not an
    // omission. Asserting it keeps the rule above honest: the process is
    // credential-free with respect to the PRODUCT stores, not key-free.
    const closure = runtimeClosure(NODE_ORCHESTRATION_ROOTS);
    expect(closure.files).toContain("src/factory/file-key-wraps.ts");
    expect(closure.files).toContain("src/factory/encryption.ts");
  });
});

describe("C05 the host supervisor holds only host identity", () => {
  test("its own module links no tenant store, credential broker, or database", () => {
    const closure = runtimeClosure(["src/factory/runner/supervisor.ts"]);
    const tenantLinks = closure.files.filter((file) =>
      file.startsWith("src/db/")
      || file.startsWith("src/providers/")
      || file === "src/extensions/v4/blobs.ts"
      || file === "src/extensions/credential-broker.ts"
      || file === "src/extensions/secrets-store.ts");
    expect(tenantLinks).toEqual([]);
  });

  test("its options declare no tenant identity and no host private key", () => {
    // A compile-time claim: adding a tenant or key field to the options makes
    // this assignment fail to typecheck, which is a stronger gate than a string
    // scan of the file.
    const keys: ReadonlyArray<keyof FactoryRunnerSupervisorOptions> = ["runner", "journal", "authorizeAttempt", "invokeTool", "now"];
    expect([...keys].sort()).toEqual(["authorizeAttempt", "invokeTool", "journal", "now", "runner"]);
    const declared = parse(resolve(REPO_ROOT, "src/factory/runner/supervisor.ts"));
    const optionMembers: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === "FactoryRunnerSupervisorOptions") {
        for (const member of node.members) {
          if (member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) optionMembers.push(member.name.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(declared);
    // An EXACT set, not a denylist, so a new option cannot arrive unreviewed.
    // `now` arrived with W03's journal-fact sharing (`f1e396948`) and is a
    // clock — "injected so a tool operation records real elapsed compute rather
    // than a constant" — which is neither tenant identity nor a host key, so
    // the boundary is intact and the set grows by exactly one reviewed name.
    expect(optionMembers.sort()).toEqual(["authorizeAttempt", "invokeTool", "journal", "now", "runner"]);
  });

  test("the supervisor PROCESS holds host identity and no tenant credential", () => {
    // The process entry that publishes host-supervisor readiness must be as
    // credential-free as the orchestrator, for the opposite reason: C01 says it
    // holds host identity and no tenant state at all.
    const closure = runtimeClosure(["src/factory/runner/supervisor-process.ts"]);
    expect(credentialPackages(closure)).toEqual([]);
    expect(closure.files.filter((file) => file.startsWith("src/db/") || file.startsWith("src/providers/"))).toEqual([]);
  });

  test("the physical-stop signer is injected, so product code never receives the host private key", () => {
    const runtime = readFileSync(resolve(REPO_ROOT, "src/factory/runner/attempt-runtime.ts"), "utf8");
    expect(runtime).toContain("readonly signStopReceipt:");
    // A private key read inside the runtime would defeat the injection.
    expect(runtime).not.toContain("createPrivateKey(");
  });
});

describe("C02.7 a runner holds attempt-scoped authority only", () => {
  const secret = "w09-boundary-secret-value-not-a-credential";
  const installationId = "installation-w09";
  const authority: FactoryAttemptAuthority = {
    attemptId: "attempt-1", tenantId: "tenant-1", projectId: "project-1", runId: "run-1", nodeInstanceId: "node-1",
    candidateGeneration: 1, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0,
    requestDigest: "a".repeat(64), deadlineAt: new Date(1_800_000_000_000),
  };

  test("a minted token verifies back to exactly the attempt it was minted for", async () => {
    const token = await signFactoryAttemptToken(authority, secret, installationId);
    const verified = await verifyFactoryAttemptToken(token, secret, installationId);
    expect(verified).toMatchObject({
      attemptId: "attempt-1", tenantId: "tenant-1", projectId: "project-1", runId: "run-1", nodeInstanceId: "node-1",
      candidateGeneration: 1, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0,
      requestDigest: "a".repeat(64),
    });
  });

  test("a token from another installation or another secret is not attempt authority", async () => {
    const token = await signFactoryAttemptToken(authority, secret, installationId);
    expect(await verifyFactoryAttemptToken(token, secret, "installation-other")).toBeNull();
    expect(await verifyFactoryAttemptToken(token, `${secret}-other`, installationId)).toBeNull();
  });

  test("a session credential cannot become attempt authority", async () => {
    const { signInstallationToken } = await import("../auth/jwt");
    const now = Math.floor(Date.now() / 1_000);
    const session = await signInstallationToken(
      { ...authority, deadlineAt: authority.deadlineAt.getTime(), tokenUse: "session", iat: now, exp: now + 60 },
      secret,
      installationId,
    );
    expect(await verifyFactoryAttemptToken(session, secret, installationId)).toBeNull();
  });
});
