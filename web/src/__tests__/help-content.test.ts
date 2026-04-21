import { describe, test, expect } from "bun:test";
import { helpContent } from "../lib/data/help-content";

/**
 * Keys actually referenced via <InfoTooltip key="..."> in components.
 * Source: grep across web/src for `key="` on InfoTooltip usages.
 */
const COMPONENT_KEYS = [
	"agent.system-prompt", // AgentConfigForm.svelte
	"agent.model", // AgentConfigForm.svelte
	"chat.mentions", // ChatInput.svelte
	"chat.inline-tools", // InlineToolCard.svelte
	"chat.diff-panel", // DiffSummaryPanel.svelte
	"chat.sub-conversations", // chat/[convId]/+page.svelte
	"settings.providers", // settings/+page.svelte
	"knowledge.overview", // memories/+page.svelte
	"memory.overview", // memories/+page.svelte
] as const;

/**
 * Keys that exist in helpContent but are not yet referenced in any component.
 * They are intentionally available for future use or programmatic access.
 */
const INTENTIONALLY_UNUSED_KEYS = [
	"agent.extensions",
	"agent.variables",
	"settings.extensions",
	"extension.variables",
] as const;

const KEY_PATTERN = /^[a-z]+(\.[a-z][a-z0-9-]*)+$/;
const MIN_CONTENT_LENGTH = 20;
const PLACEHOLDER_PATTERNS = [/TODO/i, /FIXME/i, /placeholder/i, /lorem ipsum/i, /xxx/i];

describe("help-content data module", () => {
	const keys = Object.keys(helpContent);

	test("every key maps to a non-empty string", () => {
		for (const key of keys) {
			const value = helpContent[key];
			expect(typeof value).toBe("string");
			expect(value.trim().length).toBeGreaterThan(0);
		}
	});

	test("no duplicate content values", () => {
		const seen = new Map<string, string>();
		for (const key of keys) {
			const value = helpContent[key];
			const existing = seen.get(value);
			expect(existing).toBeUndefined();
			seen.set(value, key);
		}
	});

	test("all component-referenced keys exist in helpContent", () => {
		for (const key of COMPONENT_KEYS) {
			expect(key in helpContent).toBe(true);
		}
	});

	test("no orphaned keys (every key is either used in a component or intentionally unused)", () => {
		const accounted = new Set<string>([...COMPONENT_KEYS, ...INTENTIONALLY_UNUSED_KEYS]);
		const orphaned = keys.filter((k) => !accounted.has(k));
		expect(orphaned).toEqual([]);
	});

	test("key naming convention: dot-separated lowercase segments", () => {
		for (const key of keys) {
			expect(key).toMatch(KEY_PATTERN);
		}
	});

	describe("content quality", () => {
		test(`every value is at least ${MIN_CONTENT_LENGTH} characters`, () => {
			for (const key of keys) {
				expect(helpContent[key].length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
			}
		});

		test("no placeholder text in values", () => {
			for (const key of keys) {
				const value = helpContent[key];
				for (const pattern of PLACEHOLDER_PATTERNS) {
					expect(pattern.test(value)).toBe(false);
				}
			}
		});
	});
});
