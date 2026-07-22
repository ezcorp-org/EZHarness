// Coverage for the bus→cache invalidation wiring (`ensurePageStateInvalidation`):
// the fix for edited extension pages serving their old tree as "fresh" for the
// full 60s TTL. The listener must attach to THIS module's page-cache singleton
// (the one renders are served from), drop every variant of the named page on an
// `ext:page-state` event, arm exactly once, and fail OPEN (retry on the next
// render) when the server context isn't initialized yet.
import { describe, test, expect, beforeEach, vi } from "vitest";
import {
	ensurePageStateInvalidation,
	__resetPageStateInvalidationForTests,
	renderExtensionPage,
	type RenderPullDeps,
} from "./hub-render-pull";
import { ExtensionPageCache, getPageCache } from "$server/extensions/page-cache";
import type { HubPageTree } from "$server/extensions/page-schema";
import type { Extension } from "$server/db/schema";

const { fakeBus, busState } = vi.hoisted(() => {
	const listeners: Array<(e: { extensionId: string; pageId: string }) => void> = [];
	const busState = { getBusThrows: false, getBusCalls: 0 };
	const fakeBus = {
		listeners,
		on(_type: string, fn: (e: { extensionId: string; pageId: string }) => void): () => void {
			listeners.push(fn);
			return () => {};
		},
		emit(e: { extensionId: string; pageId: string }): void {
			for (const fn of listeners) fn(e);
		},
	};
	return { fakeBus, busState };
});

vi.mock("$lib/server/context", () => ({
	getBus: () => {
		busState.getBusCalls += 1;
		if (busState.getBusThrows) throw new Error("Server not initialized");
		return fakeBus;
	},
}));

const TREE: HubPageTree = { title: "T", nodes: [] };

beforeEach(() => {
	__resetPageStateInvalidationForTests();
	fakeBus.listeners.length = 0;
	busState.getBusThrows = false;
	busState.getBusCalls = 0;
	// The listener targets the process-wide singleton — clear it between tests.
	getPageCache().clear();
});

describe("ensurePageStateInvalidation", () => {
	test("an ext:page-state event drops EVERY cached variant of that page from the singleton", async () => {
		await ensurePageStateInvalidation();
		getPageCache().set("ext-9", "dashboard", TREE, "");
		getPageCache().set("ext-9", "dashboard", TREE, "p1:view:job:default");
		getPageCache().set("ext-9", "other-page", TREE, "");
		expect(getPageCache().get("ext-9", "dashboard", "p1:view:job:default")).not.toBeNull();

		fakeBus.emit({ extensionId: "ext-9", pageId: "dashboard" });

		expect(getPageCache().get("ext-9", "dashboard", "")).toBeNull();
		expect(getPageCache().get("ext-9", "dashboard", "p1:view:job:default")).toBeNull();
		// Unrelated pages are untouched — the invalidation is page-scoped.
		expect(getPageCache().get("ext-9", "other-page", "")).not.toBeNull();
	});

	test("arms exactly once — repeat calls add no second listener", async () => {
		await ensurePageStateInvalidation();
		await ensurePageStateInvalidation();
		expect(fakeBus.listeners).toHaveLength(1);
		expect(busState.getBusCalls).toBe(1);
	});

	test("fails open before context init: retries and arms on the next call", async () => {
		busState.getBusThrows = true;
		await ensurePageStateInvalidation();
		expect(fakeBus.listeners).toHaveLength(0);

		busState.getBusThrows = false;
		await ensurePageStateInvalidation();
		expect(fakeBus.listeners).toHaveLength(1);
	});
});

describe("renderExtensionPage arms the invalidation wiring", () => {
	const EXT = {
		id: "ext-1",
		name: "ez-code-factory",
		grantedPermissions: { eventSubscriptions: [] },
	} as unknown as Extension;

	function makeDeps(): Partial<RenderPullDeps> {
		return {
			findPage: async () => ({
				extension: EXT,
				page: { id: "dashboard", title: "ez-code-factory", perProject: true },
			}),
			callPage: async () => ({ jsonrpc: "2.0" as const, id: 1, result: TREE }),
			cache: new ExtensionPageCache(),
			timeoutMs: 1000,
		};
	}

	test("a render subscribes the bus listener before caching (and only once)", async () => {
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", makeDeps());
		expect(fakeBus.listeners).toHaveLength(1);
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", makeDeps());
		expect(fakeBus.listeners).toHaveLength(1);
	});
});
