/**
 * DOM tests for UnsandboxedExtensionsBanner.svelte. The component is a pure
 * function of its `mode` prop — the app shell owns the /api/auth/me fetch —
 * so there is nothing to stub: render, look, unmount.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, test } from "vitest";
import UnsandboxedExtensionsBanner from "./UnsandboxedExtensionsBanner.svelte";

// `import.meta.url` is an http URL under Vite; read from __dirname, as
// message-toolbar-parity.unit.test.ts does.
const read = (path: string): string => readFileSync(resolve(__dirname, path), "utf8");
const bannerSource = read("UnsandboxedExtensionsBanner.svelte");
const traySource = read("tool-cards/PendingDecisionsTray.svelte");
const layoutSource = read("../../routes/(app)/+layout.svelte");

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

/**
 * The banner used to be `position: fixed` at `bottom: 1rem; right: 1rem;
 * z-index: 60` — the exact anchor and stacking level `PendingDecisionsTray`
 * declares itself "the one bottom-right stack" for. The tray is 28rem wide
 * against this banner's 22rem and is mounted after it, so whenever any
 * approval or permission was pending the tray covered the standing warning
 * outright: its detail line and its Review link both disappeared, at exactly
 * the moment the warning mattered most.
 *
 * Playwright cannot catch that — `toBeVisible()` tests the box, not what is
 * painted over it — so the invariant is asserted on the source instead: the
 * banner lives in the document flow inside `<main>`, never in the overlay
 * layer the tray owns.
 */
describe("UnsandboxedExtensionsBanner — stays out of the overlay layer", () => {
	const bannerStyle = bannerSource.split("<style>")[1] ?? "";

	test("is sticky in flow, not fixed to a viewport corner", () => {
		expect(bannerStyle).toContain("position: sticky");
		expect(bannerStyle).not.toContain("position: fixed");
	});

	test("stacks below the tray it used to collide with", () => {
		const banner = Number(/z-index:\s*(\d+)/.exec(bannerStyle)?.[1]);
		const tray = Number(/z-\[(\d+)\]/.exec(traySource)?.[1]);
		expect(Number.isFinite(banner) && Number.isFinite(tray)).toBe(true);
		expect(banner).toBeLessThan(tray);
	});

	test("is mounted inside <main>, above the overlay stack in the app layout", () => {
		const mount = layoutSource.indexOf("<UnsandboxedExtensionsBanner");
		const mainClose = layoutSource.indexOf("</main>");
		const tray = layoutSource.indexOf("<PendingDecisionsTray");
		expect(mount).toBeGreaterThan(-1);
		expect(mount).toBeLessThan(mainClose);
		expect(mainClose).toBeLessThan(tray);
	});
});
