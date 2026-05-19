/**
 * Sanity check: the agent's `prompt` ships the "Quality bar" block.
 *
 * The Quality bar (D3) is a polish-checklist baked into the agent
 * prompt — it's the cheapest of the four hardening mitigations. If a
 * future refactor accidentally trims the prompt, this test fails
 * loudly. The block is identified by the literal heading
 * `## Quality bar` and the four sub-section names: Content quality,
 * Structure, Visuals, Tokens.
 *
 * validation: post-plan addition #D3 (Quality bar).
 */
import { test, expect, describe } from "bun:test";
import config from "./ezcorp.config";

describe("validation: claude-design Quality bar prompt block", () => {
	test("agent.prompt includes the Quality bar heading and all four sub-sections", () => {
		const prompt = config.agent?.prompt;
		expect(typeof prompt).toBe("string");
		const p = prompt as string;
		expect(p).toContain("## Quality bar");
		// Four sub-sections per the plan's D3 section.
		expect(p).toContain("Content quality:");
		expect(p).toContain("Structure:");
		expect(p).toContain("Visuals:");
		expect(p).toContain("Tokens:");
	});

	test("agent.prompt enforces the lint rules (every color through var(--color-*), spacing through var(--space-*))", () => {
		const p = (config.agent?.prompt ?? "") as string;
		// Lint surfaces these rule families verbatim — see ezcorp.config.ts.
		expect(p).toContain("var(--color-");
		expect(p).toContain("var(--space-");
	});

	test("agent.prompt enforces body↔descriptor cross-check (D2)", () => {
		const p = (config.agent?.prompt ?? "") as string;
		expect(p.toLowerCase()).toContain("body");
		expect(p.toLowerCase()).toContain("descriptor");
	});
});
