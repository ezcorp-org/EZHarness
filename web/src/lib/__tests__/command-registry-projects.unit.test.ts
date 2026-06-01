/**
 * Unit tests for the Projects drill-down in the REAL command-registry
 * (`buildCommands` + `buildProjectActions`). Runs under vitest (`.unit.test.ts`)
 * so the SvelteKit `$app/navigation` import can be mocked — the sibling
 * `command-registry.test.ts` replicates logic under `bun test` and cannot import
 * this module directly.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const { gotoMock } = vi.hoisted(() => ({ gotoMock: vi.fn() }));
vi.mock("$app/navigation", () => ({ goto: gotoMock }));
vi.mock("$lib/theme.js", () => ({ toggleTheme: vi.fn() }));
vi.mock("$lib/ez/panel-store.svelte.js", () => ({ openEzPanel: vi.fn() }));

import { buildCommands, buildProjectActions } from "$lib/command-registry.js";
import type { Project } from "$lib/api.js";

function proj(o: Partial<Project> & { id: string; name: string }): Project {
	return {
		path: "",
		icon: null,
		variables: {},
		createdAt: "",
		updatedAt: "",
		...o,
	} as Project;
}

beforeEach(() => gotoMock.mockClear());

describe("buildProjectActions", () => {
	test("returns Chat/Settings scoped to the project id", () => {
		const acts = buildProjectActions("p1");
		expect(acts.map((a) => a.label)).toEqual(["Go to Chat", "Go to Settings"]);
		expect(acts.map((a) => a.id)).toEqual([
			"project-p1-chat",
			"project-p1-settings",
		]);
		expect(acts.every((a) => a.group === "Navigate")).toBe(true);
	});

	test("each action navigates to its scoped route", () => {
		const [chat, settings] = buildProjectActions("p1");
		chat.action();
		expect(gotoMock).toHaveBeenLastCalledWith("/project/p1/chat");
		settings.action();
		expect(gotoMock).toHaveBeenLastCalledWith("/project/p1/settings");
	});
});

describe("buildCommands — Projects drill-down", () => {
	const projects = [
		proj({ id: "a", name: "Alpha", icon: "🚀" }),
		proj({ id: "b", name: "Beta" }), // icon null → undefined on the command
	];

	test("adds a Projects command whose children mirror the projects", () => {
		const cmds = buildCommands("global", projects);
		const projectsCmd = cmds.find((c) => c.id === "projects");
		expect(projectsCmd).toBeDefined();
		expect(projectsCmd!.group).toBe("Project");
		expect(projectsCmd!.children?.map((c) => c.label)).toEqual(["Alpha", "Beta"]);
		expect(projectsCmd!.children?.map((c) => c.id)).toEqual([
			"project-a",
			"project-b",
		]);
	});

	test("project entries carry their emoji icon (or undefined) and their actions", () => {
		const projectsCmd = buildCommands("global", projects).find(
			(c) => c.id === "projects",
		)!;
		const [alpha, beta] = projectsCmd.children!;
		expect(alpha.icon).toBe("🚀");
		expect(beta.icon).toBeUndefined();
		expect(alpha.group).toBe("Project");
		expect(alpha.children?.map((c) => c.id)).toEqual([
			"project-a-chat",
			"project-a-settings",
		]);
	});

	test("no Projects command when there are no projects (incl. default arg)", () => {
		expect(buildCommands("global", []).some((c) => c.id === "projects")).toBe(false);
		expect(buildCommands("global").some((c) => c.id === "projects")).toBe(false);
	});
});
