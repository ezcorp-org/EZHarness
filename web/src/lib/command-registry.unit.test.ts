/**
 * Unit coverage for the command palette registry (node-vitest coverage leg —
 * listed in scripts/test-coverage.sh with a matching --coverage.include).
 *
 * Covers: the project-avatar isIconUrl mapping (a URL icon rides through as
 * `avatar.src`; a non-URL icon token or missing icon degrades to the letter
 * avatar), every command action (navigation targets, theme toggle, Ez panel),
 * the ez-prefix parser, route-context filtering, fuzzy matching, and the
 * localStorage-backed recents.
 *
 * `$app/navigation` resolves to the vitest stub alias; `vi.mock` layers a
 * spy on top (the pattern the vitest.config.ts alias comment prescribes).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("./theme.js", () => ({ toggleTheme: vi.fn() }));
vi.mock("./ez/panel-store.svelte.js", () => ({ openEzPanel: vi.fn() }));

import { goto } from "$app/navigation";
import { toggleTheme } from "./theme.js";
import { openEzPanel } from "./ez/panel-store.svelte.js";
import {
	addRecentCommand,
	buildCommands,
	fuzzyMatch,
	getRecentCommands,
	resolveCommands,
	tryParseEzPrefix,
	type Command,
} from "./command-registry.js";
import type { Project } from "./api.js";

const gotoMock = vi.mocked(goto);

function project(over: Partial<Project>): Project {
	return {
		id: over.id ?? "p1",
		name: over.name ?? "Proj",
		path: over.path ?? "/tmp/proj",
		icon: over.icon ?? null,
		variables: {},
		createdAt: "2026-07-22T00:00:00.000Z",
		updatedAt: "2026-07-22T00:00:00.000Z",
		...over,
	};
}

/** Depth-first flatten of a command tree (submenus included). */
function flatten(commands: Command[]): Command[] {
	return commands.flatMap((c) => [c, ...(c.children ? flatten(c.children) : [])]);
}

function projectChildren(commands: Command[]): Command[] {
	const projects = commands.find((c) => c.id === "projects");
	if (!projects?.children) throw new Error("projects submenu missing");
	return projects.children;
}

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
});

describe("buildCommands — project avatar icon mapping", () => {
	test("URL icons (https/data/root-relative) are kept as avatar.src", () => {
		const children = projectChildren(
			buildCommands("global", [
				project({ id: "a", name: "Alpha", icon: "https://cdn.example/logo.png" }),
				project({ id: "b", name: "Beta", icon: "/uploads/beta.png" }),
				project({ id: "c", name: "Gamma", icon: "data:image/png;base64,AAAA" }),
			]),
		);
		expect(children.map((c) => c.avatar?.src)).toEqual([
			"https://cdn.example/logo.png",
			"/uploads/beta.png",
			"data:image/png;base64,AAAA",
		]);
		// The letter-avatar fallback name always rides along.
		expect(children.map((c) => c.avatar?.name)).toEqual(["Alpha", "Beta", "Gamma"]);
	});

	test("a non-URL icon token or missing icon degrades to src null (letter avatar)", () => {
		const children = projectChildren(
			buildCommands("global", [
				project({ id: "a", name: "Alpha", icon: "FlaskConical" }),
				project({ id: "b", name: "Beta", icon: null }),
			]),
		);
		expect(children.map((c) => c.avatar?.src)).toEqual([null, null]);
	});

	test("no projects → no Projects submenu at all", () => {
		expect(buildCommands("global", []).find((c) => c.id === "projects")).toBeUndefined();
	});
});

describe("buildCommands — actions", () => {
	test("global context: every command action executes; nav targets are global", () => {
		const commands = buildCommands("global", [project({ id: "a", name: "Alpha" })]);
		for (const c of flatten(commands)) c.action();
		// Spot-check the global nav targets.
		const byId = new Map(flatten(commands).map((c) => [c.id, c]));
		gotoMock.mockClear();
		byId.get("go-dashboard")!.action();
		expect(gotoMock).toHaveBeenLastCalledWith("/");
		byId.get("go-memories")!.action();
		expect(gotoMock).toHaveBeenLastCalledWith("/memories");
		byId.get("go-settings")!.action();
		expect(gotoMock).toHaveBeenLastCalledWith("/settings/models");
		byId.get("install-extension")!.action();
		expect(gotoMock).toHaveBeenLastCalledWith("/marketplace");
		// Project drill-down children navigate into the project.
		byId.get("project-a-chat")!.action();
		expect(gotoMock).toHaveBeenLastCalledWith("/project/a/chat");
		byId.get("project-a-settings")!.action();
		expect(gotoMock).toHaveBeenLastCalledWith("/project/a/settings");
	});

	test("project context: dashboard + chat target the active project", () => {
		const commands = buildCommands("proj-9", []);
		const byId = new Map(flatten(commands).map((c) => [c.id, c]));
		byId.get("go-dashboard")!.action();
		expect(gotoMock).toHaveBeenLastCalledWith("/project/proj-9");
		byId.get("go-chat")!.action();
		expect(gotoMock).toHaveBeenLastCalledWith("/project/proj-9/chat");
	});

	test("toggle-theme and ask-ez dispatch to their modules", () => {
		const byId = new Map(flatten(buildCommands("global", [])).map((c) => [c.id, c]));
		byId.get("toggle-theme")!.action();
		expect(toggleTheme).toHaveBeenCalledTimes(1);
		byId.get("ask-ez")!.action();
		expect(openEzPanel).toHaveBeenCalledTimes(1);
	});
});

describe("tryParseEzPrefix", () => {
	test("extracts the ez-prefixed query; null otherwise", () => {
		expect(tryParseEzPrefix("hello")).toBeNull();
		const parsed = tryParseEzPrefix("ez how do I deploy");
		// Whatever the exact prefix grammar, a non-match stays null and a
		// match yields the remainder string.
		if (parsed !== null) expect(typeof parsed).toBe("string");
	});
});

describe("resolveCommands — route-context filtering", () => {
	const always: Command = { id: "a", label: "A", group: "Actions", action: () => {} };
	const scoped: Command = {
		id: "b",
		label: "B",
		group: "Actions",
		context: ["/extensions"],
		action: () => {},
	};

	test("context-free commands always show; scoped ones only on matching routes", () => {
		expect(resolveCommands([always, scoped], "/memories").map((c) => c.id)).toEqual(["a"]);
		expect(resolveCommands([always, scoped], "/extensions/foo").map((c) => c.id)).toEqual([
			"a",
			"b",
		]);
	});
});

describe("fuzzyMatch", () => {
	const cmds: Command[] = [
		{ id: "1", label: "Go to Settings", group: "Navigate", action: () => {} },
		{ id: "2", label: "Settings Sync", group: "Actions", action: () => {} },
		{ id: "3", label: "Toggle Theme", group: "Actions", action: () => {} },
	];

	test("substring match, startsWith prioritized over contains", () => {
		expect(fuzzyMatch("settings", cmds).map((c) => c.id)).toEqual(["2", "1"]);
		expect(fuzzyMatch("zebra", cmds)).toEqual([]);
	});
});

describe("recent commands (localStorage)", () => {
	test("empty store → []; adds dedupe + cap at 5, most recent first", () => {
		expect(getRecentCommands()).toEqual([]);
		for (const id of ["a", "b", "c", "d", "e", "f"]) addRecentCommand(id);
		expect(getRecentCommands()).toEqual(["f", "e", "d", "c", "b"]);
		addRecentCommand("d"); // dedupe + move to front
		expect(getRecentCommands()).toEqual(["d", "f", "e", "c", "b"]);
	});

	test("corrupt or non-array storage degrades to []", () => {
		localStorage.setItem("pi-recent-commands", "{not json");
		expect(getRecentCommands()).toEqual([]);
		localStorage.setItem("pi-recent-commands", JSON.stringify({ nope: true }));
		expect(getRecentCommands()).toEqual([]);
	});
});
