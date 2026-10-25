/**
 * A bundled extension that is STAGED and waits for an administrator's approval
 * is not "not installed".
 *
 * `ensureBundledExtensions()` stages every first-party extension as a disabled
 * v4 installation; it becomes an active extension only after an administrator
 * approves its exact release. On a fresh install the task-tracking, ask-user
 * and orchestration hosts therefore found no extension row on every chat turn
 * and logged "not installed — did ensureBundledExtensions() run?", which is
 * false: the boot did run, and the state is a designed one that waits for a
 * human. 46 such warnings were in one real-auth CI run (run 40217994555).
 *
 * The hosts now tell the two states apart through one classifier
 * (`src/extensions/bundled-extension-state.ts`):
 *   - staged, awaiting approval: one info line per extension per process that
 *     names the state and the action;
 *   - no installation at all: still the warning, because that is a real fault.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mock.module("../db/connection", () => ({
	getDb: () => {
		const pg = getTestPglite();
		if (!pg) throw new Error("Test DB not initialized");
		const { drizzle } = require("drizzle-orm/pglite");
		const schema = require("../db/schema");
		return drizzle(pg, { schema });
	},
	getPglite: () => getTestPglite(),
	getDbPath: () => ":memory:",
	initDb: async () => {},
	closeDb: async () => {},
}));

const taskTracking = await import("../runtime/task-tracking-host");
const askUser = await import("../runtime/ask-user-host");
const orchestration = await import("../runtime/orchestration-host");
const { bundledInstallationId } = await import("../extensions/bundled-bootstrap");
const { DatabaseLifecycleRepository } = await import("../db/queries/extension-releases");
const { getDb } = await import("../db/connection");
const { users, projects, conversations, extensions: extensionsTable } = await import("../db/schema");
const extensionQueries = await import("../db/queries/extensions");

/** The per-turn wire params; the state check returns before any of the tool plumbing is read. */
const turn = { agentTools: [], conversationId: "conv-t", runId: "run-t", registry: {}, bus: {}, executor: {}, availableAgents: [], depth: 0 } as never;

const ADMIN = "admin-staged-test";

/** Stage `name` the way the bundled bootstrap does: a disabled, global installation with no active release. */
async function stage(name: string): Promise<void> {
	await new DatabaseLifecycleRepository(getDb()).create({
		installation: {
			id: bundledInstallationId(name), ownerId: ADMIN, scope: "global", activeReleaseId: null, generation: 0,
			enabled: false, uninstalled: false, status: "disabled", grants: [], acknowledgedGeneration: 0,
		},
		workspaces: {}, revisions: {}, operations: {}, releases: {}, approvals: {},
	} as never);
}

/** Host log lines written while a test runs (info goes to stdout, warn to stderr). */
let lines: Array<{ level: string; msg: string }> = [];
let spies: Array<{ mockRestore(): void }> = [];

function capture(stream: NodeJS.WriteStream): { mockRestore(): void } {
	const write = stream.write.bind(stream);
	return spyOn(stream, "write").mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
		for (const line of String(chunk).split("\n")) {
			if (!line.startsWith("{")) continue;
			const entry = JSON.parse(line) as { level: string; msg: string };
			lines.push({ level: entry.level, msg: entry.msg });
		}
		return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
	}) as typeof stream.write);
}

const awaiting = (name: string) => lines.filter((l) => l.msg === `${name} is staged and awaits administrator approval`);
const notInstalledWarnings = () => lines.filter((l) => l.level === "warn" && /not installed/.test(l.msg));

beforeAll(async () => {
	await setupTestDb();
	await getDb().insert(users).values({ id: ADMIN, email: "staged@t.local", passwordHash: "x", name: "Admin", role: "admin" } as never).onConflictDoNothing();
});

afterAll(async () => {
	await closeTestDb();
	restoreModuleMocks();
});

beforeEach(() => {
	lines = [];
	spies = [capture(process.stdout), capture(process.stderr)];
	taskTracking._resetTaskTrackingExtensionIdCache();
	askUser._resetAskUserExtensionIdCache();
	orchestration._resetOrchestrationExtensionIdCache();
});

afterEach(() => {
	for (const spy of spies) spy.mockRestore();
});

describe("no installation at all is still a fault (before anything is staged)", () => {
	test("task-tracking: the not-installed error, not the awaiting-approval one", async () => {
		const error = await taskTracking.getTaskTrackingExtensionId().then(() => null, (e: unknown) => e);
		expect(error).toBeInstanceOf(taskTracking.TaskTrackingNotInstalledError);
		expect((error as Error).message).toBe("task-tracking extension not installed — did ensureBundledExtensions() run?");
	});

	test("ask-user and orchestration: the warning stays", async () => {
		expect(await askUser.ensureAskUserWired("conv-missing")).toBe(false);
		expect(await orchestration.ensureOrchestrationWired("conv-missing")).toBe(false);
		await askUser.wireAskUserToolForTurn(turn);
		await orchestration.wireOrchestrationToolsForTurn(turn);
		expect(notInstalledWarnings().map((l) => l.msg)).toEqual([
			"ask-user extension not installed — did ensureBundledExtensions() run?",
			"Orchestration extension not installed — did ensureBundledExtensions() run?",
			"ask-user extension not installed — skipping wire for turn",
			"Orchestration extension not installed — skipping invoke_agent wiring for turn",
		]);
	});

	test("a failed lookup is a warning with its cause, not a silent skip", async () => {
		const lookup = spyOn(extensionQueries, "getExtensionByName").mockRejectedValueOnce(new Error("db down"));
		try {
			expect(await askUser.ensureAskUserWired("conv-x")).toBe(false);
		} finally {
			lookup.mockRestore();
		}
		expect(lines.filter((l) => l.level === "warn").map((l) => l.msg)).toEqual(["Failed to resolve ask-user extension id"]);
	});
});

describe("a staged extension that awaits approval is named as such, once per process", () => {
	beforeAll(async () => {
		for (const name of ["task-tracking", "ask-user", "orchestration"]) await stage(name);
	});

	test("task-tracking: an awaiting-approval error that existing not-installed handlers still catch", async () => {
		const error = await taskTracking.getTaskTrackingExtensionId().then(() => null, (e: unknown) => e);
		expect(error).toBeInstanceOf(taskTracking.TaskTrackingAwaitingApprovalError);
		expect(error).toBeInstanceOf(taskTracking.TaskTrackingNotInstalledError);
		expect((error as Error).message).toBe("task-tracking is staged and awaits administrator approval");
	});

	test("ask-user: no wiring, no false warning, one info line across turns", async () => {
		expect(await askUser.ensureAskUserWired("conv-1")).toBe(false);
		expect(await askUser.ensureAskUserWired("conv-2")).toBe(false);
		await askUser.wireAskUserToolForTurn(turn);
		expect(notInstalledWarnings()).toEqual([]);
		expect(awaiting("ask-user")).toEqual([{ level: "info", msg: "ask-user is staged and awaits administrator approval" }]);
	});

	test("orchestration: no wiring, no false warning, one info line across turns", async () => {
		expect(await orchestration.ensureOrchestrationWired("conv-1")).toBe(false);
		expect(await orchestration.ensureOrchestrationWired("conv-2")).toBe(false);
		await orchestration.wireOrchestrationToolsForTurn(turn);
		expect(notInstalledWarnings()).toEqual([]);
		expect(awaiting("orchestration")).toEqual([{ level: "info", msg: "orchestration is staged and awaits administrator approval" }]);
	});
});

describe("an approved (installed) extension is wired as before", () => {
	beforeAll(async () => {
		await getDb().insert(projects).values({ id: "proj-staged", name: "proj-staged", path: "/tmp/proj-staged" } as never).onConflictDoNothing();
		await getDb().insert(conversations).values({ id: "conv-installed", projectId: "proj-staged", title: "t" } as never).onConflictDoNothing();
		await getDb().insert(extensionsTable).values({
			id: "ext-ask-user", name: "ask-user", version: "1.0.0", description: "t",
			manifest: { schemaVersion: 2, name: "ask-user", version: "1.0.0", description: "t", author: { name: "t" }, permissions: {} },
			source: "test:ask-user", installPath: "/tmp/ask-user", enabled: true,
		} as never).onConflictDoNothing();
	});

	test("ask-user: the row wins over the staged installation; ensure wires it, and the turn reaches the registry", async () => {
		expect(await askUser.ensureAskUserWired("conv-installed")).toBe(true);
		const asked: string[] = [];
		await askUser.wireAskUserToolForTurn({ ...(turn as object), registry: { getToolsForExtension: (id: string) => { asked.push(id); return []; } } } as never);
		expect(asked).toEqual(["ext-ask-user"]);
		expect(awaiting("ask-user")).toEqual([]);
	});
});
