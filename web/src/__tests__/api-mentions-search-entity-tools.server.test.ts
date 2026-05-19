/**
 * Phase 4 — server-handler tests for the new `?type=tool&extension=…`
 * branch of /api/mentions/search.
 *
 * Verifies:
 *   - missing `extension` param returns [] (short-circuit)
 *   - unknown extension returns []
 *   - known extension returns both hand-rolled tools AND auto-
 *     generated entity tools, with `entityType` set on the latter
 *   - q filter applies (substring match on name + description)
 *
 * Doesn't depend on a real DB — the registry is mocked via a fake
 * singleton that returns the manifest/tool data we construct.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

const fakeRegistry = {
	getManifestByName: vi.fn(),
	getAllManifests: vi.fn(),
	getToolsForExtension: vi.fn(),
};

vi.mock("$server/extensions/registry", () => ({
	ExtensionRegistry: {
		getInstance: () => fakeRegistry,
	},
}));

vi.mock("$server/db/queries/projects", () => ({
	getProject: vi.fn(),
}));

vi.mock("$lib/server/context", () => ({
	getExecutor: () => ({ listAgents: () => [] }),
	getCommandRegistry: () => ({ listCommands: async () => [] }),
}));

const { GET } = await import("../routes/api/mentions/search/+server");

function makeEvent(href: string) {
	const user = { id: "u1", email: "u@x", name: "u", role: "user" };
	return {
		url: new URL(href),
		locals: { user },
		request: new Request(href, { method: "GET" }),
	} as any;
}

describe("/api/mentions/search?type=tool", () => {
	beforeEach(() => {
		fakeRegistry.getManifestByName.mockReset();
		fakeRegistry.getAllManifests.mockReset();
		fakeRegistry.getToolsForExtension.mockReset();
	});

	test("missing `extension` param returns []", async () => {
		const res = await GET(
			makeEvent("http://x/api/mentions/search?type=tool&q=list"),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(body).toEqual([]);
	});

	test("unknown extension returns []", async () => {
		fakeRegistry.getManifestByName.mockReturnValue(undefined);
		const res = await GET(
			makeEvent(
				"http://x/api/mentions/search?type=tool&extension=missing",
			),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(body).toEqual([]);
	});

	test("returns hand-rolled + entity tools for known extension", async () => {
		const manifest = {
			name: "substack-pilot",
			tools: [
				{ name: "summarize_urls", description: "Summarize URLs", inputSchema: {} },
			],
			entities: [
				{
					type: "post-type",
					label: "Post Type",
					pluralLabel: "Post Types",
					schema: { type: "object" },
				},
			],
		};
		fakeRegistry.getManifestByName.mockReturnValue(manifest);
		fakeRegistry.getAllManifests.mockReturnValue(
			new Map([["ext-1", manifest]]).entries(),
		);
		// What the registry actually exposes — hand-rolled tools plus
		// the entity auto-tools, each tagged with entityType.
		fakeRegistry.getToolsForExtension.mockReturnValue([
			{
				originalName: "summarize_urls",
				description: "Summarize URLs",
				name: "substack-pilot__summarize_urls",
				extensionId: "ext-1",
				extensionName: "substack-pilot",
				inputSchema: {},
			},
			{
				originalName: "list_post_types",
				description: "List all Post Types.",
				name: "substack-pilot__list_post_types",
				extensionId: "ext-1",
				extensionName: "substack-pilot",
				entityKind: "list",
				entityType: "post-type",
				inputSchema: {},
			},
			{
				originalName: "create_post_type",
				description: "Create a new Post Type.",
				name: "substack-pilot__create_post_type",
				extensionId: "ext-1",
				extensionName: "substack-pilot",
				entityKind: "create",
				entityType: "post-type",
				inputSchema: {},
			},
		]);

		const res = await GET(
			makeEvent(
				"http://x/api/mentions/search?type=tool&extension=substack-pilot",
			),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{
			name: string;
			kind: string;
			entityType?: string;
		}>;
		expect(body.map((b) => b.name).sort()).toEqual(
			["create_post_type", "list_post_types", "summarize_urls"].sort(),
		);
		expect(body.every((b) => b.kind === "tool")).toBe(true);
		// Entity-served tools carry entityType; hand-rolled doesn't.
		const list = body.find((b) => b.name === "list_post_types");
		expect(list?.entityType).toBe("post-type");
		const summarize = body.find((b) => b.name === "summarize_urls");
		expect(summarize?.entityType).toBeUndefined();
	});

	test("filters by q (case-insensitive substring on name + description)", async () => {
		const manifest = { name: "substack-pilot" };
		fakeRegistry.getManifestByName.mockReturnValue(manifest);
		fakeRegistry.getAllManifests.mockReturnValue(
			new Map([["ext-1", manifest]]).entries(),
		);
		fakeRegistry.getToolsForExtension.mockReturnValue([
			{
				originalName: "summarize_urls",
				description: "Summarize URLs",
				name: "substack-pilot__summarize_urls",
				extensionId: "ext-1",
				extensionName: "substack-pilot",
				inputSchema: {},
			},
			{
				originalName: "list_post_types",
				description: "List all Post Types.",
				name: "substack-pilot__list_post_types",
				extensionId: "ext-1",
				extensionName: "substack-pilot",
				entityKind: "list",
				entityType: "post-type",
				inputSchema: {},
			},
		]);

		const res = await GET(
			makeEvent(
				"http://x/api/mentions/search?type=tool&extension=substack-pilot&q=list",
			),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ name: string }>;
		expect(body.map((b) => b.name)).toEqual(["list_post_types"]);
	});

	test("returns empty array when extension has no tools and no entities", async () => {
		const manifest = { name: "empty-ext" };
		fakeRegistry.getManifestByName.mockReturnValue(manifest);
		fakeRegistry.getAllManifests.mockReturnValue(
			new Map([["ext-1", manifest]]).entries(),
		);
		fakeRegistry.getToolsForExtension.mockReturnValue([]);

		const res = await GET(
			makeEvent(
				"http://x/api/mentions/search?type=tool&extension=empty-ext",
			),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(body).toEqual([]);
	});
});
