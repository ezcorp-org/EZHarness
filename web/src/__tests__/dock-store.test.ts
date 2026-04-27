/**
 * Tests for the canvas-dock SDK's per-conversation slot mutations on AppStore.
 *
 * The real store uses Svelte 5 `$state` runes, which can't run under bare
 * `bun test` without the rune compiler. Following the project's established
 * pattern (see `inline-tool-store-upsert.test.ts`), we mirror the contract
 * in a plain class and exercise the same logic. The mirror MUST stay in
 * lockstep with the real `openDock` / `closeDock` / `setDockSize` /
 * `noteSidebarUserOverride` semantics in `web/src/lib/stores.svelte.ts`.
 *
 * Covered (canvas-dock-sdk.md §5 unit cases #1-7):
 *   1. openDock(c1, t1) sets the slot and force-collapses sidebar.
 *   2. openDock(c1, t2) replaces toolCallId without re-snapshotting prevSidebar.
 *   3. closeDock(c1) clears the slot + restores sidebar.
 *   4. Per-conversation isolation: c1 and c2 track independently.
 *   5. User-precedence: noteSidebarUserOverride sticks; close skips restore.
 *   6. setDockSize clamps to [320, viewportWidth*0.8] + writes localStorage.
 *   7. Hydration: AppStore reads localStorage on construction.
 */
import { test, expect, describe, beforeEach } from "bun:test";

interface DockSlot {
	toolCallId: string;
	previousSidebar: boolean;
	userOverrode: boolean;
}

class FakeStorage {
	data = new Map<string, string>();
	getItem(k: string): string | null { return this.data.has(k) ? this.data.get(k)! : null; }
	setItem(k: string, v: string): void { this.data.set(k, v); }
	removeItem(k: string): void { this.data.delete(k); }
}

interface FakeWindow { innerWidth: number }

/**
 * Plain mirror of the AppStore's dock surface. Keep in sync with
 * web/src/lib/stores.svelte.ts.
 */
class DockMirror {
	dockState: Record<string, DockSlot> = {};
	dismissedDocks: Record<string, Record<string, true>> = {};
	sidebarCollapsed: boolean;
	dockSizePx: number;

	constructor(
		private storage: FakeStorage,
		private win: FakeWindow,
		initSidebar: boolean,
	) {
		this.sidebarCollapsed = initSidebar;
		// Hydration mirror of `_initDockSizePx`.
		const stored = storage.getItem("ezcorp-dock-size-px");
		const parsed = stored ? parseInt(stored, 10) : NaN;
		this.dockSizePx = Number.isFinite(parsed) && parsed > 0 ? parsed : Math.round(win.innerWidth * 0.5);
	}

	openDock(conversationId: string, toolCallId: string): void {
		// Manual or auto open clears any prior dismissal for this id so
		// the chat-history pill click is a real reopen, not a no-op.
		const dismissed = this.dismissedDocks[conversationId];
		if (dismissed && dismissed[toolCallId]) {
			const { [toolCallId]: _drop, ...remaining } = dismissed;
			this.dismissedDocks = { ...this.dismissedDocks, [conversationId]: remaining };
		}
		const existing = this.dockState[conversationId];
		if (existing && existing.toolCallId === toolCallId) {
			this.storage.setItem(`ezcorp-dock-state-${conversationId}`, JSON.stringify({ toolCallId, lastOpenedAt: 1 }));
			return;
		}
		const previousSidebar = existing?.previousSidebar ?? this.sidebarCollapsed;
		const userOverrode = existing?.userOverrode ?? false;
		this.dockState = { ...this.dockState, [conversationId]: { toolCallId, previousSidebar, userOverrode } };
		if (!this.sidebarCollapsed) {
			this.sidebarCollapsed = true;
			this.storage.setItem("pi-sidebar-collapsed", "true");
		}
		this.storage.setItem(`ezcorp-dock-state-${conversationId}`, JSON.stringify({ toolCallId, lastOpenedAt: 1 }));
	}

	closeDock(conversationId: string): void {
		const slot = this.dockState[conversationId];
		if (!slot) return;
		const { [conversationId]: _r, ...rest } = this.dockState;
		this.dockState = rest;
		const prev = this.dismissedDocks[conversationId] ?? {};
		this.dismissedDocks = { ...this.dismissedDocks, [conversationId]: { ...prev, [slot.toolCallId]: true } };
		if (!slot.userOverrode && this.sidebarCollapsed !== slot.previousSidebar) {
			this.sidebarCollapsed = slot.previousSidebar;
			this.storage.setItem("pi-sidebar-collapsed", String(slot.previousSidebar));
		}
		this.storage.removeItem(`ezcorp-dock-state-${conversationId}`);
	}

	noteSidebarUserOverride(): void {
		const next: Record<string, DockSlot> = {};
		let mutated = false;
		for (const [k, slot] of Object.entries(this.dockState)) {
			if (!slot.userOverrode) {
				next[k] = { ...slot, userOverrode: true };
				mutated = true;
			} else next[k] = slot;
		}
		if (mutated) this.dockState = next;
	}

	setDockSize(px: number): void {
		if (!Number.isFinite(px)) return;
		const min = 320;
		const max = Math.round(this.win.innerWidth * 0.8);
		const clamped = Math.max(min, Math.min(max, Math.round(px)));
		this.dockSizePx = clamped;
		this.storage.setItem("ezcorp-dock-size-px", String(clamped));
	}
}

let storage: FakeStorage;
let win: FakeWindow;

beforeEach(() => {
	storage = new FakeStorage();
	win = { innerWidth: 1600 };
});

describe("dock store", () => {
	test("openDock(c1, t1) sets dockState[c1] = {toolCallId: t1, previousSidebar} and forces sidebarCollapsed = true", () => {
		const m = new DockMirror(storage, win, false);
		m.openDock("conv-1", "tc-1");
		expect(m.dockState["conv-1"]).toEqual({ toolCallId: "tc-1", previousSidebar: false, userOverrode: false });
		expect(m.sidebarCollapsed).toBe(true);
		expect(storage.getItem("pi-sidebar-collapsed")).toBe("true");
		expect(storage.getItem("ezcorp-dock-state-conv-1")).toContain("tc-1");
	});

	test("openDock(c1, t2) while c1 already has t1 replaces toolCallId WITHOUT re-snapshotting previousSidebar", () => {
		const m = new DockMirror(storage, win, false);
		m.openDock("conv-1", "tc-1");
		// User manually re-expanded the sidebar … but we don't actually flip it
		// here since the test focus is the snapshot. Instead, just verify the
		// 2nd open keeps the original `previousSidebar`.
		m.sidebarCollapsed = false; // simulate (not via toggle)
		m.openDock("conv-1", "tc-2");
		expect(m.dockState["conv-1"]?.toolCallId).toBe("tc-2");
		// Original previousSidebar (false) is preserved across the replace.
		expect(m.dockState["conv-1"]?.previousSidebar).toBe(false);
	});

	test("closeDock(c1) clears state and restores sidebarCollapsed to the snapshot", () => {
		const m = new DockMirror(storage, win, false);
		m.openDock("conv-1", "tc-1");
		expect(m.sidebarCollapsed).toBe(true);
		m.closeDock("conv-1");
		expect(m.dockState["conv-1"]).toBeUndefined();
		expect(m.sidebarCollapsed).toBe(false);
		expect(storage.getItem("ezcorp-dock-state-conv-1")).toBeNull();
	});

	test("per-conversation isolation: openDock(c1, t1) and openDock(c2, t2) track independently", () => {
		const m = new DockMirror(storage, win, true);
		m.openDock("conv-1", "tc-1");
		m.openDock("conv-2", "tc-2");
		expect(m.dockState["conv-1"]?.toolCallId).toBe("tc-1");
		expect(m.dockState["conv-2"]?.toolCallId).toBe("tc-2");
		m.closeDock("conv-1");
		expect(m.dockState["conv-1"]).toBeUndefined();
		expect(m.dockState["conv-2"]?.toolCallId).toBe("tc-2");
	});

	test("user-precedence: manual sidebar toggle while dock open → closeDock does NOT reset", () => {
		const m = new DockMirror(storage, win, false);
		m.openDock("conv-1", "tc-1"); // snapshots prev=false, forces collapsed=true
		// User manually toggles the sidebar — host calls noteSidebarUserOverride
		// FIRST then mutates sidebarCollapsed. Mirror that order.
		m.noteSidebarUserOverride();
		m.sidebarCollapsed = false; // user expanded
		expect(m.dockState["conv-1"]?.userOverrode).toBe(true);
		// Now close. With userOverrode, restore must be a no-op.
		m.closeDock("conv-1");
		expect(m.sidebarCollapsed).toBe(false); // unchanged
	});

	test("setDockSize clamps to [320, viewportWidth*0.8] and writes localStorage", () => {
		const m = new DockMirror(storage, win, false);
		// Below floor → clamp up
		m.setDockSize(100);
		expect(m.dockSizePx).toBe(320);
		expect(storage.getItem("ezcorp-dock-size-px")).toBe("320");
		// Above ceiling (innerWidth=1600 → max=1280)
		m.setDockSize(5000);
		expect(m.dockSizePx).toBe(1280);
		expect(storage.getItem("ezcorp-dock-size-px")).toBe("1280");
		// Sane mid-range
		m.setDockSize(800);
		expect(m.dockSizePx).toBe(800);
		// NaN is a no-op
		m.setDockSize(NaN);
		expect(m.dockSizePx).toBe(800);
	});

	test("closeDock marks the toolCallId as dismissed; openDock clears the flag (prevents auto-reopen loop)", () => {
		const m = new DockMirror(storage, win, false);
		m.openDock("conv-1", "tc-1");
		expect(m.dismissedDocks["conv-1"]?.["tc-1"]).toBeUndefined();
		m.closeDock("conv-1");
		// closeDock writes the dismissed flag — auto-open effects must check this.
		expect(m.dismissedDocks["conv-1"]?.["tc-1"]).toBe(true);
		// Manual reopen via openDock (e.g. clicking the chat-history pill) clears it.
		m.openDock("conv-1", "tc-1");
		expect(m.dismissedDocks["conv-1"]?.["tc-1"]).toBeUndefined();
	});

	test("dismissals are per-toolCallId — a NEW dock-mode tool call still auto-opens after a prior close", () => {
		const m = new DockMirror(storage, win, false);
		m.openDock("conv-1", "tc-1");
		m.closeDock("conv-1");
		expect(m.dismissedDocks["conv-1"]?.["tc-1"]).toBe(true);
		// A different toolCallId — agent's next dock-mode completion — is unaffected.
		expect(m.dismissedDocks["conv-1"]?.["tc-2"]).toBeUndefined();
		m.openDock("conv-1", "tc-2");
		expect(m.dockState["conv-1"]?.toolCallId).toBe("tc-2");
		// And the old dismissal sticks for tc-1.
		expect(m.dismissedDocks["conv-1"]?.["tc-1"]).toBe(true);
	});

	test("hydration: store reads localStorage on construction and seeds dockSizePx", () => {
		storage.setItem("ezcorp-dock-size-px", "777");
		const m = new DockMirror(storage, win, false);
		expect(m.dockSizePx).toBe(777);
		// No localStorage value: falls back to 50% of viewport.
		const blank = new FakeStorage();
		const m2 = new DockMirror(blank, { innerWidth: 1000 }, false);
		expect(m2.dockSizePx).toBe(500);
	});
});
