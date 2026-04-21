import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createCommandRegistry,
} from "$server/runtime/commands/registry";

function cmd(dir: string, name: string, description: string, body = "") {
	return {
		ensure: async () => {
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, `${name}.md`),
				`---\ndescription: ${description}\n---\n${body}`,
				"utf8",
			);
		},
	};
}

describe("createCommandRegistry", () => {
	let projectPath: string;
	let home: string;

	beforeEach(async () => {
		projectPath = await mkdtemp(join(tmpdir(), "reg-proj-"));
		home = await mkdtemp(join(tmpdir(), "reg-home-"));
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	});

	test("listCommands returns project + home results", async () => {
		await cmd(
			join(projectPath, ".claude/commands"),
			"deploy",
			"proj deploy",
		).ensure();
		await cmd(
			join(home, ".claude/commands"),
			"review",
			"home review",
		).ensure();

		const reg = createCommandRegistry({
			homePath: home,
			scanHome: true,
			dbLister: async () => [],
		});
		const list = await reg.listCommands({
			userId: "u1",
			projectId: "p1",
			projectPath,
		});
		const names = list.map((c) => c.name).sort();
		expect(names).toEqual(["deploy", "review"]);
	});

	test("scanHome=false suppresses home-dir commands", async () => {
		await cmd(join(home, ".claude/commands"), "home-only", "h").ensure();
		await cmd(join(projectPath, ".claude/commands"), "proj-only", "p").ensure();

		const reg = createCommandRegistry({
			homePath: home,
			scanHome: false,
			dbLister: async () => [],
		});
		const list = await reg.listCommands({
			userId: "u1",
			projectId: "p1",
			projectPath,
		});
		expect(list.map((c) => c.name).sort()).toEqual(["proj-only"]);
	});

	test("merges DB-backed per-user commands", async () => {
		await cmd(join(projectPath, ".claude/commands"), "proj", "p").ensure();

		const reg = createCommandRegistry({
			homePath: home,
			scanHome: false,
			dbLister: async (userId) => {
				expect(userId).toBe("u1");
				return [
					{
						name: "mycmd",
						description: "user db cmd",
						body: "hi $ARGUMENTS",
						frontmatter: {},
					},
				];
			},
		});
		const list = await reg.listCommands({
			userId: "u1",
			projectId: "p1",
			projectPath,
		});
		const names = list.map((c) => c.name).sort();
		expect(names).toEqual(["mycmd", "proj"]);
		const dbRec = list.find((c) => c.name === "mycmd")!;
		expect(dbRec.source).toBe("user:db");
	});

	test("findCommand returns exact-name match, preferring project scope", async () => {
		await cmd(join(projectPath, ".claude/commands"), "review", "proj").ensure();
		await cmd(join(home, ".claude/commands"), "review", "home").ensure();

		const reg = createCommandRegistry({
			homePath: home,
			scanHome: true,
			dbLister: async () => [],
		});
		const found = await reg.findCommand({
			name: "review",
			userId: "u1",
			projectId: "p1",
			projectPath,
		});
		expect(found).not.toBeNull();
		expect(found!.description).toBe("proj");
		expect(found!.source).toBe("project:claude-commands");
	});

	test("findCommand returns null for unknown name", async () => {
		const reg = createCommandRegistry({
			homePath: home,
			scanHome: true,
			dbLister: async () => [],
		});
		const found = await reg.findCommand({
			name: "nope",
			userId: "u1",
			projectId: "p1",
			projectPath,
		});
		expect(found).toBeNull();
	});

	test("cache serves repeat reads without re-scanning the filesystem", async () => {
		await cmd(join(projectPath, ".claude/commands"), "c", "d").ensure();

		let dbCalls = 0;
		const reg = createCommandRegistry({
			homePath: home,
			scanHome: false,
			dbLister: async () => {
				dbCalls++;
				return [];
			},
			cacheTtlMs: 1000,
		});

		await reg.listCommands({ userId: "u1", projectId: "p1", projectPath });
		await reg.listCommands({ userId: "u1", projectId: "p1", projectPath });
		await reg.listCommands({ userId: "u1", projectId: "p1", projectPath });
		expect(dbCalls).toBe(1);
	});

	test("invalidate() forces next read to re-scan", async () => {
		await cmd(join(projectPath, ".claude/commands"), "c", "d").ensure();
		let dbCalls = 0;
		const reg = createCommandRegistry({
			homePath: home,
			scanHome: false,
			dbLister: async () => {
				dbCalls++;
				return [];
			},
			cacheTtlMs: 60_000,
		});

		await reg.listCommands({ userId: "u1", projectId: "p1", projectPath });
		expect(dbCalls).toBe(1);
		reg.invalidate({ userId: "u1", projectId: "p1" });
		await reg.listCommands({ userId: "u1", projectId: "p1", projectPath });
		expect(dbCalls).toBe(2);
	});

	test("cache key is per (userId, projectId) — different users see different data", async () => {
		let callCount = 0;
		const reg = createCommandRegistry({
			homePath: home,
			scanHome: false,
			dbLister: async (userId) => {
				callCount++;
				return [
					{
						name: `for-${userId}`,
						description: "",
						body: "",
						frontmatter: {},
					},
				];
			},
		});

		const u1 = await reg.listCommands({
			userId: "u1",
			projectId: "p1",
			projectPath,
		});
		const u2 = await reg.listCommands({
			userId: "u2",
			projectId: "p1",
			projectPath,
		});
		expect(callCount).toBe(2);
		expect(u1.map((c) => c.name)).toContain("for-u1");
		expect(u2.map((c) => c.name)).toContain("for-u2");
	});
});
