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

	// ── Regression: ping-pong loop when multiple dock-mode cards exist ──
	//
	// Both ToolCallCard and InlineToolCard wrap their `openDock` schedule
	// in a `firedOnce` guard so each card claims the dock at most once.
	// Without this guard, when a conversation has TWO dock-mode tool calls
	// in scrollback (e.g. two `open-canvas` invocations), each card's
	// reactive `$effect` re-runs whenever `store.dockState` changes and
	// schedules `openDock(self)`, causing the dock content to oscillate
	// forever between the two drafts.
	//
	// We can't render Svelte components under bun:test, but we can mirror
	// the guard contract to lock the invariant: a "card simulator" that
	// fires `openDock` AT MOST ONCE per instance, and an assertion that
	// after both simulators run + observe dockState changes, the dock
	// settles deterministically rather than ping-ponging.
	test("regression: cards mounted already-complete (page reload) do not auto-claim", () => {
		// Mirrors the ToolCallCard / InlineToolCard guard:
		// `if (initialStatus === "complete") return;`. On reload, every dock-
		// mode tool call in scrollback would otherwise schedule openDock(self),
		// cycling the dock through each historical canvas. The fix routes the
		// initial-mount restore through DockHost (which picks the latest call)
		// and skips per-card auto-open for cards that mounted already-complete.
		const m = new DockMirror(storage, win, false);

		function makeCardOnReload(_toolCallId: string, _initialStatus: "complete" | "running") {
			let firedOnce = false;
			return function maybeClaim() {
				// Guard 1: skip if mounted already-complete (the new behavior).
				if (_initialStatus === "complete") return false;
				// Guard 2: fire-once.
				if (firedOnce) return false;
				m.openDock("conv-1", _toolCallId);
				firedOnce = true;
				return true;
			};
		}

		// Three historical dock-mode cards, all already-complete on mount.
		const cardA = makeCardOnReload("tc-A", "complete");
		const cardB = makeCardOnReload("tc-B", "complete");
		const cardC = makeCardOnReload("tc-C", "complete");

		// None should claim the dock — DockHost's effect handles initial mount.
		expect(cardA()).toBe(false);
		expect(cardB()).toBe(false);
		expect(cardC()).toBe(false);
		expect(m.dockState["conv-1"]).toBeUndefined();
	});

	test("layout reservedDockPx: sized to dock when open + chat route + desktop, else 0", () => {
		// Mirrors `(app)/+layout.svelte`'s `reservedDockPx` derived:
		//   - 0 on non-chat routes (no convId in URL).
		//   - 0 when no dock open in the active conversation.
		//   - 0 on mobile viewports (dock fully overlays).
		//   - dockSizePx otherwise.
		// Without the responsive padding, DockHost (position: fixed) would
		// overlay the chat content and the user couldn't see both.
		function reservedDockPx(args: {
			activeChatConvId: string | null;
			dockOpenForConv: string | null;
			isMobile: boolean;
			dockSizePx: number;
		}): number {
			if (!args.activeChatConvId) return 0;
			if (args.dockOpenForConv !== args.activeChatConvId) return 0;
			if (args.isMobile) return 0;
			return args.dockSizePx;
		}

		// Non-chat route: zero.
		expect(
			reservedDockPx({
				activeChatConvId: null,
				dockOpenForConv: "conv-1",
				isMobile: false,
				dockSizePx: 700,
			}),
		).toBe(0);

		// Chat route, dock not open: zero.
		expect(
			reservedDockPx({
				activeChatConvId: "conv-1",
				dockOpenForConv: null,
				isMobile: false,
				dockSizePx: 700,
			}),
		).toBe(0);

		// Chat route, dock open in DIFFERENT conv: zero (we're not on that chat).
		expect(
			reservedDockPx({
				activeChatConvId: "conv-1",
				dockOpenForConv: "conv-2",
				isMobile: false,
				dockSizePx: 700,
			}),
		).toBe(0);

		// Chat route, dock open, mobile: zero (overlay).
		expect(
			reservedDockPx({
				activeChatConvId: "conv-1",
				dockOpenForConv: "conv-1",
				isMobile: true,
				dockSizePx: 700,
			}),
		).toBe(0);

		// Chat route, dock open, desktop: dockSizePx.
		expect(
			reservedDockPx({
				activeChatConvId: "conv-1",
				dockOpenForConv: "conv-1",
				isMobile: false,
				dockSizePx: 700,
			}),
		).toBe(700);
	});

	test("DockHost picks the latest dock-mode complete call when none is open", () => {
		// Mirrors DockHost's hydration effect: on mount, if no slot is open,
		// scan inlineToolStore for dock-mode complete calls in this conv and
		// pick the one with the latest (startedAt + duration).
		interface FakeCall {
			id: string;
			cardLayout?: "inline" | "dock";
			status: "running" | "complete" | "error";
			startedAt: number;
			duration?: number;
		}
		const calls: FakeCall[] = [
			{ id: "tc-old", cardLayout: "dock", status: "complete", startedAt: 1000, duration: 500 },
			{ id: "tc-mid", cardLayout: "dock", status: "complete", startedAt: 2000, duration: 800 },
			{ id: "tc-running", cardLayout: "dock", status: "running", startedAt: 3000 },
			{ id: "tc-inline", cardLayout: "inline", status: "complete", startedAt: 2500, duration: 100 },
			{ id: "tc-latest", cardLayout: "dock", status: "complete", startedAt: 4000, duration: 200 },
		];
		const candidates = calls.filter(
			(c) => c.cardLayout === "dock" && c.status === "complete" && c.id,
		);
		const latest = candidates.reduce((best, cur) => {
			const bestT = (best.startedAt ?? 0) + (best.duration ?? 0);
			const curT = (cur.startedAt ?? 0) + (cur.duration ?? 0);
			return curT >= bestT ? cur : best;
		});
		expect(latest.id).toBe("tc-latest");
	});

	// ── validation: feature coverage gap-fills ─────────────────────────
	test("validation: live completion (running → complete) DOES claim the dock", () => {
		// A card that mounted while still running — initialStatus = "running"
		// — should claim the dock the first time the openDock effect runs
		// after the call flips to complete. This is the ping-pong fix's
		// inverse: skip-on-mount-complete must NOT regress live-claiming.
		const m = new DockMirror(storage, win, false);
		function makeCardLive(toolCallId: string, initialStatus: "running" | "complete") {
			let firedOnce = false;
			let status: "running" | "complete" = initialStatus;
			return {
				flipComplete(): void { status = "complete"; },
				maybeClaim(): boolean {
					// Same guards the real component runs.
					if (initialStatus === "complete") return false;
					if (firedOnce) return false;
					if (status !== "complete") return false;
					m.openDock("conv-1", toolCallId);
					firedOnce = true;
					return true;
				},
			};
		}
		const card = makeCardLive("tc-live-1", "running");
		// Effect runs while still running — no claim.
		expect(card.maybeClaim()).toBe(false);
		expect(m.dockState["conv-1"]).toBeUndefined();
		// Now the call completes; the effect re-runs and the card claims.
		card.flipComplete();
		expect(card.maybeClaim()).toBe(true);
		expect(m.dockState["conv-1"]?.toolCallId).toBe("tc-live-1");
		// Subsequent re-runs no-op (firedOnce + ping-pong guard).
		expect(card.maybeClaim()).toBe(false);
	});

	test("validation: two live completions in sequence — only the latest is open at the end", () => {
		// Two cards both mount running, both fire openDock when they
		// complete. Per-card firedOnce + the store's last-write-wins
		// semantics mean the dock settles on whichever fired SECOND. No
		// ping-pong because each card fires at most once.
		const m = new DockMirror(storage, win, false);
		function makeCardLive(toolCallId: string) {
			let firedOnce = false;
			return {
				maybeClaim(): boolean {
					if (firedOnce) return false;
					m.openDock("conv-1", toolCallId);
					firedOnce = true;
					return true;
				},
			};
		}
		const cardA = makeCardLive("tc-A");
		const cardB = makeCardLive("tc-B");
		// A completes first.
		expect(cardA.maybeClaim()).toBe(true);
		expect(m.dockState["conv-1"]?.toolCallId).toBe("tc-A");
		// Then B.
		expect(cardB.maybeClaim()).toBe(true);
		expect(m.dockState["conv-1"]?.toolCallId).toBe("tc-B");
		// A's effect re-runs because store changed — but firedOnce
		// short-circuits, no ping-pong.
		expect(cardA.maybeClaim()).toBe(false);
		expect(m.dockState["conv-1"]?.toolCallId).toBe("tc-B");
	});

	test("validation: dismissal is per-toolCallId — new tc-2 auto-opens after closing tc-1", () => {
		// Closing tc-1 marks ONLY tc-1 dismissed. A subsequent dock-mode
		// completion for tc-2 must clear the auto-open path, since the
		// dismissal set is keyed by toolCallId, not by conversation.
		const m = new DockMirror(storage, win, false);
		m.openDock("conv-1", "tc-1");
		m.closeDock("conv-1");
		expect(m.dismissedDocks["conv-1"]?.["tc-1"]).toBe(true);
		// New tc-2 arrives and is NOT in the dismissed set.
		expect(m.dismissedDocks["conv-1"]?.["tc-2"]).toBeUndefined();
		// Auto-open effect for tc-2 (mirrors DockHost: skip if dismissed).
		const dismissed = m.dismissedDocks["conv-1"]?.["tc-2"];
		if (!dismissed) m.openDock("conv-1", "tc-2");
		expect(m.dockState["conv-1"]?.toolCallId).toBe("tc-2");
		// And tc-1 stays dismissed.
		expect(m.dismissedDocks["conv-1"]?.["tc-1"]).toBe(true);
	});

	test("validation: clicking the chat-history pill for tc-1 reopens it (manual openDock clears dismissed flag)", () => {
		// The chat-history "Canvas open" pill calls openDock(conv, tc-1)
		// directly. openDock clears the dismissed flag for that toolCallId
		// so the manual reopen takes effect even after a prior close.
		const m = new DockMirror(storage, win, false);
		m.openDock("conv-1", "tc-1");
		m.closeDock("conv-1");
		expect(m.dismissedDocks["conv-1"]?.["tc-1"]).toBe(true);
		// Click the pill — manual reopen.
		m.openDock("conv-1", "tc-1");
		expect(m.dockState["conv-1"]?.toolCallId).toBe("tc-1");
		expect(m.dismissedDocks["conv-1"]?.["tc-1"]).toBeUndefined();
	});

	test("validation: reservedDockPx follows dockSizePx changes during drag", () => {
		// As the user drags the resize handle, setDockSize writes a new
		// value to the store; the layout's reservedDockPx pure derivation
		// must re-evaluate to that exact width (clamped) on each tick.
		function reservedDockPx(args: {
			activeChatConvId: string | null;
			dockOpenForConv: string | null;
			isMobile: boolean;
			dockSizePx: number;
		}): number {
			if (!args.activeChatConvId) return 0;
			if (args.dockOpenForConv !== args.activeChatConvId) return 0;
			if (args.isMobile) return 0;
			return args.dockSizePx;
		}
		const m = new DockMirror(storage, win, false);
		m.openDock("conv-1", "tc-1");
		const args = {
			activeChatConvId: "conv-1",
			dockOpenForConv: "conv-1",
			isMobile: false,
		} as const;
		// User drags from 500 → 600 → 800; layout follows each tick.
		m.setDockSize(500);
		expect(reservedDockPx({ ...args, dockSizePx: m.dockSizePx })).toBe(500);
		m.setDockSize(600);
		expect(reservedDockPx({ ...args, dockSizePx: m.dockSizePx })).toBe(600);
		m.setDockSize(800);
		expect(reservedDockPx({ ...args, dockSizePx: m.dockSizePx })).toBe(800);
		// Drag past the ceiling clamps; layout follows the clamp.
		m.setDockSize(99_999);
		const max = Math.round(win.innerWidth * 0.8);
		expect(m.dockSizePx).toBe(max);
		expect(reservedDockPx({ ...args, dockSizePx: m.dockSizePx })).toBe(max);
	});

	test("validation: navigating from chat → settings drops reservedDockPx to 0 (URL-driven, dock state unchanged)", () => {
		// reservedDockPx keys off the active chat convId. When the user
		// navigates away from /chat/[convId] the activeChatConvId derived
		// flips to null and reservation drops, even though the dock store
		// still has an open slot for that conversation.
		function reservedDockPx(args: {
			activeChatConvId: string | null;
			dockOpenForConv: string | null;
			isMobile: boolean;
			dockSizePx: number;
		}): number {
			if (!args.activeChatConvId) return 0;
			if (args.dockOpenForConv !== args.activeChatConvId) return 0;
			if (args.isMobile) return 0;
			return args.dockSizePx;
		}
		const m = new DockMirror(storage, win, false);
		m.openDock("conv-1", "tc-1");
		// On /chat/conv-1 — reserved = dockSizePx.
		expect(reservedDockPx({
			activeChatConvId: "conv-1",
			dockOpenForConv: "conv-1",
			isMobile: false,
			dockSizePx: m.dockSizePx,
		})).toBe(m.dockSizePx);
		// User navigates to /settings — activeChatConvId flips to null;
		// dock store is untouched.
		expect(m.dockState["conv-1"]?.toolCallId).toBe("tc-1");
		expect(reservedDockPx({
			activeChatConvId: null,
			dockOpenForConv: "conv-1",
			isMobile: false,
			dockSizePx: m.dockSizePx,
		})).toBe(0);
	});

	test("regression: two dock-mode cards do not ping-pong the dock", () => {
		const m = new DockMirror(storage, win, false);

		// Each card has its own `firedOnce` flag (component-local in the
		// real Svelte effect; emulated as a closure variable here).
		function makeCard(toolCallId: string) {
			let firedOnce = false;
			return function maybeClaim() {
				if (firedOnce) return false;
				const existing = m.dockState["conv-1"];
				if (existing?.toolCallId === toolCallId) return false;
				m.openDock("conv-1", toolCallId);
				firedOnce = true;
				return true;
			};
		}

		const cardT1 = makeCard("tc-1");
		const cardT2 = makeCard("tc-2");

		// Initial mount: both cards claim. T1 lands first, T2 takes over.
		expect(cardT1()).toBe(true); // T1 grabs the empty slot.
		expect(m.dockState["conv-1"]?.toolCallId).toBe("tc-1");
		expect(cardT2()).toBe(true); // T2 takes over.
		expect(m.dockState["conv-1"]?.toolCallId).toBe("tc-2");

		// Reactive re-run: dockState changed, both cards' effects
		// re-evaluate. Without firedOnce, T1 would re-claim because
		// existing.toolCallId !== "tc-1". With firedOnce, T1 short-circuits.
		expect(cardT1()).toBe(false);
		expect(cardT2()).toBe(false);

		// Final state stable on T2 — no ping-pong.
		expect(m.dockState["conv-1"]?.toolCallId).toBe("tc-2");
	});
});
