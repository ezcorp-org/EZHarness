import { beforeEach, expect, test, vi } from "vitest";
import { canonicalJson, sealPublishedRelease, sha256, validateManifest } from "@ezcorp/extension-contract";
const mocks = vi.hoisted(() => ({ listing: vi.fn(), latest: vi.fn(), stored: vi.fn() }));
vi.mock("$server/db/queries/marketplace", () => ({ getListingById: mocks.listing }));
vi.mock("$server/db/queries/marketplace-versions", () => ({ getLatestVersion: mocks.latest, getVersionById: mocks.stored }));
vi.mock("$server/auth/middleware", () => ({ requireAuth: () => ({ id: "user" }) }));
vi.mock("$lib/server/security/api-keys", () => ({ requireScope: () => null }));
import { GET } from "../routes/api/marketplace/export/[id]/+server";
const event = { params: { id: "listing" }, locals: {} } as unknown as Parameters<typeof GET>[0];
beforeEach(() => { vi.clearAllMocks(); mocks.listing.mockResolvedValue({ id: "listing", slug: "extension" }); });

test("exports an immutable source release without changing its digest", async () => {
  const source = { "extension.ts": "source" };
  const manifest = validateManifest({ schemaVersion: 4, name: "exported", version: "1.0.0", description: "Exported", author: { name: "Test" }, permissions: {} });
  const release = await sealPublishedRelease({ operationId: "build", state: "succeeded", sourceDigest: await sha256(canonicalJson(source)), artifactDigest: await sha256(canonicalJson(source)), imageDigest: "image", manifest, diagnostics: [], evidence: { protocolVersion: 4, validatorVersion: "v4", tests: [{ name: "fixture", passed: true }], discoveryDigest: await sha256(canonicalJson(manifest)) } }, source);
  mocks.latest.mockResolvedValue({ id: "version", version: "1.0.0", manifest });
  mocks.stored.mockResolvedValue({ manifest, release });
  const response = await GET(event);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(release);
  expect(response.headers.get("content-disposition")).toContain(".release.json");
  mocks.stored.mockResolvedValue({ manifest });
  expect((await GET(event)).status).toBe(409);
  mocks.stored.mockResolvedValue({ manifest: { ...manifest, description: "tampered" }, release });
  expect((await GET(event)).status).toBe(409);
});
