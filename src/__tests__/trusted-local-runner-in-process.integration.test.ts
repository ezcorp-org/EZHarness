import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";

mockDbConnection();

import { sql } from "drizzle-orm";
import { buildLimits, executionLimits, filesDigest, trustedLocalImage, TRUSTED_LOCAL_OMITTED_CONTROLS } from "@ezcorp/extension-runner";
import { source } from "../../packages/@ezcorp/extension-runner/tests/helpers";
import { listAuditLog } from "../db/queries/audit-log";
import { recordTrustedLocalApproval } from "../db/queries/extension-trusted-local-approvals";
import { createUser } from "../db/queries/users";
import { getConfiguredExtensionRunner } from "../extensions/runner-connection";
import { trustedLocalBunDigest, UNSANDBOXED_ACK_SENTENCE } from "../extensions/runner-mode";
import { createTrustedLocalHooks } from "../extensions/trusted-local-hooks";
import { configureTrustedLocalRunner, resetTrustedLocalRunner, resolveTrustedLocalRunner } from "../extensions/trusted-local-runner";

/**
 * The join the unit tests cannot make: the REAL `TrustedLocalRunner`,
 * selected by the real two-key gate through `getConfiguredExtensionRunner()`,
 * reading the REAL approvals table through `findTrustedLocalApproval` and
 * writing the REAL audit log — building, typechecking, testing and then
 * executing an extension as a plain process on this host.
 *
 * Refusals are asserted before each grant, so this also proves the wiring
 * cannot be talked into a build or a worker without a row. The runner's own
 * package test proves `authorize()` in isolation; this proves the host feeds
 * it the right thing.
 *
 * Needs Linux, a non-root uid, and `setpriv` — the runner's own
 * preconditions, which it checks itself (`probeSecurity`). The pool runs as
 * an unprivileged account on Linux, as does CI.
 */
const ENV = ["EZCORP_EXTENSION_RUNNER", "EZCORP_EXTENSIONS_UNSANDBOXED_ACK", "EZCORP_TRUSTED_LOCAL_ROOT", "EZ_EXTENSION_RUNNER_SDK_ENTRY", "EZCORP_EXTENSION_RUNNER_SOCKET", "EZCORP_EXTENSION_RUNNER_TOKEN", "EZCORP_EXTENSION_RUNNER_TOKEN_FILE"] as const;
const previous = new Map<string, string | undefined>();
let root = "";
let installationId = "";
let approver = "";

beforeAll(async () => {
  for (const name of ENV) previous.set(name, process.env[name]);
  for (const name of ENV) delete process.env[name];
  root = await mkdtemp(join(tmpdir(), "ez-trusted-local-host-"));
  process.env.EZCORP_EXTENSION_RUNNER = "trusted-local";
  process.env.EZCORP_EXTENSIONS_UNSANDBOXED_ACK = UNSANDBOXED_ACK_SENTENCE;
  process.env.EZCORP_TRUSTED_LOCAL_ROOT = root;
  process.env.EZ_EXTENSION_RUNNER_SDK_ENTRY = join(import.meta.dirname, "..", "..", "packages", "@ezcorp", "sdk", "src", "v4", "index.ts");
  await setupTestDb();
  // The same hooks the lifecycle service installs at startup — one
  // definition of what the runner is told, exercised here against the real
  // table and the real audit log.
  configureTrustedLocalRunner(createTrustedLocalHooks());
  approver = (await createUser({ email: `approver-${randomUUID()}@example.test`, passwordHash: "x", name: "Approver", role: "admin" })).id;
  installationId = `installation-${randomUUID()}`;
  await getTestDb().execute(sql`INSERT INTO extension_release_installations (id, owner_id, scope, payload) VALUES (${installationId}, ${approver}, 'global', ${JSON.stringify({ id: installationId })})`);
});

afterAll(async () => {
  // Tolerant of an already-reset module: the last test below puts it back
  // itself, and this hook must close a runner that is still memoised without
  // demanding one that is not.
  await resolveTrustedLocalRunner().then(runner => runner.close()).catch(() => undefined);
  // The hooks installed above and the runner memoised by the first
  // resolution are MODULE state: they outlive this file in a pooled `bun
  // test` process, and the next file to walk this module expects the
  // unconfigured start a process gives it. Put it back.
  resetTrustedLocalRunner();
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
  for (const name of ENV) { const value = previous.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

describe("the real TrustedLocalRunner through the host wiring", () => {
  test("refuses, then builds, then refuses, then executes — one approval row per grant, one audit row per use", async () => {
    const runner = getConfiguredExtensionRunner();
    const files = source();
    const sourceDigest = filesDigest(files);
    const build = () => runner.build({ operationId: randomUUID(), sourceDigest, files, entrypoint: "extension.ts", limits: buildLimits });

    // ── build ──
    await expect(build()).rejects.toMatchObject({ code: "trusted_approval_required" });
    expect(await listAuditLog({ action: "extension.trusted_local.build" })).toEqual([]);
    await recordTrustedLocalApproval({ installationId, phase: "build", digest: sourceDigest, approvedBy: approver });
    const result = await build();
    expect(result.state, JSON.stringify(result.diagnostics)).toBe("succeeded");
    expect(result.diagnostics).toEqual([]);
    // Stamped so it can never pass for an isolated build, and equal to what the
    // lifecycle in this mode expects (`runnerImageDigest`).
    expect(result.imageDigest).toBe(trustedLocalImage(await trustedLocalBunDigest()));
    expect(result.imageDigest).toMatch(/^localhost\/trusted-local@sha256:[a-f0-9]{64}$/);
    const buildAudit = await listAuditLog({ action: "extension.trusted_local.build" });
    expect(buildAudit).toHaveLength(1);
    expect(buildAudit[0]).toMatchObject({ userId: approver, target: sourceDigest });
    expect(buildAudit[0]!.metadata).toMatchObject({ omittedControls: [...TRUSTED_LOCAL_OMITTED_CONTROLS] });

    // ── execute ──
    const artifactDigest = result.artifactDigest!;
    const workerId = randomUUID();
    const context = { workerId, invocationId: randomUUID(), releaseId: artifactDigest, principalId: approver, scopeId: "global", token: "token", deadline: Date.now() + 30_000 };
    const start = () => runner.start({ workerId, artifactDigest, context, limits: executionLimits }, async () => null);
    await expect(start()).rejects.toMatchObject({ code: "trusted_approval_required" });
    await recordTrustedLocalApproval({ installationId, phase: "execute", digest: artifactDigest, approvedBy: approver });
    const worker = await start();
    try {
      expect(await worker.request("extension/invoke", { name: "echo", input: { message: "trusted" }, context })).toEqual({ message: "trusted" });
    } finally {
      await worker.close();
    }
    const executeAudit = await listAuditLog({ action: "extension.trusted_local.execute" });
    expect(executeAudit).toHaveLength(1);
    expect(executeAudit[0]).toMatchObject({ userId: approver, target: artifactDigest });

    // The artifact store is where the override pointed, not the checkout.
    expect((await runner.collectArtifacts(artifactDigest))["extension.ts"]).toBe(files["extension.ts"]);
  }, 180_000);

  test("the wiring hands out ONE runner and keeps handing it out", async () => {
    const first = await resolveTrustedLocalRunner();
    expect(await resolveTrustedLocalRunner()).toBe(first);
  });
});

describe("before the lifecycle service installs the hooks", () => {
  test("resolution refuses with runner_unconfigured rather than constructing a runner that cannot authorise", async () => {
    // The suite above configured the module and built its one runner, so put
    // the module back to a process's starting state first. A `?fresh=` copy
    // would do the same for the assertion and cost the file its coverage:
    // bun keeps ONE record per source path and the copy loaded LAST owns it,
    // so every line only the canonical instance ran — the reset included —
    // would read as a miss.
    await (await resolveTrustedLocalRunner()).close().catch(() => undefined);
    resetTrustedLocalRunner();
    await expect(resolveTrustedLocalRunner()).rejects.toMatchObject({ code: "runner_unconfigured" });
  });
});
