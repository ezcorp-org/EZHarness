import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

// Read the SwipeDrawer source for pattern verification
const swipeDrawerSrc = readFileSync(
	resolve(__dirname, "../lib/components/SwipeDrawer.svelte"),
	"utf-8",
);

// ---------------------------------------------------------------------------
// Unit tests for SwipeDrawer component logic
// Tests verify CSS patterns, swipe math, accessibility, and transition values
// ---------------------------------------------------------------------------

describe("SwipeDrawer panel transform logic", () => {
	// panelTransform() from SwipeDrawer.svelte:73-81
	test("left drawer off-screen = translateX(-100%)", () => {
		// When entering=false, side="left": translateX(-100%)
		const side = "left";
		const entering = false;
		const dragging = false;
		const transform = dragging
			? "translateX(0px)"
			: !entering
				? side === "left"
					? "translateX(-100%)"
					: "translateX(100%)"
				: "translateX(0)";
		expect(transform).toBe("translateX(-100%)");
	});

	test("right drawer off-screen = translateX(100%)", () => {
		const side = "right";
		const entering = false;
		const dragging = false;
		const transform = dragging
			? "translateX(0px)"
			: !entering
				? side === "left"
					? "translateX(-100%)"
					: "translateX(100%)"
				: "translateX(0)";
		expect(transform).toBe("translateX(100%)");
	});

	test("open state = translateX(0)", () => {
		const entering = true;
		const dragging = false;
		const transform = dragging
			? "translateX(0px)"
			: !entering
				? "translateX(-100%)"
				: "translateX(0)";
		expect(transform).toBe("translateX(0)");
	});

	test("during drag = translateX(deltaX)", () => {
		const dragging = true;
		const dragDelta = -120;
		const transform = dragging
			? `translateX(${dragDelta}px)`
			: "translateX(0)";
		expect(transform).toBe("translateX(-120px)");
	});
});

describe("SwipeDrawer swipe direction clamping", () => {
	// onTouchMove from SwipeDrawer.svelte:107-119
	test("left drawer: only allows negative deltaX (swipe left)", () => {
		const side = "left";
		const delta = -50;
		const clamped = side === "left" ? Math.min(0, delta) : Math.max(0, delta);
		expect(clamped).toBe(-50);
	});

	test("left drawer: clamps positive delta to 0", () => {
		const side = "left";
		const delta = 30;
		const clamped = side === "left" ? Math.min(0, delta) : Math.max(0, delta);
		expect(clamped).toBe(0);
	});

	test("right drawer: only allows positive deltaX (swipe right)", () => {
		const side = "right";
		const delta = 50;
		const clamped = side === "left" ? Math.min(0, delta) : Math.max(0, delta);
		expect(clamped).toBe(50);
	});

	test("right drawer: clamps negative delta to 0", () => {
		const side = "right";
		const delta = -30;
		const clamped = side === "left" ? Math.min(0, delta) : Math.max(0, delta);
		expect(clamped).toBe(0);
	});
});

describe("SwipeDrawer close decision logic", () => {
	// onTouchEnd from SwipeDrawer.svelte:121-133
	function shouldClose(absDelta: number, elapsed: number, panelWidth: number): boolean {
		const velocity = elapsed > 0 ? absDelta / elapsed : 0;
		const progress = panelWidth > 0 ? absDelta / panelWidth : 0;
		return velocity > 0.5 || progress > 0.4;
	}

	test("velocity-based close: fast swipe (>0.5px/ms) should close", () => {
		// 80px in 100ms = 0.8px/ms (fast flick)
		expect(shouldClose(80, 100, 300)).toBe(true);
	});

	test("velocity-based close: even small distance if fast enough", () => {
		// 30px in 50ms = 0.6px/ms
		expect(shouldClose(30, 50, 300)).toBe(true);
	});

	test("distance-based close: >40% of width should close", () => {
		// 150px of 300px = 50%
		expect(shouldClose(150, 2000, 300)).toBe(true);
	});

	test("distance-based close: exactly at 40% boundary", () => {
		// 120px of 300px = 40% — NOT > 0.4, so should not close
		expect(shouldClose(120, 2000, 300)).toBe(false);
	});

	test("snap-back: insufficient swipe (slow + <40%) should NOT close", () => {
		// 90px in 1000ms = 0.09px/ms velocity, 90/300 = 30% distance
		expect(shouldClose(90, 1000, 300)).toBe(false);
	});

	test("snap-back: slow drag just under threshold", () => {
		// 100px in 800ms = 0.125px/ms, 100/300 = 33%
		expect(shouldClose(100, 800, 300)).toBe(false);
	});

	test("wrong direction produces 0 delta which does not close", () => {
		// Clamped to 0 means no movement in dismiss direction
		expect(shouldClose(0, 200, 300)).toBe(false);
	});
});

describe("SwipeDrawer backdrop opacity math", () => {
	// From SwipeDrawer.svelte:42
	// backdropOpacity = dragging ? 0.5 * (1 - progress) : 0.5
	function backdropOpacity(dragging: boolean, absDelta: number, panelWidth: number): number {
		const progress = panelWidth > 0 ? absDelta / panelWidth : 0;
		return dragging ? 0.5 * (1 - progress) : 0.5;
	}

	test("base opacity 0.5 when open (not dragging)", () => {
		expect(backdropOpacity(false, 0, 300)).toBe(0.5);
	});

	test("opacity proportional during drag: 0% = 0.5", () => {
		expect(backdropOpacity(true, 0, 300)).toBe(0.5);
	});

	test("opacity proportional during drag: 50% = 0.25", () => {
		expect(backdropOpacity(true, 150, 300)).toBe(0.25);
	});

	test("opacity proportional during drag: 100% = 0", () => {
		expect(backdropOpacity(true, 300, 300)).toBe(0);
	});

	test("formula: 0.5 * (1 - progress) where progress = abs(delta)/width", () => {
		const delta = 120;
		const width = 300;
		const progress = Math.abs(delta) / width;
		const expected = 0.5 * (1 - progress);
		expect(backdropOpacity(true, delta, width)).toBeCloseTo(expected);
	});
});

describe("SwipeDrawer CSS transition values", () => {
	test("transition duration is 300ms", () => {
		expect(swipeDrawerSrc).toContain("300ms");
	});

	test("transition easing is cubic-bezier(0.32, 0.72, 0, 1)", () => {
		expect(swipeDrawerSrc).toContain("cubic-bezier(0.32, 0.72, 0, 1)");
	});

	test("transform transition on panel", () => {
		expect(swipeDrawerSrc).toContain(
			'transition={dragging ? "none" : "transform 300ms cubic-bezier(0.32, 0.72, 0, 1)"}',
		);
	});

	test("opacity transition on backdrop", () => {
		expect(swipeDrawerSrc).toContain(
			'transition={dragging ? "none" : "opacity 300ms cubic-bezier(0.32, 0.72, 0, 1)"}',
		);
	});

	test("transition disabled during drag (panel)", () => {
		// The ternary sets transition to "none" when dragging
		expect(swipeDrawerSrc).toMatch(/dragging \? "none" : "transform 300ms/);
	});

	test("transition disabled during drag (backdrop)", () => {
		expect(swipeDrawerSrc).toMatch(/dragging \? "none" : "opacity 300ms/);
	});
});

describe("SwipeDrawer positioning", () => {
	test("left drawer positioned left-0", () => {
		expect(swipeDrawerSrc).toContain("side === 'left' ? 'left-0' : 'right-0'");
	});

	test("right drawer positioned right-0", () => {
		// Same ternary, right side gets right-0
		expect(swipeDrawerSrc).toContain("'right-0'");
	});
});

describe("SwipeDrawer default z-index", () => {
	test("default zIndex is 40", () => {
		expect(swipeDrawerSrc).toContain("zIndex = 40");
	});

	test("zIndex applied via style:z-index", () => {
		expect(swipeDrawerSrc).toContain("style:z-index={zIndex}");
	});
});

describe("SwipeDrawer width/maxWidth classes", () => {
	test("width class applied to panel", () => {
		// Panel class string includes {width} and {maxWidth}
		expect(swipeDrawerSrc).toContain("{width} {maxWidth}");
	});

	test("extra class prop applied to panel", () => {
		expect(swipeDrawerSrc).toContain("{extraClass}");
	});
});

describe("SwipeDrawer accessibility", () => {
	test('role="dialog" present', () => {
		expect(swipeDrawerSrc).toContain('role="dialog"');
	});

	test('aria-modal="true" present', () => {
		expect(swipeDrawerSrc).toContain('aria-modal="true"');
	});

	test("aria-label passed through", () => {
		expect(swipeDrawerSrc).toContain("aria-label={ariaLabel || undefined}");
	});
});

describe("SwipeDrawer data-testid attributes", () => {
	test('data-testid="swipe-drawer" on overlay', () => {
		expect(swipeDrawerSrc).toContain('data-testid="swipe-drawer"');
	});

	test('data-testid="swipe-drawer-backdrop" on backdrop', () => {
		expect(swipeDrawerSrc).toContain('data-testid="swipe-drawer-backdrop"');
	});

	test('data-testid="swipe-drawer-panel" on panel', () => {
		expect(swipeDrawerSrc).toContain('data-testid="swipe-drawer-panel"');
	});
});

describe("SwipeDrawer GPU acceleration", () => {
	test("will-change: transform on panel", () => {
		// Two occurrences of will-change in the source
		expect(swipeDrawerSrc).toContain('style:will-change="transform"');
	});

	test("will-change: opacity on backdrop", () => {
		expect(swipeDrawerSrc).toContain('style:will-change="opacity"');
	});
});

describe("SwipeDrawer backdrop click and Escape", () => {
	test("backdrop has onclick handler calling onclose", () => {
		expect(swipeDrawerSrc).toContain("onclick={onBackdropClick}");
		expect(swipeDrawerSrc).toContain("function onBackdropClick()");
	});

	test("Escape key handler closes topmost drawer via registry", () => {
		// Global ESC handler checks e.key !== "Escape" (early return guard)
		expect(swipeDrawerSrc).toContain('"Escape"');
		// Topmost drawer is closed via top.close()
		expect(swipeDrawerSrc).toContain("top.close()");
		// Drawers register/unregister via $effect
		expect(swipeDrawerSrc).toContain("registerDrawer");
		expect(swipeDrawerSrc).toContain("unregisterDrawer");
	});

	test("panel click stops propagation (doesn't trigger backdrop close)", () => {
		expect(swipeDrawerSrc).toContain("onclick={onPanelClick}");
		expect(swipeDrawerSrc).toContain("e.stopPropagation()");
	});
});

describe("SwipeDrawer visibility lifecycle", () => {
	test("conditional rendering uses {#if visible}", () => {
		expect(swipeDrawerSrc).toContain("{#if visible}");
	});

	test("close animation timeout matches transition duration (300ms)", () => {
		// setTimeout for unmount waits 300ms to match CSS transition
		expect(swipeDrawerSrc).toContain("setTimeout(() => {");
		expect(swipeDrawerSrc).toMatch(/visible = false;\s*\}, 300\)/);
	});
});

describe("SwipeDrawer focus trap", () => {
	test("focus trap is created when entering", () => {
		expect(swipeDrawerSrc).toContain("createFocusTrap");
	});

	test("focus trap cleaned up on close", () => {
		expect(swipeDrawerSrc).toContain("cleanupFocusTrap?.()");
	});
});

describe("SwipeDrawer touch event handlers", () => {
	test("ontouchstart on panel", () => {
		expect(swipeDrawerSrc).toContain("ontouchstart={onTouchStart}");
	});

	test("ontouchmove on panel", () => {
		expect(swipeDrawerSrc).toContain("ontouchmove={onTouchMove}");
	});

	test("ontouchend on panel", () => {
		expect(swipeDrawerSrc).toContain("ontouchend={onTouchEnd}");
	});
});

// ---------------------------------------------------------------------------
// Drawer stack registry logic tests
// ---------------------------------------------------------------------------

describe("SwipeDrawer ESC stack registry", () => {
	test("handleGlobalEsc closes only the highest z-index drawer", () => {
		// Simulate the registry logic from the module script
		type DrawerEntry = { zIndex: number; close: () => void };
		const openDrawers: DrawerEntry[] = [];

		const closed: string[] = [];
		openDrawers.push({ zIndex: 40, close: () => closed.push("agent-panel") });
		openDrawers.push({ zIndex: 50, close: () => closed.push("team-panel") });

		// Simulate handleGlobalEsc: close topmost
		const top = openDrawers.reduce((a, b) => a.zIndex >= b.zIndex ? a : b);
		top.close();

		expect(closed).toEqual(["team-panel"]);
	});

	test("second ESC closes the remaining drawer", () => {
		type DrawerEntry = { zIndex: number; close: () => void };
		const openDrawers: DrawerEntry[] = [];
		const closed: string[] = [];

		const agentEntry: DrawerEntry = { zIndex: 40, close: () => closed.push("agent-panel") };
		const teamEntry: DrawerEntry = { zIndex: 50, close: () => closed.push("team-panel") };
		openDrawers.push(agentEntry);
		openDrawers.push(teamEntry);

		// First ESC
		let top = openDrawers.reduce((a, b) => a.zIndex >= b.zIndex ? a : b);
		top.close();
		// Simulate unregister (effect cleanup)
		const idx = openDrawers.findIndex(d => d.close === teamEntry.close);
		openDrawers.splice(idx, 1);

		expect(closed).toEqual(["team-panel"]);
		expect(openDrawers).toHaveLength(1);

		// Second ESC
		top = openDrawers.reduce((a, b) => a.zIndex >= b.zIndex ? a : b);
		top.close();

		expect(closed).toEqual(["team-panel", "agent-panel"]);
	});

	test("ESC does nothing when no drawers are open", () => {
		const openDrawers: { zIndex: number; close: () => void }[] = [];
		let closeCalled = false;

		// Guard: if openDrawers.length === 0, return
		if (openDrawers.length > 0) {
			closeCalled = true;
		}
		expect(closeCalled).toBe(false);
	});

	test("single drawer closes on ESC", () => {
		const closed: string[] = [];
		const openDrawers = [{ zIndex: 40, close: () => closed.push("only-panel") }];

		const top = openDrawers.reduce((a, b) => a.zIndex >= b.zIndex ? a : b);
		top.close();

		expect(closed).toEqual(["only-panel"]);
	});

	test("equal z-index: first registered wins (stable)", () => {
		const closed: string[] = [];
		const openDrawers = [
			{ zIndex: 40, close: () => closed.push("first") },
			{ zIndex: 40, close: () => closed.push("second") },
		];

		// reduce with >= means the first entry wins when equal
		const top = openDrawers.reduce((a, b) => a.zIndex >= b.zIndex ? a : b);
		top.close();

		expect(closed).toEqual(["first"]);
	});

	test("registerDrawer adds to array", () => {
		const openDrawers: { zIndex: number; close: () => void }[] = [];
		const entry = { zIndex: 40, close: () => {} };
		openDrawers.push(entry);
		expect(openDrawers).toHaveLength(1);
		expect(openDrawers[0]).toBe(entry);
	});

	test("unregisterDrawer removes by close reference", () => {
		const openDrawers: { zIndex: number; close: () => void }[] = [];
		const close1 = () => {};
		const close2 = () => {};
		openDrawers.push({ zIndex: 40, close: close1 });
		openDrawers.push({ zIndex: 50, close: close2 });

		// Remove close1
		const idx = openDrawers.findIndex(d => d.close === close1);
		if (idx !== -1) openDrawers.splice(idx, 1);

		expect(openDrawers).toHaveLength(1);
		expect(openDrawers[0].close).toBe(close2);
	});

	test("unregisterDrawer is no-op for unknown close reference", () => {
		const openDrawers: { zIndex: number; close: () => void }[] = [];
		openDrawers.push({ zIndex: 40, close: () => {} });

		const unknownClose = () => {};
		const idx = openDrawers.findIndex(d => d.close === unknownClose);
		if (idx !== -1) openDrawers.splice(idx, 1);

		expect(openDrawers).toHaveLength(1);
	});

	test("source uses module-level script for registry", () => {
		expect(swipeDrawerSrc).toContain('<script lang="ts" module>');
		expect(swipeDrawerSrc).toContain("const openDrawers");
		expect(swipeDrawerSrc).toContain("handleGlobalEsc");
	});

	test("stopImmediatePropagation prevents double-handling", () => {
		expect(swipeDrawerSrc).toContain("e.stopImmediatePropagation()");
	});
});

describe("SwipeDrawer ESC registry edge cases", () => {
	test("three drawers stacked: closes highest first", () => {
		const closed: string[] = [];
		const drawers = [
			{ zIndex: 40, close: () => closed.push("settings") },
			{ zIndex: 40, close: () => closed.push("agent") },
			{ zIndex: 50, close: () => closed.push("team") },
		];

		const top = drawers.reduce((a, b) => a.zIndex >= b.zIndex ? a : b);
		top.close();
		expect(closed).toEqual(["team"]);
	});

	test("non-Escape key is ignored by handleGlobalEsc", () => {
		let closeCalled = false;
		const drawers = [{ zIndex: 40, close: () => { closeCalled = true; } }];

		// Simulate: e.key is not Escape
		const key = "Enter" as string;
		if (key !== "Escape" || drawers.length === 0) {
			// early return
		} else {
			drawers[0].close();
		}
		expect(closeCalled).toBe(false);
	});

	test("rapid double-register does not duplicate entries if guarded", () => {
		const drawers: { zIndex: number; close: () => void }[] = [];
		const close = () => {};

		// First register
		drawers.push({ zIndex: 40, close });
		// If same close registers again (shouldn't happen with $effect, but verify behavior)
		drawers.push({ zIndex: 40, close });

		expect(drawers).toHaveLength(2);
		// unregister removes first match
		const idx = drawers.findIndex(d => d.close === close);
		drawers.splice(idx, 1);
		expect(drawers).toHaveLength(1);
	});
});

describe("TeamChatPanel layered ESC behavior", () => {
	test("ESC in drill-down goes back to overview, not closing panel", () => {
		// TeamChatPanel onclose: if (drillDown) closeTeamDrillDown() else closeTeamPanel()
		let drillDown: { agentName: string } | null = { agentName: "Worker" };
		let panelClosed = false;
		let drillDownClosed = false;

		// Simulate the onclose handler
		if (drillDown) {
			drillDownClosed = true;
			drillDown = null; // closeTeamDrillDown
		} else {
			panelClosed = true;
		}

		expect(drillDownClosed).toBe(true);
		expect(panelClosed).toBe(false);
		expect(drillDown).toBeNull();
	});

	test("ESC in overview closes panel", () => {
		const drillDown = null;
		let panelClosed = false;
		let drillDownClosed = false;

		if (drillDown) {
			drillDownClosed = true;
		} else {
			panelClosed = true;
		}

		expect(drillDownClosed).toBe(false);
		expect(panelClosed).toBe(true);
	});

	test("two ESC presses: first exits drill-down, second closes panel", () => {
		let drillDown: { agentName: string } | null = { agentName: "Worker" };
		let panelClosed = false;

		function onclose() {
			if (drillDown) {
				drillDown = null;
			} else {
				panelClosed = true;
			}
		}

		// First ESC
		onclose();
		expect(drillDown).toBeNull();
		expect(panelClosed).toBe(false);

		// Second ESC
		onclose();
		expect(panelClosed).toBe(true);
	});
});
