/**
 * DOM tests for DevBadge.svelte. Drives the onMount read of
 * document.documentElement.dataset: hidden when the dev indicator is absent,
 * and a visible pill (branch · commit) when present.
 */

import { render, cleanup } from "@testing-library/svelte";
import { afterEach, describe, expect, test } from "vitest";
import DevBadge from "./DevBadge.svelte";

function clearDataset() {
	const ds = document.documentElement.dataset;
	delete ds.devIndicator;
	delete ds.devBranch;
	delete ds.devCommit;
}

afterEach(() => {
	cleanup();
	clearDataset();
});

describe("DevBadge", () => {
	test("renders nothing when the dev indicator is absent", () => {
		const { queryByTestId } = render(DevBadge);
		expect(queryByTestId("dev-badge")).toBeNull();
	});

	test("renders a pill with branch · commit when the dev indicator is set", async () => {
		document.documentElement.dataset.devIndicator = "1";
		document.documentElement.dataset.devBranch = "feat/demo";
		document.documentElement.dataset.devCommit = "a1b2c3d";

		const { findByTestId } = render(DevBadge);
		const badge = await findByTestId("dev-badge");
		expect(badge).toBeInTheDocument();
		expect(badge).toHaveTextContent("feat/demo");
		expect(badge).toHaveTextContent("a1b2c3d");
	});
});
