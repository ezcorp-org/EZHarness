/**
 * `extractToolOutput` — the unwrapper every tool card's output goes through.
 *
 * It had no test. Three files under `web/src/__tests__/`
 * (stores-tool-event-routing, streaming-tool-calls-status,
 * price-chart-stream-bridge) each carry a hand-copied re-implementation of it
 * and assert against the COPY, because the real one wasn't exported — so the
 * shipped function's `content: [{type:"text"}]` branch was never executed by
 * anything while its clones were thoroughly covered.
 *
 * Vitest rather than bun:test because the module is a Svelte 5 rune file
 * (`.svelte.ts`) and needs the rune transform at import time — the one
 * sanctioned Vitest surface (web/CLAUDE.md).
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
