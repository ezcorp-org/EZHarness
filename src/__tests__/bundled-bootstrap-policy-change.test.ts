import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";

/**
 * Stages a bundled source through the REAL lifecycle, across a change to the
 * build policy, and asserts the second boot builds instead of failing.
 *
 * ## The bug this exists to prevent
 *
 * The bootstrap keyed each build on the source digest alone. The lifecycle
 * compares a reused key against the operation's full input, which carries the
 * build policy — runner profile, runner image, validator, limits. So when the
 * policy moved and the source did not, every bundled extension hit
 * `idempotency_conflict` ("This key already identifies a different
 * operation.") on every boot, and none could be rebuilt for the new runner.
 * #290 moved the runner image pin and did exactly that on a live host: 27
 * bundled extensions, 27 staging errors, every restart.
 *
 * ## Why the lifecycle is real here
 *
 * The neighbouring bootstrap tests replace `lifecycle.build` with a mock that
 * never checks idempotency, so they could not see the conflict. Only the real
 * `ExtensionLifecycle` over the real repository enforces "one key, one
 * outcome", which is the rule the bootstrap broke.
 */

mockDbConnection();

let runnerImageDigest = "runner-image-a";
const files = { "extension.ts": "export default {};" };

mock.module("../../scripts/migrate-extension-v4", () => ({
  snapshotFirstPartyExtension: async () => ({ source: { directory: "extensions/candidate", entrypoint: "extension.ts" }, files }),
}));
mock.module("../extensions/project-root", () => ({ getProjectRoot: () => "/reviewed" }));
mock.module("../extensions/extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => realLifecycle() }));

const { ExtensionLifecycle } = await import("../extensions/v4/lifecycle");
const { DatabaseLifecycleRepository } = await import("../db/queries/extension-releases");
const { createUser } = await import("../db/queries/users");
const { stageBundledExtensionSources, bundledInstallationId } = await import("../extensions/bundled-bootstrap");

const blobs = new Map<string, Uint8Array>();
const unavailable = async () => { throw new Error("not reached by source staging"); };
// Staging queues each build and the bootstrap hands it to the runner in the
// background. Park it there: this test is about which builds get STAGED, and a
// runner that settled would add a failed-build transition it does not assert.
const parked = () => new Promise<never>(() => {});

function realLifecycle() {
  return new ExtensionLifecycle({
    repository: new DatabaseLifecycleRepository(getTestDb()),
    blobs: {
      async put(bytes) {
        const digest = createHash("sha256").update(bytes).digest("hex");
        blobs.set(digest, bytes);
        return digest;
      },
      async get(digest) {
        const bytes = blobs.get(digest);
        if (!bytes) throw new Error("missing blob");
        return bytes;
      },
    },
    runnerProfile: "test",
    runnerImageDigest,
    validatorVersion: "test",
    buildLimits: { memoryBytes: 1024, cpuMillis: 1000, pids: 16, tmpBytes: 1024, outputBytes: 1024, timeoutMs: 1000 },
    runner: { build: parked, cancel: unavailable, collectArtifacts: unavailable },
    authorize: async () => {},
    verifyCandidate: unavailable,
    publish: unavailable,
  });
}

const entries = [{ name: "candidate", path: "extensions/candidate" }];

async function buildOperations() {
  const state = await new DatabaseLifecycleRepository(getTestDb()).read(bundledInstallationId("candidate"));
  return Object.values(state?.operations ?? {}).filter((operation) => operation.kind === "build");
}

beforeEach(async () => {
  await setupTestDb();
  blobs.clear();
  runnerImageDigest = "runner-image-a";
  await createUser({ email: "bundled-policy-admin@test.com", passwordHash: "h", name: "Admin", role: "admin" });
});
afterAll(closeTestDb);

test("a build-policy change stages a fresh build instead of an idempotency conflict", async () => {
  await stageBundledExtensionSources(entries);
  const [first] = await buildOperations();
  expect(first).toBeDefined();

  runnerImageDigest = "runner-image-b";
  await stageBundledExtensionSources(entries);

  const operations = await buildOperations();
  expect(operations).toHaveLength(2);
  expect(new Set(operations.map((operation) => operation.idempotencyKey)).size).toBe(2);
  expect(new Set(operations.map((operation) => operation.inputDigest)).size).toBe(2);
});

test("an unchanged policy reuses the same build across boots", async () => {
  await stageBundledExtensionSources(entries);
  await stageBundledExtensionSources(entries);
  runnerImageDigest = "runner-image-b";
  await stageBundledExtensionSources(entries);
  await stageBundledExtensionSources(entries);

  // One build per (source, policy) pair — never one per boot.
  expect(await buildOperations()).toHaveLength(2);
});
