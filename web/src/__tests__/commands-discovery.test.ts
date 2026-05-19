import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	discoverProjectCommands,
	discoverHomeCommands,
	COMMAND_BODY_MAX_BYTES,
	COMMAND_COUNT_MAX,
} from "$server/runtime/commands/discovery";

async function writeCmd(
	dir: string,
	name: string,
	description: string,
	body: string,
	extra: Record<string, string> = {},
): Promise<void> {
	await mkdir(dir, { recursive: true });
	const lines = ["---", `description: ${description}`];
	for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${v}`);
	lines.push("---", body);
	await writeFile(join(dir, `${name}.md`), lines.join("\n"), "utf8");
}

describe("discoverProjectCommands", () => {
	let projectRoot: string;

	beforeEach(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "cmds-proj-"));
	});

	afterEach(async () => {
		await rm(projectRoot, { recursive: true, force: true });
	});

	test("finds commands under .claude/commands", async () => {
		await writeCmd(
			join(projectRoot, ".claude/commands"),
			"review",
			"Review the code",
			"Please review $ARGUMENTS",
		);

		const cmds = await discoverProjectCommands(projectRoot);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]!.name).toBe("review");
		expect(cmds[0]!.description).toBe("Review the code");
		expect(cmds[0]!.body).toContain("$ARGUMENTS");
		expect(cmds[0]!.source).toBe("project:claude-commands");
	});

	test("finds commands under .claude/agents with source label", async () => {
		await writeCmd(
			join(projectRoot, ".claude/agents"),
			"reviewer",
			"Code reviewer agent",
			"You are a reviewer",
		);

		const cmds = await discoverProjectCommands(projectRoot);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]!.source).toBe("project:claude-agents");
	});

	test("finds commands under .codex/prompts", async () => {
		await writeCmd(
			join(projectRoot, ".codex/prompts"),
			"deploy",
			"Deploy the app",
			"Deploy instructions",
		);

		const cmds = await discoverProjectCommands(projectRoot);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]!.source).toBe("project:codex-prompts");
	});

	test("finds commands under bare agents/ folder", async () => {
		await writeCmd(
			join(projectRoot, "agents"),
			"fix",
			"Fix bugs",
			"Do the fix",
		);

		const cmds = await discoverProjectCommands(projectRoot);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]!.source).toBe("project:agents");
	});

	test("merges commands from multiple roots", async () => {
		await writeCmd(
			join(projectRoot, ".claude/commands"),
			"a",
			"A cmd",
			"a body",
		);
		await writeCmd(
			join(projectRoot, ".codex/prompts"),
			"b",
			"B cmd",
			"b body",
		);

		const cmds = await discoverProjectCommands(projectRoot);
		const names = cmds.map((c) => c.name).sort();
		expect(names).toEqual(["a", "b"]);
	});

	test("namespaces collisions by source so both survive", async () => {
		await writeCmd(
			join(projectRoot, ".claude/commands"),
			"review",
			"Claude review",
			"claude body",
		);
		await writeCmd(
			join(projectRoot, ".codex/prompts"),
			"review",
			"Codex review",
			"codex body",
		);

		const cmds = await discoverProjectCommands(projectRoot);
		expect(cmds).toHaveLength(2);
		const sources = cmds.map((c) => c.source).sort();
		expect(sources).toEqual(["project:claude-commands", "project:codex-prompts"]);
	});

	test("ignores non-.md files", async () => {
		await mkdir(join(projectRoot, ".claude/commands"), { recursive: true });
		await writeFile(
			join(projectRoot, ".claude/commands/notes.txt"),
			"plain",
			"utf8",
		);
		await writeCmd(
			join(projectRoot, ".claude/commands"),
			"real",
			"real cmd",
			"body",
		);

		const cmds = await discoverProjectCommands(projectRoot);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]!.name).toBe("real");
	});

	test("handles files with no frontmatter (body-only) gracefully", async () => {
		const dir = join(projectRoot, ".claude/commands");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "plain.md"), "just body text", "utf8");

		const cmds = await discoverProjectCommands(projectRoot);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]!.name).toBe("plain");
		expect(cmds[0]!.description).toBe("");
		expect(cmds[0]!.body).toBe("just body text");
	});

	test("returns [] when no command directories exist", async () => {
		const cmds = await discoverProjectCommands(projectRoot);
		expect(cmds).toEqual([]);
	});

	test("rejects symlinks that escape the project root", async () => {
		const outside = await mkdtemp(join(tmpdir(), "cmds-escape-"));
		try {
			await writeCmd(outside, "evil", "escaped", "body");
			const cmdsDir = join(projectRoot, ".claude/commands");
			await mkdir(cmdsDir, { recursive: true });
			await symlink(
				join(outside, "evil.md"),
				join(cmdsDir, "evil.md"),
			);

			const cmds = await discoverProjectCommands(projectRoot);
			expect(cmds).toEqual([]);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	test("enforces body size cap", async () => {
		const dir = join(projectRoot, ".claude/commands");
		await mkdir(dir, { recursive: true });
		const bigBody = "x".repeat(COMMAND_BODY_MAX_BYTES + 1);
		await writeFile(
			join(dir, "huge.md"),
			`---\ndescription: huge\n---\n${bigBody}`,
			"utf8",
		);

		const cmds = await discoverProjectCommands(projectRoot);
		expect(cmds).toEqual([]);
	});

	test("enforces per-scope count cap", async () => {
		const dir = join(projectRoot, ".claude/commands");
		await mkdir(dir, { recursive: true });
		for (let i = 0; i < COMMAND_COUNT_MAX + 5; i++) {
			await writeFile(
				join(dir, `cmd${i}.md`),
				`---\ndescription: d${i}\n---\nbody`,
				"utf8",
			);
		}

		const cmds = await discoverProjectCommands(projectRoot);
		expect(cmds.length).toBe(COMMAND_COUNT_MAX);
	});

	test("returns [] for a non-existent project root", async () => {
		const cmds = await discoverProjectCommands(join(projectRoot, "does-not-exist"));
		expect(cmds).toEqual([]);
	});
});

describe("discoverHomeCommands", () => {
	let home: string;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "cmds-home-"));
	});

	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	test("scans ~/.claude/commands, ~/.claude/agents, ~/.codex/prompts, ~/agents", async () => {
		await writeCmd(
			join(home, ".claude/commands"),
			"a",
			"a",
			"a",
		);
		await writeCmd(join(home, ".claude/agents"), "b", "b", "b");
		await writeCmd(join(home, ".codex/prompts"), "c", "c", "c");
		await writeCmd(join(home, "agents"), "d", "d", "d");

		const cmds = await discoverHomeCommands(home);
		const sources = cmds.map((c) => c.source).sort();
		expect(sources).toEqual([
			"user:agents",
			"user:claude-agents",
			"user:claude-commands",
			"user:codex-prompts",
		]);
	});

	test("returns [] when home is a non-existent path", async () => {
		const cmds = await discoverHomeCommands(join(home, "does-not-exist"));
		expect(cmds).toEqual([]);
	});
});
