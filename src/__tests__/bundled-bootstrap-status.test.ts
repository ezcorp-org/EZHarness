/**
 * `bundledBootstrapStatus` is what the real-server test lanes poll before any
 * spec builds, so it must count exactly the bundled installations that exist
 * and exactly the build operations that still hold or wait for the runner.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mockDbConnection, mockRealSettings, setupTestDb } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { InstallationState, LifecycleOperation } from "../extensions/v4/types";

mockDbConnection();
mockRealSettings();
const { bundledBootstrapStatus, bundledInstallationId } = await import("../extensions/bundled-bootstrap");

const at = new Date(0).toISOString();
const operation = (state: LifecycleOperation["state"], kind: LifecycleOperation["kind"] = "build"): LifecycleOperation =>
  ({ id: `${kind}-${state}`, kind, state, idempotencyKey: `${kind}-${state}`, inputDigest: "digest", diagnostics: [], events: [], createdAt: at, updatedAt: at }) as LifecycleOperation;
const installation = (id: string, uninstalled = false, ...operations: LifecycleOperation[]): InstallationState => ({
  installation: { id, ownerId: "admin", scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled, status: "disabled", acknowledgedGeneration: 0, createdAt: at, updatedAt: at } as unknown as InstallationState["installation"],
  workspaces: {}, revisions: {}, releases: {}, approvals: {},
  operations: Object.fromEntries(operations.map((entry) => [entry.id, entry])),
});

describe("bundledBootstrapStatus", () => {
  test("counts staged installations and only their unfinished build operations", async () => {
    const states = new Map<string, InstallationState>([
      [bundledInstallationId("alpha"), installation("a", false, operation("queued"), operation("verified"))],
      [bundledInstallationId("beta"), installation("b", false, operation("building"), operation("activating", "activate"))],
      [bundledInstallationId("gamma"), installation("c", false, operation("verifying"))],
      [bundledInstallationId("delta"), installation("d", false, operation("failed"), operation("cancelled"))],
    ]);
    const reader = { async read(id: string) { return states.get(id) ?? null; } };
    const legacyIdFor = async () => undefined;
    const status = await bundledBootstrapStatus(["alpha", "beta", "gamma", "delta", "never-staged"].map((name) => ({ name })), reader, legacyIdFor);
    expect(status).toEqual({ staged: 4, pending: 3 });
  });

  test("an uninstalled record is not staged, and a legacy id wins over the derived id", async () => {
    const legacyId = "legacy-row-id";
    const states = new Map<string, InstallationState>([
      [legacyId, installation(legacyId, false, operation("queued"))],
      [bundledInstallationId("gone"), installation("gone", true, operation("queued"))],
    ]);
    const asked: string[] = [];
    const reader = { async read(id: string) { asked.push(id); return states.get(id) ?? null; } };
    const legacyIdFor = async (name: string) => (name === "kept" ? legacyId : undefined);
    const status = await bundledBootstrapStatus([{ name: "kept" }, { name: "gone" }], reader, legacyIdFor);
    expect(status).toEqual({ staged: 1, pending: 1 });
    expect(asked).toEqual([legacyId, bundledInstallationId("gone")]);
  });

  describe("against the database", () => {
    beforeAll(async () => { await setupTestDb(); });
    afterAll(restoreModuleMocks);

    test("an empty database has nothing staged and nothing pending", async () => {
      expect(await bundledBootstrapStatus([{ name: "never-staged" }])).toEqual({ staged: 0, pending: 0 });
    });
  });
});
