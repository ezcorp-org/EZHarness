/**
 * Integration test: the stick-to-bottom gate threaded through the realistic
 * ResizeObserver + rAF + scroll lifecycle, against a fake scroll container.
 *
 * `Sim` below mirrors ChatThread.svelte's stickObserver call site EXACTLY:
 *
 *   stickObserver = new ResizeObserver(() => {
 *     if (!shouldStickToBottom({
 *       initialScrollDone, rafPending,
 *       anchorWatchActive: stopAnchorWatch !== null,
 *       stuck,
 *     })) return;
 *     rafPending = true;
 *     requestAnimationFrame(() => { rafPending = false; el.scrollTop = el.scrollHeight; });
 *   });
 *
 * …and ChatThread's persist `onScroll`, which is the ONLY thing that sets
 * `stuck`:  stuck = bottomSlack(el) < STICK_TO_BOTTOM_THRESHOLD_PX.
 *
 * So any drift between the helper module and the component would show up
 * here (same strategy as chat-scroll-restore.integration.test.ts). The
 * scenarios walk the real user lifecycle: open (deferred) → streaming
 * growth → user scrolls up → jump-to-bottom → anchor-restore → restore
 * ends → turn-completion large insert → the observer-ordering regression.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
	shouldStickToBottom,
	bottomSlack,
	STICK_TO_BOTTOM_THRESHOLD_PX,
} from "$lib/chat-stick-to-bottom.js";

/** A minimal stand-in for the scrollable chat container. */
class FakeContainer {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
	constructor(scrollHeight: number, scrollTop: number, clientHeight: number) {
		this.scrollHeight = scrollHeight;
		this.scrollTop = scrollTop;
		this.clientHeight = clientHeight;
	}
	/** Content grows by `px` below the fold (a token chunk / tool card). */
	grow(px: number) {
		this.scrollHeight += px;
	}
	get slack() {
		return bottomSlack(this);
	}
}

/**
 * Verbatim model of the stickObserver call site + ChatThread's scroll
 * bookkeeping. `pendingRaf` holds the queued frame callback so a test can
 * flush it deterministically (mirrors the browser firing the rAF).
 */
class Sim {
	el: FakeContainer;
	initialScrollDone = false;
	/** Synchronous follow intent — ChatThread's `let stuck = $state(true)`. */
	stuck = true;
	stopAnchorWatch: (() => void) | null = null;
	rafPending = false;
	pinCount = 0;
	private pendingRaf: (() => void) | null = null;

	constructor(el: FakeContainer) {
		this.el = el;
	}

	/** ChatThread.onScroll: every real scroll re-decides `stuck`. */
	private onScroll() {
		this.stuck = bottomSlack(this.el) < STICK_TO_BOTTOM_THRESHOLD_PX;
	}

	/** The user drags the scrollbar to `top` (fires a real scroll). */
	userScrollTo(top: number) {
		this.el.scrollTop = top;
		this.onScroll();
	}

	/** Park at the bottom via a real scroll (open-restore-to-bottom path). */
	scrollToBottom() {
		this.el.scrollTop = this.el.scrollHeight - this.el.clientHeight;
		this.onScroll();
	}

	/** Jump-to-bottom button: sets `stuck` directly THEN scrolls. */
	jumpToBottom() {
		this.stuck = true; // ChatThread onclick sets stuck=true synchronously
		this.el.scrollTop = this.el.scrollHeight - this.el.clientHeight;
		this.onScroll();
	}

	/** Open-restore to a non-bottom anchor: ChatThread sets stuck=false. */
	restoreToNonBottom(top: number) {
		this.el.scrollTop = top;
		this.stuck = false; // the synchronous guard in the restore branch
	}

	/**
	 * The bottom-sentinel IntersectionObserver firing (sentinel left the
	 * viewport because content grew). Under the fix this is a NO-OP for the
	 * pin decision — it only ever drove the old async `userScrolledUp` flag,
	 * which is now jump-button-visibility only. Kept so the regression test
	 * can prove ResizeObserver/IntersectionObserver ordering is irrelevant.
	 */
	sentinelLeftViewport() {
		/* intentionally does NOT touch `stuck` */
	}

	/** One ResizeObserver callback invocation (a resize tick). */
	resizeTick() {
		if (
			!shouldStickToBottom({
				initialScrollDone: this.initialScrollDone,
				rafPending: this.rafPending,
				anchorWatchActive: this.stopAnchorWatch !== null,
				stuck: this.stuck,
			})
		) {
			return;
		}
		this.rafPending = true;
		this.pendingRaf = () => {
			this.rafPending = false;
			this.el.scrollTop = this.el.scrollHeight;
			// The programmatic pin fires a scroll in the browser → onScroll
			// re-classifies as stuck (we're at the bottom).
			this.onScroll();
			this.pinCount += 1;
		};
	}

	/** The browser servicing the queued animation frame. */
	flushRaf() {
		const cb = this.pendingRaf;
		this.pendingRaf = null;
		cb?.();
	}

	atBottom() {
		return this.el.slack <= 0;
	}
}

describe("chat-stick-to-bottom — integration with the observer/rAF lifecycle", () => {
	let el: FakeContainer;
	let sim: Sim;

	beforeEach(() => {
		// 2400px of content, viewport 800px, parked at the very bottom.
		el = new FakeContainer(2400, 1600, 800);
		sim = new Sim(el);
	});

	test("full lifecycle: deferred open → stream growth → scroll up → jump → anchor restore → restore ends", () => {
		// 1. Open: scroll-restore hasn't decided yet. A reflow tick must be a
		//    no-op so it can't fight scroll-restore.
		el.grow(120);
		sim.resizeTick();
		sim.flushRaf();
		expect(sim.pinCount).toBe(0);
		expect(sim.atBottom()).toBe(false); // still where restore will place it

		// 2. Open decided "scroll-to-bottom": initial position settled.
		sim.initialScrollDone = true;
		sim.scrollToBottom(); // restore put us at bottom (fires onScroll)
		expect(sim.atBottom()).toBe(true);
		expect(sim.stuck).toBe(true);

		// 3. Streaming: tokens grow the bubble across several ticks — stays glued.
		for (let i = 0; i < 5; i++) {
			el.grow(90);
			sim.resizeTick();
			sim.flushRaf();
			expect(sim.atBottom()).toBe(true);
		}
		expect(sim.pinCount).toBe(5);

		// 4. User drags up to read — scroll handler flips `stuck` false
		//    synchronously. More tokens arrive — must NOT yank the reader.
		sim.userScrollTo(400);
		expect(sim.stuck).toBe(false);
		const readingTop = el.scrollTop;
		el.grow(300);
		sim.resizeTick();
		sim.flushRaf();
		expect(el.scrollTop).toBe(readingTop);
		expect(sim.atBottom()).toBe(false);
		expect(sim.pinCount).toBe(5); // unchanged

		// 5. User hits jump-to-bottom: stuck set true + parked at bottom.
		sim.jumpToBottom();
		el.grow(150); // next chunk
		sim.resizeTick();
		sim.flushRaf();
		expect(sim.atBottom()).toBe(true);
		expect(sim.pinCount).toBe(6);

		// 6. Switch away & back to a non-bottom cached position: the
		//    open-restore anchor watch is active and the restore guard set
		//    stuck=false. Reflows during restore must NOT pin (mutually
		//    exclusive — else the anchor watch's onScroll trips).
		sim.stopAnchorWatch = () => {};
		sim.restoreToNonBottom(900);
		const restoredTop = el.scrollTop;
		el.grow(250); // image/tool-card reflow above the fold during restore
		sim.resizeTick();
		sim.flushRaf();
		expect(el.scrollTop).toBe(restoredTop);
		expect(sim.pinCount).toBe(6); // unchanged — stick stood down

		// 7. Anchor watch ends (3s elapsed / converged). If the user is now
		//    following the bottom again, sticking resumes.
		sim.stopAnchorWatch = null;
		sim.scrollToBottom();
		el.grow(80);
		sim.resizeTick();
		sim.flushRaf();
		expect(sim.atBottom()).toBe(true);
		expect(sim.pinCount).toBe(7);
	});

	test("rafPending coalesces a burst of synchronous resize ticks into one pin", () => {
		sim.initialScrollDone = true;
		sim.scrollToBottom();

		// A burst of RO callbacks before the browser services any frame
		// (markdown + KaTeX + image all resizing in the same task).
		el.grow(40);
		sim.resizeTick();
		el.grow(40);
		sim.resizeTick();
		el.grow(40);
		sim.resizeTick();
		expect(sim.rafPending).toBe(true);
		expect(sim.pinCount).toBe(0); // nothing pinned until the frame runs

		sim.flushRaf(); // browser services the single queued frame
		expect(sim.pinCount).toBe(1); // coalesced
		expect(sim.atBottom()).toBe(true);

		// A later resize after the frame schedules a fresh pin.
		el.grow(40);
		sim.resizeTick();
		sim.flushRaf();
		expect(sim.pinCount).toBe(2);
	});

	test("turn-completion: a single large insert while following still pins", () => {
		sim.initialScrollDone = true;
		sim.scrollToBottom();
		expect(sim.atBottom()).toBe(true);
		expect(sim.stuck).toBe(true);

		// run:complete → loadMessages()+hydrate replaces the stream bubble
		// with the finalized message + historical tool/agent/memory cards in
		// one shot (slack jumps far past the threshold). No scroll happened,
		// so `stuck` is still true → the gate must re-pin.
		el.grow(900);
		expect(el.slack).toBeGreaterThan(80);
		sim.resizeTick();
		sim.flushRaf();
		expect(sim.atBottom()).toBe(true);
		expect(sim.pinCount).toBe(1);
	});

	test("a stream on a conversation we never finished opening (no initialScrollDone) never pins", () => {
		// Guards the scroll-restore invariant: until the open decision is
		// made, no amount of streaming growth may move the viewport.
		for (let i = 0; i < 4; i++) {
			el.grow(120);
			sim.resizeTick();
			sim.flushRaf();
		}
		expect(sim.pinCount).toBe(0);
	});

	test("REGRESSION: bottom-sentinel IntersectionObserver firing BEFORE the resize pin on a turn-completion insert no longer breaks the pin", () => {
		sim.initialScrollDone = true;
		sim.scrollToBottom();
		expect(sim.atBottom()).toBe(true);
		expect(sim.stuck).toBe(true);

		// run:complete inserts the finalized turn (>80px) in one task. In a
		// real browser the bottom-sentinel IntersectionObserver can fire
		// BEFORE the ResizeObserver pin. Pre-fix that flipped `userScrolledUp`
		// and, with the large post-growth slack, the gate declined to pin.
		// Now the sentinel observer no longer feeds the gate at all, so the
		// ordering is irrelevant and the thread still follows.
		el.grow(900);
		sim.sentinelLeftViewport(); // IO "won the race" — now a no-op for the gate
		sim.resizeTick();
		sim.flushRaf();
		expect(sim.atBottom()).toBe(true);
		expect(sim.pinCount).toBe(1);
	});

	test("REGRESSION (negative): a deliberate scroll-up before a large insert is still NOT yanked", () => {
		sim.initialScrollDone = true;
		sim.scrollToBottom();

		// User scrolls up to read BEFORE the big insert lands.
		sim.userScrollTo(300);
		expect(sim.stuck).toBe(false);
		const readingTop = el.scrollTop;

		el.grow(900); // turn-completion reconcile arrives while they read
		sim.sentinelLeftViewport();
		sim.resizeTick();
		sim.flushRaf();
		expect(el.scrollTop).toBe(readingTop); // not moved
		expect(sim.pinCount).toBe(0);
	});
});
