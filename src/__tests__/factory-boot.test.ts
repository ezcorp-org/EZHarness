import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signJWT } from "../auth/jwt";
import { initDb } from "../db/connection";
import { resolveShellSandbox } from "../runtime/tools/shell";
import {
  FACTORY_ORPHAN_DETECTION_BOUND_MS,
  FACTORY_REQUIRED_SERVICES,
  FactoryBootError,
  assertFactoryBootReadiness,
  assertFactoryOrphanDetectionBound,
  captureFactoryBootConfig,
  factoryBootConfig,
} from "../factory/boot";
import type { FactoryBootConfig } from "../factory/boot";
import { getReadiness, resetReadiness } from "../readiness";

afterEach(() => resetReadiness());

async function runFactoryChild(source: string, env: Record<string, string | undefined> = {}) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", source],
    cwd: process.cwd(),
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function readyFactoryConfig(overrides: Partial<FactoryBootConfig> = {}): FactoryBootConfig {
  return {
    enabled: true,
    requireSandbox: true,
    installationId: "factory-installation",
    projectRoot: process.cwd(),
    secretsDir: tmpdir(),
    grantableRoots: [process.cwd()],
    ...overrides,
  };
}

describe("factory boot flag and readiness", () => {
  test("enables only the exact value 1", () => {
    expect(captureFactoryBootConfig({}).enabled).toBe(false);
    expect(captureFactoryBootConfig({ EZCORP_FACTORY_ENABLED: "0" }).enabled).toBe(false);
    expect(captureFactoryBootConfig({ EZCORP_FACTORY_ENABLED: "true" }).enabled).toBe(false);
    expect(captureFactoryBootConfig({ EZCORP_FACTORY_ENABLED: " 1" }).enabled).toBe(false);
    expect(captureFactoryBootConfig({ EZCORP_FACTORY_ENABLED: "1" }).enabled).toBe(true);
  });

  test("captures the flag at module boot instead of rereading a mutable environment", () => {
    const captured = factoryBootConfig.enabled;
    const previous = process.env.EZCORP_FACTORY_ENABLED;
    process.env.EZCORP_FACTORY_ENABLED = captured ? "0" : "1";
    try {
      expect(factoryBootConfig.enabled).toBe(captured);
    } finally {
      if (previous === undefined) delete process.env.EZCORP_FACTORY_ENABLED;
      else process.env.EZCORP_FACTORY_ENABLED = previous;
    }
  });

  test("freezes the boot-captured factory policy and grant roots", () => {
    const config = captureFactoryBootConfig({ EZCORP_FACTORY_ENABLED: "1" });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.grantableRoots)).toBe(true);
  });

  test("feature-off boot does not require factory dependencies", () => {
    expect(() => assertFactoryBootReadiness(undefined, [], {
      enabled: false,
      projectRoot: "/project",
    })).not.toThrow();
  });

  test("flag-on embedded PGlite fails with a named readiness error before services", () => {
    let error: unknown;
    try {
      assertFactoryBootReadiness(undefined, [], { enabled: true, projectRoot: "/project" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FactoryBootError);
    expect((error as FactoryBootError).code).toBe("factory-pglite-unsupported");
    expect(getReadiness()).toMatchObject({ state: "degraded", reason: "factory-pglite-unsupported" });
  });

  test("flag-on external PostgreSQL requires an isolated secrets directory", () => {
    expect(() => assertFactoryBootReadiness("postgres://db", [], readyFactoryConfig({ secretsDir: undefined }))).toThrow(/EZCORP_SECRETS_DIR/);
    expect(getReadiness().reason).toBe("factory-secrets-dir-required");
  });

  test("a secrets directory inside the grantable root is refused", () => {
    expect(() => assertFactoryBootReadiness("postgres://db", [], readyFactoryConfig({ secretsDir: process.cwd() }))).toThrow(/outside the grantable project root/);
  });

  test("an unresolvable secrets directory and the filesystem root both fail closed", () => {
    expect(() => assertFactoryBootReadiness("postgres://db", [], readyFactoryConfig({
      secretsDir: join(tmpdir(), "missing-factory-secrets-dir"),
    }))).toThrow(/EZCORP_SECRETS_DIR/);
    expect(() => assertFactoryBootReadiness("postgres://db", [], readyFactoryConfig({
      projectRoot: "/",
      grantableRoots: ["/"],
      secretsDir: tmpdir(),
    }))).toThrow(/outside the grantable project root/);
  });

  test("a secrets symlink into a grantable root is refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-secrets-root-"));
    const project = join(root, "project");
    const link = join(root, "external-secrets");
    const lexicalInside = join(project, "..secrets");
    await mkdir(project);
    await mkdir(lexicalInside);
    await symlink(project, link);
    try {
      expect(() => assertFactoryBootReadiness("postgres://db", [], readyFactoryConfig({
        projectRoot: project,
        grantableRoots: [project],
        secretsDir: lexicalInside,
      }))).toThrow(/outside the grantable project root/);
      expect(() => assertFactoryBootReadiness("postgres://db", [], readyFactoryConfig({
        projectRoot: project,
        grantableRoots: [project],
        secretsDir: link,
      }))).toThrow(/outside the grantable project root/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a secrets directory under any grantable root is refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-grant-root-"));
    const project = join(root, "project");
    const extensionRoot = join(root, "extension-root");
    const secrets = join(extensionRoot, "secrets");
    await mkdir(project);
    await mkdir(secrets, { recursive: true });
    try {
      expect(() => assertFactoryBootReadiness("postgres://db", [], readyFactoryConfig({
        projectRoot: project,
        grantableRoots: [project, extensionRoot],
        secretsDir: secrets,
      }))).toThrow(/outside the grantable project root/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("external PostgreSQL requires its provisioned installation ID", () => {
    expect(() => assertFactoryBootReadiness("postgres://db", [], readyFactoryConfig({ installationId: undefined })))
      .toThrow(/EZCORP_INSTALLATION_ID/);
    expect(getReadiness().reason).toBe("factory-installation-id-required");
  });

  test("factory boot refuses every unavailable service", () => {
    expect(() => assertFactoryBootReadiness("postgres://db", [], readyFactoryConfig())).toThrow(FACTORY_REQUIRED_SERVICES.join(", "));
    expect(getReadiness()).toMatchObject({ state: "degraded", reason: "factory-services-unavailable" });
  });

  test("factory boot accepts external PostgreSQL only after every required service is ready", () => {
    expect(() => assertFactoryBootReadiness("postgres://db", FACTORY_REQUIRED_SERVICES, readyFactoryConfig())).not.toThrow();
  });

  test("a flag-on PGlite process refuses before opening its database", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-pglite-"));
    const dbPath = join(root, "db");
    try {
      const child = await runFactoryChild(
        "const { initDb } = await import('./src/db/connection.ts'); await initDb();",
        {
          EZCORP_FACTORY_ENABLED: "1",
          DATABASE_URL: undefined,
          EZCORP_DB_PATH: dbPath,
        },
      );
      expect(child.exitCode).not.toBe(0);
      expect(`${child.stdout}\n${child.stderr}`).toContain("factory-pglite-unsupported");
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a factory shell call fails before its command can spawn without a jail", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-shell-"));
    const marker = join(root, "spawned");
    try {
      const child = await runFactoryChild(
        `const { createShellTool } = await import('./src/runtime/tools/shell.ts');
         const result = await createShellTool(${JSON.stringify(root)}).execute('call', { command: ${JSON.stringify(`touch ${marker}`)} });
         if (result.details.exitCode !== -1 || await Bun.file(${JSON.stringify(marker)}).exists()) process.exit(1);`,
        { EZCORP_FACTORY_ENABLED: "1" },
      );
      expect(child.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a factory MCP request fails before the degraded no-context spawn path", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-mcp-"));
    const marker = join(root, "spawned");
    try {
      const child = await runFactoryChild(
        `const { buildSandboxedMcpSpec } = await import('./src/extensions/mcp-sandbox.ts');
         try {
           const result = await buildSandboxedMcpSpec({ transport: 'stdio', name: 'probe', command: 'touch', args: [${JSON.stringify(marker)}] }, { schemaVersion: 2, name: 'probe', version: '1.0.0', description: '', author: { name: 'test' }, permissions: {} }, { grantedAt: {} }, 'probe');
           const process = Bun.spawn([result.spec.command, ...(result.spec.args ?? [])], { env: result.spec.env });
           await process.exited;
           process.exit(1);
         } catch (error) {
           if (!(error instanceof Error) || !error.message.includes('EZCORP_MCP_REQUIRE_SANDBOX=1')) process.exit(1);
         }`,
        { EZCORP_FACTORY_ENABLED: "1" },
      );
      expect(child.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("factory JWT issuance cannot fall back to a secret-derived installation ID", async () => {
    const child = await runFactoryChild(
      `const { signJWT } = await import('./src/auth/jwt.ts');
       try { await signJWT({ id: 'u', email: 'u@example.test', name: 'u', role: 'member' }, 'secret'); process.exit(1); }
       catch (error) { if (!(error instanceof Error) || !error.message.includes('EZCORP_INSTALLATION_ID')) process.exit(1); }`,
      { EZCORP_FACTORY_ENABLED: "1", EZCORP_INSTALLATION_ID: undefined },
    );
    expect(child.exitCode).toBe(0);
  });

  test("the captured process factory policy controls direct JWT and database seams", async () => {
    const user = { id: "user", email: "user@example.test", name: "user", role: "member" as const };
    if (factoryBootConfig.enabled) {
      await expect(signJWT(user, "factory-boundary-secret")).rejects.toThrow("EZCORP_INSTALLATION_ID");
      await expect(initDb()).rejects.toThrow("external PostgreSQL");
      return;
    }
    expect(await signJWT(user, "self-hosted-boundary-secret")).toBeString();
  });

  test("the captured process sandbox policy controls shell fallback seams", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-shell-policy-"));
    const workspace = join(root, ".ezcorp", "data", "workspace");
    try {
      if (factoryBootConfig.requireSandbox) {
        expect(() => resolveShellSandbox("true", undefined)).toThrow("Required shell sandbox wiring");
        expect(() => resolveShellSandbox("true", { workspaceDir: workspace, projectRoot: root }))
          .toThrow("Required shell sandbox isolation");
        return;
      }
      expect(resolveShellSandbox("true", undefined)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});


/**
 * C11's detection bound, as a startup setting.
 *
 * C10 requires an orphaned legacy run to reach a terminal or resumable state
 * within thirty seconds, and the sweep that would notice is a sub-tick of a
 * daemon whose default wake is an hour. The bound is therefore declared and
 * checked, and the check compares the declaration against what the daemon will
 * really use — a document that says thirty seconds over an hourly daemon is the
 * silent pass this exists to prevent.
 */
describe("assertFactoryOrphanDetectionBound", () => {
  const enabled: FactoryBootConfig = { enabled: true, projectRoot: "/project" };

  test("accepts a declaration at or under the bound that the daemon really uses", () => {
    expect(() => assertFactoryOrphanDetectionBound(30_000, 30_000, enabled)).not.toThrow();
    expect(() => assertFactoryOrphanDetectionBound(5_000, 5_000, enabled)).not.toThrow();
    expect(FACTORY_ORPHAN_DETECTION_BOUND_MS).toBe(30_000);
  });

  test("refuses a sweep slower than the bound, and names both numbers", () => {
    let raised: FactoryBootError | undefined;
    try {
      // The daemon's own default: one hour, which misses the bound by two
      // orders of magnitude.
      assertFactoryOrphanDetectionBound(3_600_000, 3_600_000, enabled);
    } catch (error) {
      raised = error as FactoryBootError;
    }
    expect(raised?.code).toBe("factory-orphan-sweep-too-slow");
    expect(getReadiness()).toMatchObject({ state: "degraded", reason: "factory-orphan-sweep-too-slow", detail: { declaredMs: 3_600_000, boundMs: 30_000 } });
  });

  test("refuses a declaration the daemon will not honour", () => {
    let raised: FactoryBootError | undefined;
    try {
      assertFactoryOrphanDetectionBound(30_000, 3_600_000, enabled);
    } catch (error) {
      raised = error as FactoryBootError;
    }
    expect(raised?.code).toBe("factory-orphan-sweep-mismatch");
    expect(getReadiness()).toMatchObject({ state: "degraded", reason: "factory-orphan-sweep-mismatch", detail: { declaredMs: 30_000, effectiveMs: 3_600_000 } });
  });

  test("refuses a declaration that is not an interval at all", () => {
    for (const declared of [0, -1, 1.5, Number.NaN]) {
      expect(() => assertFactoryOrphanDetectionBound(declared, declared, enabled)).toThrow();
    }
  });

  test("an installation with factories off is not held to a factory bound", () => {
    expect(() => assertFactoryOrphanDetectionBound(3_600_000, 3_600_000, { enabled: false, projectRoot: "/project" })).not.toThrow();
    expect(getReadiness().state).not.toBe("degraded");
  });
});
