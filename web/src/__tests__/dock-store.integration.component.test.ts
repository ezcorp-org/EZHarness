import { beforeEach, describe, expect, test } from "vitest";

import { closeDock, openDock, store } from "$lib/stores.svelte.js";

describe("dock store dismissal lifecycle", () => {
	beforeEach(() => {
		localStorage.clear();
		store.sidebarCollapsed = false;
		store.dockState = {};
		store.dismissedDocks = {};
	});

	test("manual reopen clears only its dismissed tool and preserves other dismissals", () => {
		openDock("conversation-a", "tool-reopen");
		expect(store.dockState["conversation-a"]).toEqual({
			toolCallId: "tool-reopen",
			previousSidebar: false,
			userOverrode: false,
		});
		expect(store.sidebarCollapsed).toBe(true);

		closeDock("conversation-a");
		expect(store.dockState["conversation-a"]).toBeUndefined();
		expect(store.sidebarCollapsed).toBe(false);
		expect(store.dismissedDocks["conversation-a"]?.["tool-reopen"]).toBe(true);

		store.dismissedDocks = {
			...store.dismissedDocks,
			"conversation-a": { ...store.dismissedDocks["conversation-a"], "tool-other": true },
			"conversation-b": { "tool-separate": true },
		};

		openDock("conversation-a", "tool-reopen");

		expect(store.dismissedDocks["conversation-a"]?.["tool-reopen"]).toBeUndefined();
		expect(store.dismissedDocks["conversation-a"]?.["tool-other"]).toBe(true);
		expect(store.dismissedDocks["conversation-b"]?.["tool-separate"]).toBe(true);
		expect(store.dockState["conversation-a"]?.toolCallId).toBe("tool-reopen");
	});
});
