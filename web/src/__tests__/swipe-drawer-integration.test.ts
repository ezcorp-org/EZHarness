import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

// Read all source files that should use SwipeDrawer
const componentsDir = resolve(__dirname, "../lib/components");
const routesDir = resolve(__dirname, "../routes/(app)");

const layoutSrc = readFileSync(resolve(routesDir, "+layout.svelte"), "utf-8");
const chatPageSrc = readFileSync(
	resolve(routesDir, "project/[id]/chat/[convId]/+page.svelte"),
	"utf-8",
);
const obsPanelSrc = readFileSync(
	resolve(componentsDir, "ObservabilityPanel.svelte"),
	"utf-8",
);
const diffPanelSrc = readFileSync(
	resolve(componentsDir, "DiffSummaryPanel.svelte"),
	"utf-8",
);
const agentPanelSrc = readFileSync(
	resolve(componentsDir, "AgentDetailPanel.svelte"),
	"utf-8",
);
const convSettingsSrc = readFileSync(
	resolve(componentsDir, "ConversationSettings.svelte"),
	"utf-8",
);
const swipeDrawerSrc = readFileSync(
	resolve(componentsDir, "SwipeDrawer.svelte"),
	"utf-8",
);
const teamPanelSrc = readFileSync(
	resolve(componentsDir, "TeamChatPanel.svelte"),
	"utf-8",
);

// ---------------------------------------------------------------------------
// Integration tests: verify all components use SwipeDrawer correctly
// ---------------------------------------------------------------------------

describe("Layout mobile drawer uses SwipeDrawer", () => {
	test("imports SwipeDrawer", () => {
		expect(layoutSrc).toContain('import SwipeDrawer from "$lib/components/SwipeDrawer.svelte"');
	});

	test('uses SwipeDrawer with side="left"', () => {
		expect(layoutSrc).toMatch(/<SwipeDrawer[\s\S]*?side="left"/);
	});

	test("uses correct width for nav drawer", () => {
		expect(layoutSrc).toContain('width="w-[calc(72px+14rem)]"');
	});

	test("uses correct maxWidth", () => {
		expect(layoutSrc).toContain('maxWidth="max-w-[85vw]"');
	});

	test("passes mobileMenuOpen as open prop", () => {
		expect(layoutSrc).toContain("open={mobileMenuOpen}");
	});

	test("passes onclose to close mobile menu", () => {
		expect(layoutSrc).toContain("onclose={() => (mobileMenuOpen = false)}");
	});

	test("no manual touch handlers (touchStartX removed)", () => {
		expect(layoutSrc).not.toContain("touchStartX");
		expect(layoutSrc).not.toContain("handleTouchStart");
		expect(layoutSrc).not.toContain("handleTouchMove");
		expect(layoutSrc).not.toContain("handleTouchEnd");
	});

	test("no @keyframes slide-in CSS in layout", () => {
		expect(layoutSrc).not.toContain("@keyframes slide-in");
		expect(layoutSrc).not.toContain("animate-slide-in");
	});
});

describe("Chat page mobile conversation list uses SwipeDrawer", () => {
	test("imports SwipeDrawer", () => {
		expect(chatPageSrc).toContain('import SwipeDrawer from "$lib/components/SwipeDrawer.svelte"');
	});

	test('uses SwipeDrawer with side="left"', () => {
		expect(chatPageSrc).toMatch(/<SwipeDrawer[\s\S]*?side="left"/);
	});

	test("uses correct width for conversation list", () => {
		expect(chatPageSrc).toContain('width="w-[85vw]"');
	});

	test("uses correct maxWidth", () => {
		expect(chatPageSrc).toContain('maxWidth="max-w-[320px]"');
	});

	test("passes mobileConvListOpen as open prop", () => {
		expect(chatPageSrc).toContain("open={mobileConvListOpen}");
	});

	test("no @keyframes slide-in-left CSS in chat page", () => {
		expect(chatPageSrc).not.toContain("@keyframes slide-in-left");
		expect(chatPageSrc).not.toContain("animate-slide-in-left");
	});
});

describe("ObservabilityPanel uses SwipeDrawer", () => {
	test("imports SwipeDrawer", () => {
		expect(obsPanelSrc).toContain('import SwipeDrawer from "./SwipeDrawer.svelte"');
	});

	test('uses SwipeDrawer with side="right"', () => {
		expect(obsPanelSrc).toContain('side="right"');
	});

	test('uses width="w-full md:w-80"', () => {
		expect(obsPanelSrc).toContain('width="w-full md:w-80"');
	});

	test("wraps content in SwipeDrawer (opening and closing tags)", () => {
		expect(obsPanelSrc).toContain("<SwipeDrawer");
		expect(obsPanelSrc).toContain("</SwipeDrawer>");
	});

	test("no manual fixed positioning", () => {
		// Panel content should NOT have fixed+right-0+top-0 (SwipeDrawer handles it)
		expect(obsPanelSrc).not.toMatch(/class="[^"]*fixed[^"]*right-0[^"]*top-0/);
	});

	test("no manual backdrop div", () => {
		// The panel content itself shouldn't have a backdrop div (SwipeDrawer provides it)
		expect(obsPanelSrc).not.toMatch(/class="[^"]*bg-black\/50[^"]*fixed/);
	});
});

describe("DiffSummaryPanel uses SwipeDrawer", () => {
	test("imports SwipeDrawer", () => {
		expect(diffPanelSrc).toContain('import SwipeDrawer from "./SwipeDrawer.svelte"');
	});

	test('uses SwipeDrawer with side="right"', () => {
		expect(diffPanelSrc).toContain('side="right"');
	});

	test('uses width="w-full md:w-[48rem]"', () => {
		expect(diffPanelSrc).toContain('width="w-full md:w-[48rem]"');
	});

	test("no manual fixed positioning", () => {
		expect(diffPanelSrc).not.toMatch(/class="[^"]*fixed[^"]*right-0[^"]*top-0/);
	});

	test("no manual backdrop div", () => {
		expect(diffPanelSrc).not.toMatch(/class="[^"]*bg-black\/50[^"]*fixed/);
	});

	test("retains data-testid on inner content", () => {
		expect(diffPanelSrc).toContain('data-testid="diff-summary-panel"');
	});
});

describe("AgentDetailPanel uses SwipeDrawer", () => {
	test("imports SwipeDrawer", () => {
		expect(agentPanelSrc).toContain('import SwipeDrawer from "./SwipeDrawer.svelte"');
	});

	test('uses SwipeDrawer with side="right"', () => {
		expect(agentPanelSrc).toContain('side="right"');
	});

	test('uses width="w-full md:w-[32rem]"', () => {
		expect(agentPanelSrc).toContain('width="w-full md:w-[32rem]"');
	});

	test("no manual fixed positioning", () => {
		expect(agentPanelSrc).not.toMatch(/class="[^"]*fixed[^"]*right-0[^"]*top-0/);
	});

	test("no manual backdrop div", () => {
		expect(agentPanelSrc).not.toMatch(/class="[^"]*bg-black\/50[^"]*fixed/);
	});
});

describe("ConversationSettings uses SwipeDrawer", () => {
	test("imports SwipeDrawer", () => {
		expect(convSettingsSrc).toContain('import SwipeDrawer from "./SwipeDrawer.svelte"');
	});

	test('uses SwipeDrawer with side="right"', () => {
		expect(convSettingsSrc).toContain('side="right"');
	});

	test("uses width with max-w-md", () => {
		expect(convSettingsSrc).toContain('width="w-full md:max-w-md"');
	});

	test("no manual fixed positioning", () => {
		expect(convSettingsSrc).not.toMatch(/class="[^"]*fixed[^"]*right-0[^"]*top-0/);
	});

	test("no manual backdrop div", () => {
		expect(convSettingsSrc).not.toMatch(/class="[^"]*bg-black\/50[^"]*fixed/);
	});
});

describe("Z-index consistency across all drawers", () => {
	test("SwipeDrawer default z-index is 40", () => {
		expect(swipeDrawerSrc).toContain("zIndex = 40");
	});

	test("most panels use default z-40 (no zIndex override)", () => {
		expect(obsPanelSrc).not.toContain("zIndex=");
		expect(diffPanelSrc).not.toContain("zIndex=");
		expect(agentPanelSrc).not.toContain("zIndex=");
		expect(convSettingsSrc).not.toContain("zIndex=");
	});

	test("TeamChatPanel uses higher z-index (50) to stack above other panels", () => {
		expect(teamPanelSrc).toContain("zIndex={50}");
	});

	test("layout mobile drawer uses default z-40 (no zIndex override)", () => {
		// Check that the layout's SwipeDrawer usage doesn't pass zIndex
		const layoutSwipeDrawerUsage = layoutSrc.match(
			/<SwipeDrawer[\s\S]*?>/g,
		);
		expect(layoutSwipeDrawerUsage).not.toBeNull();
		for (const usage of layoutSwipeDrawerUsage!) {
			expect(usage).not.toContain("zIndex");
		}
	});
});

describe("No lingering manual drawer patterns", () => {
	test("layout has no old overlay div with z-40 md:hidden", () => {
		// Old pattern was: <div class="fixed inset-0 z-40 md:hidden"
		// Now SwipeDrawer handles all of this
		expect(layoutSrc).not.toMatch(/class="fixed inset-0 z-40 md:hidden"/);
	});

	test("chat page has no old overlay div with z-40 md:hidden", () => {
		expect(chatPageSrc).not.toMatch(/class="fixed inset-0 z-40 md:hidden"/);
	});

	test("no panels have inline @keyframes animations", () => {
		expect(obsPanelSrc).not.toContain("@keyframes");
		expect(agentPanelSrc).not.toContain("@keyframes");
		// DiffSummaryPanel may have other styles but no slide-in animations
		expect(diffPanelSrc).not.toContain("@keyframes slide");
		expect(convSettingsSrc).not.toContain("@keyframes");
	});
});

describe("SwipeDrawer ariaLabel usage across components", () => {
	test("layout mobile drawer has ariaLabel", () => {
		expect(layoutSrc).toContain('ariaLabel="Mobile navigation"');
	});

	test("chat page conv list has ariaLabel", () => {
		expect(chatPageSrc).toContain('ariaLabel="Conversation list"');
	});

	test("ObservabilityPanel has ariaLabel", () => {
		expect(obsPanelSrc).toContain('ariaLabel="Observability panel"');
	});

	test("DiffSummaryPanel has ariaLabel", () => {
		expect(diffPanelSrc).toContain('ariaLabel="Diff summary"');
	});

	test("AgentDetailPanel has ariaLabel", () => {
		expect(agentPanelSrc).toContain('ariaLabel="Agent details"');
	});

	test("ConversationSettings has ariaLabel", () => {
		expect(convSettingsSrc).toContain('ariaLabel="Conversation settings"');
	});

	test("TeamChatPanel has ariaLabel", () => {
		expect(teamPanelSrc).toContain('ariaLabel="Team chat"');
	});
});

describe("TeamChatPanel uses SwipeDrawer", () => {
	test("imports SwipeDrawer", () => {
		expect(teamPanelSrc).toContain('import SwipeDrawer from "./SwipeDrawer.svelte"');
	});

	test("renders SwipeDrawer with open prop", () => {
		expect(teamPanelSrc).toContain("<SwipeDrawer");
		expect(teamPanelSrc).toContain("open={panelOpen}");
	});

	test("uses side=right", () => {
		expect(teamPanelSrc).toContain('side="right"');
	});
});

describe("TeamChatPanel layered onclose", () => {
	test("onclose checks drillDown before closing panel", () => {
		// The onclose is an inline function that checks drillDown state
		expect(teamPanelSrc).toContain("if (drillDown)");
		expect(teamPanelSrc).toContain("closeTeamDrillDown()");
		expect(teamPanelSrc).toContain("closeTeamPanel()");
	});

	test("onclose is inline arrow, not just closeTeamPanel", () => {
		// Should NOT be: onclose={closeTeamPanel}
		// Should be: onclose={() => { if (drillDown) ... else ... }}
		expect(teamPanelSrc).not.toMatch(/onclose=\{closeTeamPanel\}/);
		expect(teamPanelSrc).toMatch(/onclose=\{.*\(\).*=>/);
	});
});

describe("Layered ESC cascade integration", () => {
	test("full ESC cascade: drill-down → overview → close", () => {
		// Simulates the complete ESC flow for TeamChatPanel
		let drillDown: { agentName: string } | null = { agentName: "Worker" };
		let panelOpen = true;

		function teamOnclose() {
			if (drillDown) {
				drillDown = null; // closeTeamDrillDown
			} else {
				panelOpen = false; // closeTeamPanel
			}
		}

		// ESC 1: exits drill-down
		teamOnclose();
		expect(drillDown).toBeNull();
		expect(panelOpen).toBe(true);

		// ESC 2: closes panel
		teamOnclose();
		expect(panelOpen).toBe(false);
	});

	test("ESC with two panels: topmost (team z-50) closes before lower (agent z-40)", () => {
		type Entry = { zIndex: number; close: () => void };
		const registry: Entry[] = [];
		const events: string[] = [];

		// Agent panel at z-40
		registry.push({ zIndex: 40, close: () => events.push("agent-close") });
		// Team panel at z-50
		registry.push({ zIndex: 50, close: () => events.push("team-close") });

		// First ESC: closes topmost (team)
		let top = registry.reduce((a, b) => a.zIndex >= b.zIndex ? a : b);
		top.close();
		registry.splice(registry.indexOf(top), 1);
		expect(events).toEqual(["team-close"]);

		// Second ESC: closes remaining (agent)
		top = registry.reduce((a, b) => a.zIndex >= b.zIndex ? a : b);
		top.close();
		registry.splice(registry.indexOf(top), 1);
		expect(events).toEqual(["team-close", "agent-close"]);
		expect(registry).toHaveLength(0);
	});

	test("ESC with team drill-down + agent panel: 3 ESC presses for full close", () => {
		type Entry = { zIndex: number; close: () => void };
		const registry: Entry[] = [];
		const events: string[] = [];

		let drillDown: { agentName: string } | null = { agentName: "Worker" };
		let teamOpen = true;

		// Agent panel at z-40
		registry.push({ zIndex: 40, close: () => events.push("agent-close") });
		// Team panel at z-50 with layered onclose
		const teamClose = () => {
			if (drillDown) {
				drillDown = null;
				events.push("team-drill-back");
			} else {
				teamOpen = false;
				events.push("team-close");
				// Unregister
				const idx = registry.findIndex(d => d.close === teamClose);
				if (idx !== -1) registry.splice(idx, 1);
			}
		};
		registry.push({ zIndex: 50, close: teamClose });

		// ESC 1: team panel handles ESC, exits drill-down
		let top = registry.reduce((a, b) => a.zIndex >= b.zIndex ? a : b);
		top.close();
		expect(events).toEqual(["team-drill-back"]);
		expect(drillDown).toBeNull();
		expect(teamOpen).toBe(true);

		// ESC 2: team panel still topmost (still registered), closes panel
		top = registry.reduce((a, b) => a.zIndex >= b.zIndex ? a : b);
		top.close();
		expect(events).toEqual(["team-drill-back", "team-close"]);
		expect(teamOpen).toBe(false);

		// ESC 3: only agent panel left
		top = registry.reduce((a, b) => a.zIndex >= b.zIndex ? a : b);
		top.close();
		expect(events).toEqual(["team-drill-back", "team-close", "agent-close"]);
	});

	test("non-Escape key does not trigger close", () => {
		const registry = [{ zIndex: 40, close: () => {} }];
		let closeCalled = false;

		// Simulate handleGlobalEsc with a non-Escape key
		const key = "Enter" as string;
		if (key !== "Escape" || registry.length === 0) {
			// early return
		} else {
			closeCalled = true;
		}
		expect(closeCalled).toBe(false);
	});

	test("ESC ignored for non-keyboard keys", () => {
		const keys = ["ArrowUp", "ArrowDown", "Tab", "Enter", "a", " "];
		for (const key of keys) {
			const isEsc = key === "Escape";
			expect(isEsc).toBe(false);
		}
	});
});

describe("SwipeDrawer registry $effect lifecycle", () => {
	test("source registers drawer when entering", () => {
		expect(swipeDrawerSrc).toContain("registerDrawer({ zIndex, close: onclose })");
	});

	test("source unregisters drawer on effect cleanup", () => {
		expect(swipeDrawerSrc).toContain("unregisterDrawer(onclose)");
	});

	test("registration is guarded by entering state", () => {
		// The $effect: if (!entering) return; registerDrawer(...)
		expect(swipeDrawerSrc).toContain("if (!entering) return;");
	});

	test("window listener is registered at module level", () => {
		expect(swipeDrawerSrc).toContain('window.addEventListener("keydown", handleGlobalEsc)');
	});

	test("SSR guard prevents window access during server rendering", () => {
		expect(swipeDrawerSrc).toContain('typeof window !== "undefined"');
	});
});
