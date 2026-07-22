/**
 * DOM tests for ProjectRail.svelte — guards the project-icon <img> render.
 *
 * `projects.icon` can hold a non-URL token (e.g. a Lucide name like
 * "FlaskConical" arriving via the API). Rendering that as an <img src>
 * fires a relative request (`/project/<id>/FlaskConical`) → 404 broken
 * image. The rail must only emit an <img> for URL-like icons and otherwise
 * fall back to its existing colored first-letter avatar.
 */

import { render } from "@testing-library/svelte";
import { describe, test, expect, afterEach } from "vitest";
import ProjectRail from "../ProjectRail.svelte";
import { store } from "$lib/stores.svelte";
import type { Project } from "$lib/api";

function project(overrides: Partial<Project>): Project {
	return {
		id: "p1",
		name: "Flask",
		path: "/tmp/flask",
		icon: null,
		variables: {},
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

afterEach(() => {
	store.projects = [];
});

describe("ProjectRail project-icon rendering", () => {
	test("non-URL icon token falls back to the letter avatar (no <img>)", () => {
		store.projects = [project({ id: "p1", name: "Flask", icon: "FlaskConical" })];

		const { container } = render(ProjectRail);

		// Scope to the project's own button — the rail also mounts EzButton,
		// which renders an unrelated favicon <img>.
		const button = container.querySelector('button[aria-label="Flask"]');
		expect(button).not.toBeNull();
		// No <img> for a bare Lucide name — it degrades to the letter avatar.
		expect(button?.querySelector("img")).toBeNull();
		expect(button?.textContent).toContain("F");
	});

	test("URL-like icon renders an <img> with that src", () => {
		store.projects = [project({ id: "p2", name: "Uploaded", icon: "/uploads/x.png" })];

		const { container } = render(ProjectRail);

		const button = container.querySelector('button[aria-label="Uploaded"]');
		expect(button).not.toBeNull();
		const img = button?.querySelector("img");
		expect(img).not.toBeNull();
		expect(img?.getAttribute("src")).toBe("/uploads/x.png");
	});
});
