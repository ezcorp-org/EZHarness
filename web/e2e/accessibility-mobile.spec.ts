/**
 * Phase 49.5 — Mobile-viewport WCAG 2.1 AA scan.
 *
 * The desktop axe sweep lives in `accessibility.spec.ts` and pins the
 * v1.2 baseline at default viewport (typically 1280×720). Phase 49
 * widened the responsive breakpoint to `<lg` so the mobile shell
 * (hamburger + drawer) is now the dominant layout for tablets too.
 * That meant a fresh axe pass at `375×667` (iPhone SE) was a
 * phase-exit gate — this spec is that gate.
 *
 * Routes covered (Phase 49 spec § 49.5.1):
 *   - `/` (Dashboard / home)
 *   - `/agents` (with the new search input visible)
 *   - `/agents/new` (with the new "Browse extensions" button)
 *   - `/agents/[name]` (edit form, same picker)
 *   - `/extensions` (no Phase 49 changes, regression check)
 *   - `/marketplace` (with the new tag sidebar visible)
 *
 * `knownRules` mirrors the desktop spec's pre-existing exclusions
 * so this run measures Phase 49 deltas only — fixing those
 * unrelated violations is tracked separately.
 */

import { test, expect } from "./fixtures/test-base.js";
import AxeBuilder from "@axe-core/playwright";
import {
	makeAgent,
	makeAgentConfig,
	makeProject,
	makeConversation,
	makeMessage,
	makeWorkflow,
} from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "A11y Mobile" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
const msg = makeMessage({ id: "msg-1", conversationId: "conv-1", role: "user", content: "Hi" });
const agentConfig = makeAgentConfig({
	id: "ac-mobile",
	name: "mobile-agent",
	prompt: "You help mobile users.",
	description: "An agent for the mobile a11y test.",
});
const agent = makeAgent({
	name: "mobile-agent",
	source: "config",
	id: "ac-mobile",
	prompt: "You help mobile users.",
	description: "An agent for the mobile a11y test.",
});

const pages = [
	{ name: "Dashboard", url: "/", knownRules: [] as string[] },
	{ name: "Agents", url: "/agents", knownRules: [] },
	{ name: "Agent New", url: "/agents/new", knownRules: [] },
	// Detail page goes through `/agents/[name]` → uses agent.name.
	{ name: "Agent Detail", url: `/agents/${encodeURIComponent(agent.name)}`, knownRules: [] },
	// Mirror the desktop spec's pre-existing exclusions on these
	// routes — Phase 49 didn't introduce new violations on them, but
	// the v1.2 ones still exist and are tracked separately.
	{ name: "Extensions", url: "/extensions", knownRules: ["color-contrast"] },
	{ name: "Marketplace", url: "/marketplace", knownRules: ["color-contrast", "select-name"] },
] as const;

function formatViolations(violations: import("axe-core").Result[]): string {
	if (violations.length === 0) return "No violations";
	return violations
		.map((v) => {
			const nodes = v.nodes
				.slice(0, 3)
				.map((n) => `    - ${n.html.substring(0, 120)}`)
				.join("\n");
			return `[${v.impact}] ${v.id}: ${v.description}\n  Help: ${v.helpUrl}\n  Affected nodes (up to 3):\n${nodes}`;
		})
		.join("\n\n");
}

test.describe("Phase 49.5 — WCAG 2.1 AA @ 375×667 (mobile)", () => {
	test.use({ viewport: { width: 375, height: 667 } });

	for (const pg of pages) {
		test(`${pg.name} (${pg.url}) — no a11y violations on mobile`, async ({ page, mockApi }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [msg],
				agents: [agent],
				agentConfigs: [agentConfig],
				workflows: [makeWorkflow()],
			});

			await page.goto(pg.url);
			await page.waitForLoadState("networkidle");
			// Give the layout a beat to settle — particularly the mobile
			// header and any responsive reflow on the new tag sidebar.
			await page.waitForTimeout(500);

			const builder = new AxeBuilder({ page }).withTags([
				"wcag2a",
				"wcag2aa",
				"wcag21a",
				"wcag21aa",
			]);
			if (pg.knownRules.length > 0) {
				builder.disableRules([...pg.knownRules]);
			}
			const results = await builder.analyze();
			expect(
				results.violations,
				`Mobile a11y violations on ${pg.name}:\n${formatViolations(results.violations)}`,
			).toEqual([]);
		});
	}
});
