/**
 * Pure-utility unit coverage for the command palette registry — focused on
 * the project-avatar mapping: a URL icon rides through as `avatar.src`,
 * while a non-URL icon token (e.g. a Lucide name like "FlaskConical") or a
 * missing icon degrades to `null` so the palette renders the letter avatar
 * instead of a broken `<img>` (see `isIconUrl` in project-icon.ts).
 *
 * `$app/navigation` resolves to the vitest stub (vitest.config.ts alias),
 * so importing the registry is side-effect-free here.
 */
import { describe, expect, test } from "vitest";
import { buildCommands, type Command } from "./command-registry.js";
import type { Project } from "./api.js";

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

function projectChildren(commands: Command[]): Command[] {
	const projects = commands.find((c) => c.id === "projects");
	if (!projects?.children) throw new Error("projects submenu missing");
	return projects.children;
}

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
		const commands = buildCommands("global", []);
		expect(commands.find((c) => c.id === "projects")).toBeUndefined();
	});
});
