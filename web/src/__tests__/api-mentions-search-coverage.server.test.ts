/** Focused branch coverage for the mutually exclusive and merged mention searches. */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const mockGetProject = vi.fn();
const mockListFeatures = vi.fn();
const mockListCommands = vi.fn();
const mockListAgents = vi.fn();
const mockListEzActions = vi.fn();
const mockGetBuiltInCategories = vi.fn();
const mockPartition = vi.fn();
const fakeRegistry = {
	getManifestByName: vi.fn(),
	getAllManifests: vi.fn(),
	getToolsForExtension: vi.fn(),
};
let goalEnabled = false;
let teamRows: Array<{ name: string; description: string }> = [];
let extensionRows: Array<{ id: string; name: string; description: string; manifest: unknown; source: string; isBundled: boolean; creatorUserId: string | null }> = [];
let dbSelectCall = 0;

vi.mock("$server/db/queries/projects", () => ({ getProject: mockGetProject }));
vi.mock("$server/db/queries/features", () => ({ listFeatures: mockListFeatures }));
vi.mock("$server/runtime/goal-host", () => ({ parseGoalEnabled: () => goalEnabled }));
vi.mock("$server/runtime/ez-actions/registry", () => ({ listEzActions: mockListEzActions }));
vi.mock("$server/runtime/tools/builtin-registry", () => ({ getBuiltInCategories: mockGetBuiltInCategories }));
vi.mock("$server/auth/extension-wire-authz", () => ({
	partitionWirableExtensionsForUser: mockPartition,
}));
vi.mock("$server/extensions/registry", () => ({
	ExtensionRegistry: { getInstance: () => fakeRegistry },
}));
vi.mock("$lib/server/workflow-access", () => ({ listVisibleWorkflows: async () => [] }));
vi.mock("$lib/server/context", () => ({
	getExecutor: () => ({ listAgents: mockListAgents }),
	getCommandRegistry: () => ({ listCommands: mockListCommands }),
}));
vi.mock("$server/db/connection", () => ({
	getDb: () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => dbSelectCall++ === 0 ? teamRows : extensionRows,
				}),
			}),
		}),
	}),
}));

const { GET } = await import("../routes/api/mentions/search/+server");

const USER = { id: "u1", email: "u@x", name: "u", role: "user" };

function makeEvent(query = "") {
	return makeRequestEvent(`http://localhost/api/mentions/search${query}`, {
		locals: { user: USER },
		request: { method: "GET" },
	});
}

async function search(query = "") {
	const response = await GET(makeEvent(query));
	expect(response.status).toBe(200);
	return (await response.json()) as Array<Record<string, unknown>>;
}

describe("mentions search branch coverage", () => {
	beforeEach(() => {
		goalEnabled = false;
		teamRows = [];
		extensionRows = [];
		dbSelectCall = 0;
		mockGetProject.mockReset();
		mockListFeatures.mockReset();
		mockListCommands.mockReset().mockResolvedValue([]);
		mockListAgents.mockReset().mockReturnValue([]);
		mockListEzActions.mockReset().mockReturnValue([]);
		mockGetBuiltInCategories.mockReset().mockReturnValue([]);
		mockPartition.mockReset().mockResolvedValue({ deniedNames: [] });
		fakeRegistry.getManifestByName.mockReset();
		fakeRegistry.getAllManifests.mockReset();
		fakeRegistry.getToolsForExtension.mockReset();
	});

	test("injects the enabled /goal command and fuzzy-matches it", async () => {
		goalEnabled = true;
		const body = await search("?type=cmd&q=goal");
		expect(body).toContainEqual({
			name: "goal",
			description: "Set an autonomous goal — the AI keeps working until it's met",
			kind: "command",
			source: "builtin",
			insertText: "/goal ",
		});
	});

	test("executes EZ action search", async () => {
		mockListEzActions.mockReturnValue([{ name: "distill", description: "Distill lessons" }]);
		const body = await search("?type=EZ&q=dist");
		expect(body).toEqual([{ name: "distill", description: "Distill lessons", kind: "EZ" }]);
	});

	test("sorts fuzzy feature matches", async () => {
		mockGetProject.mockResolvedValue({ id: "p1", path: "/tmp/p1" });
		mockListFeatures.mockResolvedValue([
			{ id: "f1", name: "alphabet", description: "Related", fileCount: 1 },
			{ id: "f2", name: "alpha", description: "Target", fileCount: 2 },
		]);
		const body = await search("?type=feature&projectId=p1&q=alpha");
		expect(body[0]).toMatchObject({ name: "alpha", kind: "feature" });
	});

	test("lists tools for a named extension", async () => {
		const manifest = { name: "pilot" };
		fakeRegistry.getManifestByName.mockReturnValue(manifest);
		fakeRegistry.getAllManifests.mockReturnValue(new Map([["ext-1", manifest]]).entries());
		fakeRegistry.getToolsForExtension.mockReturnValue([{ originalName: "summarize", description: "Summarize text" }]);
		const body = await search("?type=tool&extension=pilot");
		expect(body).toEqual([{ name: "summarize", description: "Summarize text", kind: "tool" }]);
	});

	test("maps teams and stops at the result limit", async () => {
		teamRows = Array.from({ length: 11 }, (_, index) => ({ name: `team-${index}`, description: "team" }));
		const body = await search();
		expect(body).toHaveLength(10);
		expect(body.every((entry) => entry.kind === "team")).toBe(true);
	});

	test("skips duplicate teams and maps matching agents", async () => {
		teamRows = [{ name: "shared", description: "team" }];
		mockListAgents.mockReturnValue([
			{ name: "shared", description: "duplicate" },
			{ name: "target", description: "target agent" },
			{ name: "other", description: "other agent" },
		]);
		const body = await search("?q=target");
		expect(body.map((entry) => entry.name)).toEqual(["shared", "target"]);
	});

	test("stops agent results at the result limit", async () => {
		mockListAgents.mockReturnValue(Array.from({ length: 11 }, (_, index) => ({ name: `agent-${index}`, description: "agent" })));
		const body = await search("?type=agent");
		expect(body).toHaveLength(10);
		expect(body.every((entry) => entry.kind === "agent")).toBe(true);
	});

	test("skips duplicate built-ins and stops at the result limit", async () => {
		teamRows = [{ name: "existing", description: "team" }];
		mockGetBuiltInCategories.mockReturnValue([
			{ name: "existing", description: "duplicate" },
			...Array.from({ length: 10 }, (_, index) => ({ name: `builtin-${index}`, description: "builtin" })),
		]);
		const body = await search();
		expect(body).toHaveLength(10);
		expect(body.filter((entry) => entry.kind === "extension")).toHaveLength(9);
	});
});
