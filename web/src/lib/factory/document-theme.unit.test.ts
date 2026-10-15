import { describe, expect, test } from "vitest";
import { observeDocumentDark } from "./document-theme";

/** Lets the real MutationObserver deliver its records. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("observeDocumentDark", () => {
	test("reports the current theme now, then each change of the dark class, until unsubscribed", async () => {
		const root = document.createElement("div");
		root.classList.add("dark");
		const seen: boolean[] = [];
		const stop = observeDocumentDark(isDark => seen.push(isDark), root);
		expect(seen).toEqual([true]);
		root.classList.remove("dark");
		await settle();
		root.classList.add("dark");
		await settle();
		// Another attribute is not a theme change.
		root.setAttribute("data-other", "x");
		await settle();
		expect(seen).toEqual([true, false, true]);
		stop();
		root.classList.remove("dark");
		await settle();
		expect(seen).toEqual([true, false, true]);
	});

	test("reads the document root by default", () => {
		document.documentElement.classList.remove("dark");
		const seen: boolean[] = [];
		observeDocumentDark(isDark => seen.push(isDark))();
		expect(seen).toEqual([false]);
	});
});
