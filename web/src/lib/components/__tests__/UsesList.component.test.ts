/**
 * DOM tests for UsesList (Phase 4 §5.3): read-only "Uses" chips from
 * manifest.dependencies on the extension detail page.
 */
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/svelte";
import { describe, test, expect } from "vitest";
import UsesList from "../extensions/UsesList.svelte";

describe("UsesList", () => {
	test("renders nothing when dependencies are absent / empty", () => {
		const empty = render(UsesList, { props: { dependencies: {} } });
		expect(empty.queryByTestId("extension-uses-list")).toBeNull();

		const nullDeps = render(UsesList, { props: { dependencies: null } });
		expect(nullDeps.queryByTestId("extension-uses-list")).toBeNull();
	});

	test("renders nothing with the default prop (no dependencies passed)", () => {
		const { queryByTestId } = render(UsesList, { props: {} });
		expect(queryByTestId("extension-uses-list")).toBeNull();
	});

	test("renders a chip per dependency with name + version, name-sorted", () => {
		const { getByTestId, getAllByTestId } = render(UsesList, {
			props: {
				dependencies: {
					"web-search": { source: "bundled", version: "^1.0.0" },
					"ai-kit": { source: "bundled", version: "^0.1.0" },
				},
			},
		});
		expect(getByTestId("extension-uses-list")).toBeInTheDocument();
		const chips = getAllByTestId("extension-uses-chip");
		expect(chips).toHaveLength(2);
		// Name-sorted: ai-kit before web-search.
		expect(chips[0]!.getAttribute("data-dep-name")).toBe("ai-kit");
		expect(chips[0]!).toHaveTextContent("ai-kit");
		expect(chips[0]!).toHaveTextContent("^0.1.0");
		expect(chips[1]!.getAttribute("data-dep-name")).toBe("web-search");
	});

	test("a dependency with no version renders just the name", () => {
		const { getByTestId } = render(UsesList, {
			props: { dependencies: { "ai-kit": { source: "bundled" } } },
		});
		const chip = getByTestId("extension-uses-chip");
		expect(chip).toHaveTextContent("ai-kit");
	});
});
