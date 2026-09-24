import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Project } from "$lib/api.js";
import { refreshProjects, store } from "$lib/stores.svelte.js";

const projects: Project[] = [{ id: "sandbox-project", name: "Sandbox", path: "", icon: null, variables: {}, createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z" }];

describe("refreshProjects", () => {
	beforeEach(() => {
		store.projects = [];
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("resolves after it adds fetched projects to the client store", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(projects), { status: 200 })));

		expect(await refreshProjects()).toBe(true);

		expect(store.projects).toEqual(projects);
	});

	test("keeps the current projects when refresh fails", async () => {
		store.projects = projects;
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

		expect(await refreshProjects()).toBe(false);

		expect(store.projects).toEqual(projects);
	});
});
