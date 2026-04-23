/**
 * DOM tests for Breadcrumb.svelte. Covers ordered-list structure, separator
 * rendering between items, and the anchor-vs-plain-span branch logic:
 * items with an href before the last slot render as links; the final item
 * always renders as plain text even if it carries an href.
 */

import { render, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach } from "vitest";
import Breadcrumb from "./Breadcrumb.svelte";

afterEach(() => cleanup());

describe("Breadcrumb", () => {
	test("renders the nav with accessible Breadcrumb label", () => {
		const { getByRole } = render(Breadcrumb, {
			items: [{ label: "Home", href: "/" }, { label: "Projects" }],
		});
		expect(getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
	});

	test("renders every item label in order", () => {
		const { container } = render(Breadcrumb, {
			items: [
				{ label: "Home", href: "/" },
				{ label: "Projects", href: "/projects" },
				{ label: "ez-corp-ai" },
			],
		});
		const lis = Array.from(container.querySelectorAll("li"));
		// 3 items + 2 separator lis = 5 total.
		expect(lis.length).toBe(5);
		const labels = lis.map((li) => li.textContent?.trim()).filter((t) => t !== "/");
		expect(labels).toEqual(["Home", "Projects", "ez-corp-ai"]);
	});

	test("inserts a '/' separator between items but not before the first", () => {
		const { container } = render(Breadcrumb, {
			items: [{ label: "A", href: "/a" }, { label: "B", href: "/b" }, { label: "C" }],
		});
		const separators = Array.from(container.querySelectorAll("li[aria-hidden='true']"));
		expect(separators.length).toBe(2);
		for (const sep of separators) expect(sep.textContent?.trim()).toBe("/");
	});

	test("items with href render as <a> when they are not the last", () => {
		const { getByRole } = render(Breadcrumb, {
			items: [
				{ label: "Home", href: "/" },
				{ label: "Projects", href: "/projects" },
				{ label: "Leaf" },
			],
		});
		expect(getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
		expect(getByRole("link", { name: "Projects" })).toHaveAttribute("href", "/projects");
	});

	test("last item renders as plain span even with href", () => {
		const { queryByRole, getByText } = render(Breadcrumb, {
			items: [
				{ label: "Home", href: "/" },
				{ label: "Current", href: "/current" },
			],
		});
		// "Home" is a link, "Current" is not — even though it has an href.
		expect(queryByRole("link", { name: "Current" })).toBeNull();
		expect(getByText("Current")).toBeInTheDocument();
	});

	test("single-item crumb has no separators and no link", () => {
		const { container, queryByRole } = render(Breadcrumb, {
			items: [{ label: "Solo" }],
		});
		expect(container.querySelector("li[aria-hidden='true']")).toBeNull();
		expect(queryByRole("link")).toBeNull();
	});
});
