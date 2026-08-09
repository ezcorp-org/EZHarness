import { test, expect, describe, mock, beforeEach } from "bun:test";
import {
  shouldStickToBottom,
  nextFollowIntent,
  bottomSlack,
  STICK_TO_BOTTOM_THRESHOLD_PX,
} from "$lib/chat-stick-to-bottom.js";

// ---------------------------------------------------------------------------
// 1. adjustHeight logic (pure math extracted from ChatInput.svelte)
// ---------------------------------------------------------------------------
describe("adjustHeight logic", () => {
  const MAX_ROWS = 6;
  const LINE_HEIGHT = 24;
  const maxHeight = MAX_ROWS * LINE_HEIGHT; // 144

  function computeHeight(scrollHeight: number): number {
    return Math.min(scrollHeight, maxHeight);
  }

  test("maxHeight constant is 144", () => {
    expect(maxHeight).toBe(144);
  });

  test("short content uses scrollHeight directly", () => {
    expect(computeHeight(48)).toBe(48);
    expect(computeHeight(24)).toBe(24);
    expect(computeHeight(100)).toBe(100);
  });

  test("content at exactly maxHeight returns 144", () => {
    expect(computeHeight(144)).toBe(144);
  });

  test("tall content is capped at 144", () => {
    expect(computeHeight(200)).toBe(144);
    expect(computeHeight(500)).toBe(144);
    expect(computeHeight(1000)).toBe(144);
  });

  test("adjustHeight sets textarea style correctly for short content", () => {
    const textarea = { style: { height: "" }, scrollHeight: 72 };
    // Simulate adjustHeight
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + "px";
    expect(textarea.style.height).toBe("72px");
  });

  test("adjustHeight sets textarea style correctly for tall content", () => {
    const textarea = { style: { height: "" }, scrollHeight: 300 };
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + "px";
    expect(textarea.style.height).toBe("144px");
  });

  test("adjustHeight is a no-op when textarea is undefined", () => {
    const textarea = undefined;
    // Should not throw
    const fn = () => {
      if (!textarea) return;
    };
    expect(fn).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Jump-to-bottom button behavior (logic-level)
// ---------------------------------------------------------------------------
describe("jump-to-bottom button behavior", () => {
  test("userScrolledUp starts as false", () => {
    const userScrolledUp = false;
    expect(userScrolledUp).toBe(false);
  });

  test("IntersectionObserver not intersecting sets userScrolledUp to true", () => {
    let userScrolledUp = false;
    // Simulate the observer callback: ([entry]) => { userScrolledUp = !entry.isIntersecting }
    const callback = (entries: { isIntersecting: boolean }[]) => {
      userScrolledUp = !entries[0]!.isIntersecting;
    };

    callback([{ isIntersecting: false }]);
    expect(userScrolledUp).toBe(true);
  });

  test("IntersectionObserver intersecting sets userScrolledUp to false", () => {
    let userScrolledUp = true;
    const callback = (entries: { isIntersecting: boolean }[]) => {
      userScrolledUp = !entries[0]!.isIntersecting;
    };

    callback([{ isIntersecting: true }]);
    expect(userScrolledUp).toBe(false);
  });

  test("button click resets userScrolledUp and calls scrollIntoView", () => {
    let userScrolledUp = true;
    const scrollIntoView = mock((_opts?: ScrollIntoViewOptions) => {});
    const sentinel = { scrollIntoView };

    // Simulate button onclick handler
    const handleClick = () => {
      userScrolledUp = false;
      sentinel.scrollIntoView({ behavior: "smooth" });
    };

    handleClick();
    expect(userScrolledUp).toBe(false);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth" });
  });

  test("multiple observer toggles track state correctly", () => {
    let userScrolledUp = false;
    const callback = (entries: { isIntersecting: boolean }[]) => {
      userScrolledUp = !entries[0]!.isIntersecting;
    };

    callback([{ isIntersecting: false }]);
    expect(userScrolledUp).toBe(true);

    callback([{ isIntersecting: true }]);
    expect(userScrolledUp).toBe(false);

    callback([{ isIntersecting: false }]);
    expect(userScrolledUp).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Stick-to-bottom gate — exercises the REAL $lib/chat-stick-to-bottom
//    module that ChatThread.svelte's ResizeObserver calls (no reimplementation,
//    so call-site drift surfaces as a failure).
// ---------------------------------------------------------------------------
describe("stick-to-bottom gate", () => {
  const shouldPin = shouldStickToBottom;

  const base = {
    initialScrollDone: true,
    rafPending: false,
    anchorWatchActive: false,
    stuck: true,
  };

  test("threshold constant is 80px", () => {
    expect(STICK_TO_BOTTOM_THRESHOLD_PX).toBe(80);
  });

  describe("bottomSlack (caller-side stuck classification — no longer a gate input)", () => {
    test("0 when scrolled to the very bottom", () => {
      expect(bottomSlack({ scrollHeight: 2400, scrollTop: 1600, clientHeight: 800 })).toBe(0);
    });
    test("positive when above the bottom", () => {
      expect(bottomSlack({ scrollHeight: 2400, scrollTop: 600, clientHeight: 800 })).toBe(1000);
    });
    test("non-scrollable content yields non-positive slack", () => {
      expect(bottomSlack({ scrollHeight: 500, scrollTop: 0, clientHeight: 800 })).toBe(-300);
    });
    test("a scroll at the bottom classifies as stuck ⇒ pin", () => {
      // Mirrors ChatThread's onScroll: stuck = bottomSlack(el) < THRESHOLD.
      const el = { scrollHeight: 2400, scrollTop: 1600, clientHeight: 800 };
      const stuck = bottomSlack(el) < STICK_TO_BOTTOM_THRESHOLD_PX;
      expect(shouldPin({ ...base, stuck })).toBe(true);
    });
    test("a scroll far above the bottom classifies as not-stuck ⇒ no pin", () => {
      const el = { scrollHeight: 5000, scrollTop: 200, clientHeight: 800 };
      const stuck = bottomSlack(el) < STICK_TO_BOTTOM_THRESHOLD_PX;
      expect(shouldPin({ ...base, stuck })).toBe(false);
    });
    test("threshold boundary: < threshold is stuck, >= threshold is not", () => {
      const mk = (slack: number) => ({
        scrollHeight: 1000 + slack,
        scrollTop: 200,
        clientHeight: 800,
      });
      expect(bottomSlack(mk(STICK_TO_BOTTOM_THRESHOLD_PX - 1)) < STICK_TO_BOTTOM_THRESHOLD_PX).toBe(
        true,
      );
      expect(bottomSlack(mk(STICK_TO_BOTTOM_THRESHOLD_PX)) < STICK_TO_BOTTOM_THRESHOLD_PX).toBe(
        false,
      );
    });
  });

  test("pins while the user is following the bottom (stuck)", () => {
    expect(shouldPin({ ...base, stuck: true })).toBe(true);
  });

  test("REGRESSION: a large turn-completion insert while following pins regardless of any async sentinel state", () => {
    // The bug: a >80px one-shot insert used to be classified via
    // post-growth `slack` + the async `userScrolledUp` flag, so when the
    // bottom-sentinel IntersectionObserver fired before the ResizeObserver
    // pin the new turn was wrongly treated as "user scrolled up" and the
    // thread did not follow. The gate now reads only `stuck` (tracked
    // synchronously from real scroll events), so observer ordering can no
    // longer poison it: while following, it pins — full stop.
    expect(shouldPin({ ...base, stuck: true })).toBe(true);
  });

  test("does NOT pin when the user broke away to read (not stuck)", () => {
    // A real scroll-up sets stuck=false synchronously (ChatThread
    // onScroll), before any later resize tick — the reading user is
    // never yanked.
    expect(shouldPin({ ...base, stuck: false })).toBe(false);
  });

  test("does NOT pin before initialScrollDone (defers to open-time scroll-restore)", () => {
    // Even while following: a RO fire during the open window must be a
    // no-op so scroll-restore can win.
    expect(shouldPin({ ...base, initialScrollDone: false })).toBe(false);
    expect(
      shouldPin({
        initialScrollDone: false,
        rafPending: false,
        anchorWatchActive: false,
        stuck: true,
      }),
    ).toBe(false);
  });

  test("does NOT pin while an anchor-restore watch is active (mutually exclusive scroll intents)", () => {
    // Even while following: while startAnchorReapplyWatch owns the
    // scroll, the stick observer must stand down so it doesn't trip the
    // anchor watch's onScroll early-stop (anchor drift).
    expect(shouldPin({ ...base, anchorWatchActive: true, stuck: true })).toBe(false);
  });

  test("does NOT double-schedule while a rAF pin is already pending", () => {
    expect(shouldPin({ ...base, rafPending: true })).toBe(false);
  });

  test("open-restore drops stuck so a RO fire can't yank a restored non-bottom position", () => {
    // Simulate the restore branch: container restored to a non-bottom
    // scrollTop and `stuck = false` set synchronously alongside the
    // (now visibility-only) `userScrolledUp = true`.
    let stuck = true;
    const restoreToNonBottom = () => {
      // container.scrollTop = anchorTop ?? decision.scrollTop
      stuck = false; // the synchronous guard
    };
    restoreToNonBottom();
    expect(
      shouldPin({
        initialScrollDone: true,
        rafPending: false,
        anchorWatchActive: false,
        stuck,
      }),
    ).toBe(false);
  });

  test("the rAF pin writes scrollTop = scrollHeight (deterministic, no sentinel scrollIntoView)", () => {
    const el = { scrollTop: 120, scrollHeight: 2400, clientHeight: 800 };
    // requestAnimationFrame body from the RO callback:
    const pin = () => {
      el.scrollTop = el.scrollHeight;
    };
    pin();
    expect(el.scrollTop).toBe(2400);
  });
});

// ---------------------------------------------------------------------------
// 3b. nextFollowIntent — the single writer for `stuck` in ChatThread's
//     onScroll. Issue #140: growth must never be able to latch the follow
//     state off.
// ---------------------------------------------------------------------------
describe("nextFollowIntent (follow-intent state machine)", () => {
  const at = (slack: number) => slack; // readability helper

  test("landing within the threshold of the bottom always means following", () => {
    // Whoever put us here — user, the rAF pin, jump-to-bottom — being at
    // the bottom IS following. Re-gluing is unconditional.
    expect(
      nextFollowIntent({
        previousScrollTop: 1600,
        scrollTop: 1600,
        slack: at(0),
        stuck: false,
      }),
    ).toBe(true);
    expect(
      nextFollowIntent({
        previousScrollTop: 200,
        scrollTop: 1590,
        slack: at(STICK_TO_BOTTOM_THRESHOLD_PX - 1),
        stuck: false,
      }),
    ).toBe(true);
  });

  test("a viewport that moved UP past the threshold breaks the follow", () => {
    // The user dragged / wheeled / PageUp'd away to read.
    expect(
      nextFollowIntent({
        previousScrollTop: 1600,
        scrollTop: 400,
        slack: at(1200),
        stuck: true,
      }),
    ).toBe(false);
  });

  test("REGRESSION (#140): growth under a stationary viewport cannot latch the follow off", () => {
    // The rAF pin wrote scrollTop = scrollHeight, but by the time the
    // scroll event was delivered the thread had grown again (a code block,
    // an image, a KaTeX reflow). Slack is now way past the threshold, yet
    // the viewport never moved up — this is the thread's OWN growth, not
    // user intent, so the follow must survive and the next resize tick
    // re-pins.
    expect(
      nextFollowIntent({
        previousScrollTop: 900,
        scrollTop: 929, // the pin RAISED it
        slack: at(900),
        stuck: true,
      }),
    ).toBe(true);
  });

  test("REGRESSION (#140): an unchanged scrollTop past the threshold cannot latch it off either", () => {
    // Pure growth with no anchoring adjustment at all.
    expect(
      nextFollowIntent({
        previousScrollTop: 762,
        scrollTop: 762,
        slack: at(167),
        stuck: true,
      }),
    ).toBe(true);
  });

  test("scroll anchoring (which only ever raises scrollTop) cannot latch it off", () => {
    expect(
      nextFollowIntent({
        previousScrollTop: 762,
        scrollTop: 1662, // browser compensated for 900px of growth above
        slack: at(900),
        stuck: true,
      }),
    ).toBe(true);
  });

  test("a broken follow stays broken while the viewport moves down but is still far from the bottom", () => {
    expect(
      nextFollowIntent({
        previousScrollTop: 400,
        scrollTop: 700,
        slack: at(900),
        stuck: false,
      }),
    ).toBe(false);
  });

  test("threshold boundary: < threshold re-glues, >= threshold defers to the movement test", () => {
    const mk = (slack: number, stuck: boolean) =>
      nextFollowIntent({
        previousScrollTop: 1000,
        scrollTop: 1000, // no movement ⇒ only the slack branch can act
        slack,
        stuck,
      });
    expect(mk(STICK_TO_BOTTOM_THRESHOLD_PX - 1, false)).toBe(true);
    expect(mk(STICK_TO_BOTTOM_THRESHOLD_PX, false)).toBe(false);
    expect(mk(STICK_TO_BOTTOM_THRESHOLD_PX, true)).toBe(true);
  });

  test("the pin→grow→pin loop converges instead of latching (walked end to end)", () => {
    // 2400px of content, 800px viewport, parked at the bottom.
    const el = { scrollHeight: 2400, scrollTop: 1600, clientHeight: 800 };
    let stuck = true;
    let previousScrollTop = el.scrollTop;
    const onScroll = () => {
      const scrollTop = el.scrollTop;
      stuck = nextFollowIntent({
        previousScrollTop,
        scrollTop,
        slack: bottomSlack(el),
        stuck,
      });
      previousScrollTop = scrollTop;
    };

    // Frame 1: a big chunk lands, the rAF pin runs against the height it
    // saw, and the thread grows AGAIN before the scroll event is dispatched.
    el.scrollHeight += 900;
    el.scrollTop = el.scrollHeight - el.clientHeight; // the pin
    el.scrollHeight += 400; // late reflow, pre-dispatch
    onScroll();
    expect(bottomSlack(el)).toBe(400);
    expect(stuck, "the thread's own growth must not break the follow").toBe(true);

    // Frame 2: because `stuck` survived, the observer pins again and the
    // view converges on the bottom.
    el.scrollTop = el.scrollHeight - el.clientHeight;
    onScroll();
    expect(bottomSlack(el)).toBe(0);
    expect(stuck).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3c. The jump-to-bottom affordance must not contribute to the scroll extent
//     it reports on (issue #140 root cause). Asserted against the component
//     SOURCE — a bun test must not import a web/src/lib Svelte module.
// ---------------------------------------------------------------------------
describe("jump-to-bottom overlay dock (ChatThread source invariant)", () => {
  let src: string;

  beforeEach(async () => {
    src = await Bun.file(
      new URL("../lib/components/ChatThread.svelte", import.meta.url).pathname,
    ).text();
  });

  test("the button is rendered inside the dock, not as a bare child of the scroll container", () => {
    const dockOpen = src.indexOf('<div class="jump-to-bottom-dock"');
    expect(dockOpen).toBeGreaterThan(-1);
    const buttonAt = src.indexOf('class="jump-to-bottom"');
    expect(buttonAt).toBeGreaterThan(dockOpen);
  });

  test("the dock is sticky (pins to the scrollport, not the padding box)", () => {
    expect(src).toMatch(/\.jump-to-bottom-dock\s*\{[^}]*position:\s*sticky/);
  });

  test("the dock is ZERO-HEIGHT so it adds nothing to the container's scrollHeight", () => {
    // The load-bearing rule. A sticky box is still in flow: give this dock
    // a real height and the "you are not at the bottom" affordance starts
    // keeping the view off the bottom by exactly its own height.
    expect(src).toMatch(/\.jump-to-bottom-dock\s*\{[^}]*height:\s*0\s*;/);
  });

  test("the button is absolutely positioned (out of flow) inside the dock", () => {
    expect(src).toMatch(/\.jump-to-bottom\s*\{[^}]*position:\s*absolute/);
    // …and specifically NOT sticky any more, which is what put it in flow.
    expect(src).not.toMatch(/\.jump-to-bottom\s*\{[^}]*position:\s*sticky/);
  });
});

// ---------------------------------------------------------------------------
// 4. Scrollbar CSS (verify styles exist in ChatInput component source)
// ---------------------------------------------------------------------------
describe("scrollbar CSS in ChatInput", () => {
  let cssContent: string;

  beforeEach(async () => {
    const file = Bun.file(new URL("../lib/components/ChatInput.svelte", import.meta.url).pathname);
    cssContent = await file.text();
  });

  test("sets scrollbar-width: thin on textarea", () => {
    expect(cssContent).toContain("scrollbar-width: thin");
  });

  test("default scrollbar-color is transparent transparent", () => {
    expect(cssContent).toContain("scrollbar-color: transparent transparent");
  });

  test("hover changes scrollbar-color", () => {
    // The style block has: textarea:hover { scrollbar-color: var(--color-border) transparent; }
    expect(cssContent).toMatch(
      /textarea:hover[\s\S]*?scrollbar-color:\s*var\(--color-border\)\s+transparent/,
    );
  });

  test("focus changes scrollbar-color", () => {
    expect(cssContent).toMatch(
      /textarea:focus[\s\S]*?scrollbar-color:\s*var\(--color-border\)\s+transparent/,
    );
  });

  test("webkit scrollbar width is 6px", () => {
    expect(cssContent).toContain("width: 6px");
  });

  test("webkit scrollbar thumb is transparent by default", () => {
    expect(cssContent).toMatch(/scrollbar-thumb\s*\{[\s\S]*?background:\s*transparent/);
  });

  test("webkit scrollbar thumb shows on hover", () => {
    expect(cssContent).toMatch(/textarea:hover::-webkit-scrollbar-thumb/);
  });

  test("overflow-y is set to auto on textarea", () => {
    expect(cssContent).toContain("overflow-y: auto");
  });
});

// ---------------------------------------------------------------------------
// 5. IntersectionObserver setup (mock-based)
// ---------------------------------------------------------------------------
describe("IntersectionObserver setup", () => {
  test("observer is created with container as root and threshold 0.1", () => {
    let observerOptions: IntersectionObserverInit | undefined;
    let observedElement: Element | undefined;

    const MockObserver = class {
      constructor(_cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        observerOptions = options;
      }
      observe(el: Element) {
        observedElement = el;
      }
      disconnect() {}
    };

    const container = {} as HTMLDivElement;
    const sentinel = {} as HTMLDivElement;

    // Simulate onMount logic
    const observer = new MockObserver(
      () => {
        // callback
      },
      { root: container, threshold: 0.1 },
    );
    observer.observe(sentinel);

    expect(observerOptions).toEqual({ root: container, threshold: 0.1 });
    expect(observedElement).toBe(sentinel);
  });

  test("observer.disconnect is called on cleanup", () => {
    const disconnect = mock(() => {});
    const observer = { disconnect, observe: () => {} };

    // Simulate cleanup returned from onMount
    const cleanup = () => {
      observer.disconnect();
    };

    cleanup();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 6. handleSend resets scroll state
// ---------------------------------------------------------------------------
describe("handleSend scroll reset", () => {
  test("sending a message sets userScrolledUp to false", () => {
    let userScrolledUp = true;
    const scrollIntoView = mock((_opts?: ScrollIntoViewOptions) => {});
    const sentinel = { scrollIntoView };

    // Simulate the relevant part of handleSend
    const handleSendScrollReset = () => {
      userScrolledUp = false;
      // requestAnimationFrame(() => sentinel.scrollIntoView(...))
      sentinel.scrollIntoView({ behavior: "instant" as ScrollBehavior });
    };

    handleSendScrollReset();
    expect(userScrolledUp).toBe(false);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
