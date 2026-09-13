/**
 * DOM tests for UnsandboxedExtensionsBanner.svelte. The component is a pure
 * function of its `mode` prop — the app shell owns the /api/auth/me fetch —
 * so there is nothing to stub: render, look, unmount.
 */
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, test } from "vitest";
import UnsandboxedExtensionsBanner from "./UnsandboxedExtensionsBanner.svelte";

afterEach(() => {
	cleanup();
});

describe("UnsandboxedExtensionsBanner", () => {
	test("renders a standing alert for trusted-local, naming the fact and linking to the review page", () => {
		const { getByTestId, getByRole } = render(UnsandboxedExtensionsBanner, { props: { mode: "trusted-local" } });
		const banner = getByTestId("unsandboxed-extensions-banner");
		expect(banner.getAttribute("role")).toBe("alert");
		expect(banner.textContent).toContain("Extensions are not sandboxed on this host.");
		expect(banner.textContent).toContain("full powers");
		expect(getByRole("link", { name: "Review" }).getAttribute("href")).toBe("/extensions/author");
	});

	test("has no dismiss control — it is a standing fact about the host, not a notification", () => {
		const { queryByRole } = render(UnsandboxedExtensionsBanner, { props: { mode: "trusted-local" } });
		expect(queryByRole("button")).toBeNull();
	});

	test("renders nothing for the isolated host, before the fetch lands, or for an unexpected value", () => {
		for (const mode of ["isolated", null, "trusted-local-v4"]) {
			const { queryByTestId, unmount } = render(UnsandboxedExtensionsBanner, { props: { mode } });
			expect(queryByTestId("unsandboxed-extensions-banner")).toBeNull();
			unmount();
		}
	});
});
