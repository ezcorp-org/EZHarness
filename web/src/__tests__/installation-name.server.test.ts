import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getExtension: vi.fn() }));
vi.mock("$server/db/queries/extensions", () => mocks);
import { resolveInstallationName } from "$lib/server/extensions/installation-name";
import type { InstallationState } from "$server/extensions/v4/types";

type Release = { manifest: { name: string }; createdAt: string };

function state(overrides: { activeReleaseId?: string | null; releases?: Record<string, Release> } = {}): InstallationState {
  return {
    installation: { id: "installation", activeReleaseId: overrides.activeReleaseId ?? null },
    releases: overrides.releases ?? {},
  } as unknown as InstallationState;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getExtension.mockResolvedValue(null);
});

test("no installation has no name", async () => {
  expect(await resolveInstallationName(null)).toBeNull();
  expect(mocks.getExtension).not.toHaveBeenCalled();
});

test("the active release names the installation", async () => {
  const releases = {
    old: { manifest: { name: "older-name" }, createdAt: "2026-02-01" },
    live: { manifest: { name: "memory-extractor" }, createdAt: "2026-01-01" },
  };
  expect(await resolveInstallationName(state({ activeReleaseId: "live", releases }))).toBe("memory-extractor");
  expect(mocks.getExtension).not.toHaveBeenCalled();
});

test("without an active release the newest release names it", async () => {
  const releases = {
    first: { manifest: { name: "first-name" }, createdAt: "2026-01-01" },
    latest: { manifest: { name: "latest-name" }, createdAt: "2026-03-01" },
  };
  expect(await resolveInstallationName(state({ releases }))).toBe("latest-name");
});

test("a bundled source without releases falls back to its legacy row", async () => {
  mocks.getExtension.mockResolvedValue({ name: "memory-extractor" });
  expect(await resolveInstallationName(state())).toBe("memory-extractor");
  expect(mocks.getExtension).toHaveBeenCalledWith("installation");
});

test("a fresh workspace without releases or a legacy row has no name", async () => {
  expect(await resolveInstallationName(state())).toBeNull();
});
