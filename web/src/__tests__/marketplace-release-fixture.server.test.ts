import { beforeEach, afterEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), collectArtifacts: vi.fn(), sealPublishedRelease: vi.fn(), createListing: vi.fn(), createVersion: vi.fn() }));
vi.mock("$server/extensions/extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => mocks, getExtensionRunner: async () => mocks }));
vi.mock("$server/db/queries/marketplace", () => mocks);
vi.mock("$server/db/queries/marketplace-versions", () => mocks);
vi.mock("@ezcorp/extension-contract", async (importOriginal) => ({ ...await importOriginal<typeof import("@ezcorp/extension-contract")>(), sealPublishedRelease: mocks.sealPublishedRelease }));
vi.mock("$lib/server/extensions/control-actor", () => ({ resolveControlActor: async (user: { id: string }, kind: string) => ({ principalId: user.id, scope: "global", kind }) }));
vi.mock("$server/auth/middleware", () => ({ requireSessionAuth: (locals: { user?: unknown; authMethod?: string }) => locals.user && locals.authMethod === "session" ? locals.user : new Response(null, { status: 403 }) }));
import { POST } from "../routes/api/__test/marketplace-release/+server";
function event(body: unknown = { installationId: "installation", releaseId: "release" }, authMethod = "session") { return { locals: { user: { id: "owner", role: "member" }, authMethod }, request: new Request("http://localhost/api/__test/marketplace-release", { method: "POST", body: JSON.stringify(body) }) } as unknown as Parameters<typeof POST>[0]; }
function state() { return { installation: { id: "installation", ownerId: "owner", uninstalled: false }, releases: { release: { id: "release", artifactDigest: "artifact", sourceDigest: "source", imageDigest: "image", manifest: { name: "verified-source", version: "1.0.0", description: "Source" }, evidence: { tests: [] } } }, operations: { build: { id: "build", releaseId: "release", state: "verified" } } }; }
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("PI_E2E_REAL", "1"); vi.stubEnv("EZCORP_ALLOW_TEST_SURFACE", "1"); mocks.inspect.mockResolvedValue(state()); mocks.collectArtifacts.mockResolvedValue({ "extension.ts": "sealed source" }); mocks.sealPublishedRelease.mockResolvedValue({ releaseDigest: "sealed" }); mocks.createListing.mockResolvedValue({ id: "listing" }); mocks.createVersion.mockResolvedValue({ id: "version" }); });
afterEach(() => { vi.unstubAllEnvs(); });
test("fixture is absent in production and without either explicit test opt-in", async () => {
  for (const [key, value] of [["NODE_ENV", "production"], ["PI_E2E_REAL", "0"], ["EZCORP_ALLOW_TEST_SURFACE", "0"]]) {
    const previous = process.env[key!]; vi.stubEnv(key!, value);
    expect((await POST(event())).status).toBe(404);
    vi.stubEnv(key!, previous);
  }
  expect(mocks.inspect).not.toHaveBeenCalled();
});
test("fixture rejects non-human requests and all supplied artifacts or authority", async () => {
  expect((await POST(event(undefined, "api-key"))).status).toBe(403);
  for (const body of [null, [], {}, { installationId: "../other", releaseId: "release" }, { installationId: "installation", releaseId: "release", manifest: {} }, { installationId: "installation", releaseId: "release", artifacts: {} }]) expect((await POST(event(body))).status).toBe(400);
  expect(mocks.inspect).not.toHaveBeenCalled();
});
test("foreign, uninstalled, missing and unverified releases cannot seed marketplace data", async () => {
  const foreign = state(); foreign.installation.ownerId = "stranger";
  const removed = state(); removed.installation.uninstalled = true;
  const unverified = state(); unverified.operations.build.state = "failed";
  for (const invalid of [foreign, removed, unverified, { ...state(), releases: {} }]) { mocks.inspect.mockResolvedValue(invalid); expect((await POST(event())).status).toBe(404); }
  expect(mocks.collectArtifacts).not.toHaveBeenCalled();
  expect(mocks.createListing).not.toHaveBeenCalled();
});
test("fixture seals only the stored verified release and rechecks ownership before persisting", async () => {
  const response = await POST(event());
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ versionId: "version" });
  expect(mocks.collectArtifacts).toHaveBeenCalledWith("artifact");
  expect(mocks.sealPublishedRelease).toHaveBeenCalledWith(expect.objectContaining({ operationId: "build", state: "succeeded", artifactDigest: "artifact", manifest: state().releases.release.manifest }), { "extension.ts": "sealed source" });
  expect(mocks.inspect).toHaveBeenCalledTimes(2);
  expect(mocks.createVersion).toHaveBeenCalledWith("listing", "1.0.0", state().releases.release.manifest, undefined, { releaseDigest: "sealed" });
});
test("ownership loss or failed artifact verification cannot create a listing", async () => {
  const foreign = state(); foreign.installation.ownerId = "stranger";
  mocks.inspect.mockResolvedValueOnce(state()).mockResolvedValueOnce(foreign);
  expect((await POST(event())).status).toBe(404);
  expect(mocks.createListing).not.toHaveBeenCalled();
  mocks.inspect.mockResolvedValue(state()); mocks.sealPublishedRelease.mockRejectedValue(new Error("Invalid artifacts"));
  expect((await POST(event())).status).toBe(500);
  expect(mocks.createVersion).not.toHaveBeenCalled();
});
