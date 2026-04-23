/**
 * DOM tests for EmptyState.svelte. Covers title/description rendering and
 * the three CTA branches: href, onclick, and neither.
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, vi } from "vitest";
import EmptyState from "./EmptyState.svelte";

afterEach(() => cleanup());

describe("EmptyState", () => {
	test("renders title and description text", () => {
		const { getByRole, getByText } = render(EmptyState, {
			title: "No projects yet",
			description: "Create one to get started.",
		});
		expect(getByRole("heading", { name: "No projects yet" })).toBeInTheDocument();
		expect(getByText("Create one to get started.")).toBeInTheDocument();
	});

	test("renders an anchor CTA when ctaHref is provided", () => {
		const { getByRole } = render(EmptyState, {
			title: "Empty",
			description: "Go somewhere.",
			ctaLabel: "Create project",
			ctaHref: "/projects/new",
		});
		const link = getByRole("link", { name: "Create project" });
		expect(link).toHaveAttribute("href", "/projects/new");
	});

	test("renders a button CTA that calls ctaOnclick when ctaHref is absent", async () => {
		const onclick = vi.fn();
		const { getByRole } = render(EmptyState, {
			title: "Empty",
			description: "Do something.",
			ctaLabel: "Do it",
			ctaOnclick: onclick,
		});
		const btn = getByRole("button", { name: "Do it" });
		await fireEvent.click(btn);
		expect(onclick).toHaveBeenCalledTimes(1);
	});

	test("renders no CTA when neither ctaHref nor ctaOnclick is provided", () => {
		const { queryByRole } = render(EmptyState, {
			title: "Empty",
			description: "Just text.",
		});
		expect(queryByRole("button")).toBeNull();
		expect(queryByRole("link")).toBeNull();
	});

	test("anchor takes precedence over onclick when both are provided", () => {
		const onclick = vi.fn();
		const { getByRole, queryByRole } = render(EmptyState, {
			title: "Empty",
			description: "Both set.",
			ctaLabel: "Go",
			ctaHref: "/x",
			ctaOnclick: onclick,
		});
		// Anchor branch wins; no button rendered.
		expect(getByRole("link", { name: "Go" })).toBeInTheDocument();
		expect(queryByRole("button")).toBeNull();
	});
});
