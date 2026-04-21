import { test, expect, describe, beforeEach, mock } from "bun:test";

/**
 * `buildCommandResolver` is the glue the chat endpoints use to feed the
 * executor a per-turn resolver bound to the active user + project. These
 * tests verify it:
 *   1. Looks up the project's filesystem path from the DB.
 *   2. Passes `userId`, `projectId`, and the resolved `projectPath` into
 *      the registry's `findCommand`.
 *   3. Gracefully handles missing / unknown projects.
 *   4. Short-circuits with `null` when the registry returns nothing.
 */

let findCommandArgs: Record<string, unknown> | null = null;
let nextCommandResult:
	| { body: string; frontmatter: Record<string, string> }
	| null = null;
let projectStub: { id: string; path: string | null } | null = null;

mock.module("$lib/server/context", () => ({
	getCommandRegistry: () => ({
		findCommand: async (args: Record<string, unknown>) => {
			findCommandArgs = args;
			return nextCommandResult;
		},
		listCommands: async () => [],
		invalidate: () => {},
	}),
}));

mock.module("$server/db/queries/projects", () => ({
	getProject: async (_id: string) => projectStub,
}));

const { buildCommandResolver } = await import("$lib/server/command-resolver");

beforeEach(() => {
	findCommandArgs = null;
	nextCommandResult = null;
	projectStub = null;
});

describe("buildCommandResolver", () => {
	test("calls registry.findCommand with absolute project path", async () => {
		projectStub = { id: "p1", path: "/tmp/my-proj" };
		nextCommandResult = { body: "hello", frontmatter: {} };

		const resolver = buildCommandResolver("user-1", "p1");
		const result = await resolver("greet");

		expect(result).toEqual({ body: "hello", frontmatter: {} });
		expect(findCommandArgs).toEqual({
			name: "greet",
			userId: "user-1",
			projectId: "p1",
			projectPath: "/tmp/my-proj",
		});
	});

	test("passes projectPath=null when project has no path", async () => {
		projectStub = { id: "p1", path: null };
		nextCommandResult = { body: "b", frontmatter: {} };

		const resolver = buildCommandResolver("user-1", "p1");
		await resolver("x");

		expect(findCommandArgs?.projectPath).toBeNull();
	});

	test("passes projectPath=null when projectId is undefined", async () => {
		nextCommandResult = { body: "b", frontmatter: {} };

		const resolver = buildCommandResolver("user-1", undefined);
		await resolver("x");

		expect(findCommandArgs?.projectPath).toBeNull();
		// projectId falls back to "global" so the registry can cache per-user.
		expect(findCommandArgs?.projectId).toBe("global");
	});

	test("passes projectPath=null when projectId is null", async () => {
		nextCommandResult = { body: "b", frontmatter: {} };

		const resolver = buildCommandResolver("user-1", null);
		await resolver("x");

		expect(findCommandArgs?.projectPath).toBeNull();
		expect(findCommandArgs?.projectId).toBe("global");
	});

	test("returns null when the registry has no matching command", async () => {
		projectStub = { id: "p1", path: "/tmp/proj" };
		nextCommandResult = null;

		const resolver = buildCommandResolver("user-1", "p1");
		expect(await resolver("missing")).toBeNull();
	});

	test("surfaces frontmatter unchanged", async () => {
		projectStub = { id: "p1", path: "/tmp/proj" };
		nextCommandResult = {
			body: "go",
			frontmatter: { agent: "worker", model: "sonnet-4.6" },
		};

		const resolver = buildCommandResolver("user-1", "p1");
		const result = await resolver("go");
		expect(result?.frontmatter).toEqual({
			agent: "worker",
			model: "sonnet-4.6",
		});
	});

	test("a DB lookup failure does NOT throw — treats as no project path", async () => {
		// Force getProject to throw by setting projectStub to a thrower.
		// We use mock.module's rebindability by swapping projectStub to a
		// proxy that throws on access.
		projectStub = new Proxy({} as any, {
			get() {
				throw new Error("db down");
			},
		});
		nextCommandResult = { body: "b", frontmatter: {} };

		const resolver = buildCommandResolver("user-1", "p1");
		await resolver("x");
		// Should still call the registry, with projectPath === null.
		expect(findCommandArgs?.projectPath).toBeNull();
	});
});
