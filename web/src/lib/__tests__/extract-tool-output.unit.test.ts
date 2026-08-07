/**
 * `extractToolOutput` — the unwrapper every tool card's output goes through.
 *
 * It had no test. FOUR files carried a hand-copied re-implementation of it and
 * asserted against the COPY, because the real one wasn't exported — so the
 * shipped function's `content: [{type:"text"}]` branch was never executed by
 * anything while its clones were thoroughly covered:
 *   web/src/__tests__/stores-tool-event-routing.test.ts
 *   web/src/__tests__/streaming-tool-calls-status.test.ts
 *   web/src/__tests__/price-chart-stream-bridge.test.ts
 *   src/__tests__/tool-output-extraction.test.ts  ← a whole file named after it
 * A FIFTH copy is in product code: `stringifyError` in
 * web/src/lib/inline-tool-store.svelte.ts. Collapsing all six onto this
 * function is follow-up work — inline-tool-store is one of the modules the
 * vitest coverage leg cannot measure yet.
 *
 * Vitest rather than bun:test because the module is a Svelte 5 rune file
 * (`.svelte.ts`) and needs the rune transform at import time — the one
 * sanctioned Vitest surface (web/CLAUDE.md). It is on BOTH of the coverage
 * leg's hand-maintained allowlists in scripts/test-coverage.sh (the run list
 * and `--coverage.include`), which is what makes it actually measure.
 */
import { test, expect, describe } from 'vitest';
import { extractToolOutput } from '$lib/stores.svelte';

describe('extractToolOutput', () => {
	test('joins the text parts of a ToolCallResult content array', () => {
		expect(
			extractToolOutput({
				content: [
					{ type: 'text', text: 'first' },
					{ type: 'text', text: 'second' }
				]
			})
		).toBe('first\nsecond');
	});

	test('ignores non-text parts and parts whose text is not a string', () => {
		expect(
			extractToolOutput({
				content: [
					{ type: 'image', data: 'ignored' },
					{ type: 'text', text: 42 },
					{ type: 'text', text: 'kept' }
				]
			})
		).toBe('kept');
	});

	test('returns the value unchanged when no part yields text', () => {
		// Not "" and not undefined: the caller JSON.stringifies a non-string
		// result, so collapsing an unrecognised shape to an empty string would
		// silently blank the tool card instead of showing the raw payload.
		const value = { content: [{ type: 'image', data: 'x' }] };
		expect(extractToolOutput(value)).toBe(value);
	});

	test('returns the value unchanged when content is not an array', () => {
		const value = { content: 'not an array' };
		expect(extractToolOutput(value)).toBe(value);
	});

	test('passes primitives and null straight through', () => {
		expect(extractToolOutput('plain')).toBe('plain');
		expect(extractToolOutput(7)).toBe(7);
		expect(extractToolOutput(null)).toBe(null);
		expect(extractToolOutput(undefined)).toBe(undefined);
	});
});
