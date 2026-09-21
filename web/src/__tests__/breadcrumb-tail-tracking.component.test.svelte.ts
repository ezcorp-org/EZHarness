/**
 * `setBreadcrumbTail` is called from a page `$effect` that should depend on
 * the page's SUBJECT only. SvelteKit backs `page.url` with `$state.raw`, so an
 * un-`untrack`ed pathname read inside the setter would make every naming
 * effect re-run on each navigation, before the new fetch lands, and re-tag the
 * previous subject onto the new path. This pins the fix with a reactive
 * `$app/state` stand-in; the plain unit test cannot observe tracking.
 */
import { describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import * as appState from "$app/state";
import { resolveBreadcrumbTail, setBreadcrumbTail } from "$lib/breadcrumb-tail.svelte.js";

vi.mock("$app/state", async () => await import("./stubs/reactive-app-state.svelte.js"));

const { navigate } = appState as unknown as { navigate(pathname: string): void };
const RUNS = "/(app)/runs/[id]";

describe("setBreadcrumbTail called from a page $effect", () => {
	it("does not re-run the caller's effect on navigation, so the old subject is dropped until the page names a new one", () => {
		let subject = $state<string | undefined>("agent-of-run-1");
		let runs = 0;
		navigate("/runs/1");
		const stop = $effect.root(() => {
			$effect(() => {
				runs++;
				setBreadcrumbTail(subject);
			});
		});
		flushSync();
		expect(runs).toBe(1);
		expect(resolveBreadcrumbTail(RUNS, "/runs/1", { id: "1" }, null)).toBe("agent-of-run-1");

		// Same route, new param. The page has NOT fetched run 2 yet, so `subject` is untouched.
		navigate("/runs/2");
		flushSync();
		expect(appState.page.url.pathname).toBe("/runs/2");
		expect(runs).toBe(1);
		expect(resolveBreadcrumbTail(RUNS, "/runs/2", { id: "2" }, null)).toBeNull();

		// The fetch lands: the effect runs once more and tags the new path.
		subject = "agent-of-run-2";
		flushSync();
		expect(runs).toBe(2);
		expect(resolveBreadcrumbTail(RUNS, "/runs/2", { id: "2" }, null)).toBe("agent-of-run-2");
		stop();
	});
});
