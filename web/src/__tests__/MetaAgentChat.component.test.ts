/**
 * Phase 62 sub-plan 06 — MetaAgentChat onconfig wiring.
 *
 * The component POSTs to /api/agent-configs/generate and conditionally
 * invokes onconfig() only when the response body includes a non-null
 * `config` field. Covers MetaAgentChat.svelte:76-78 — the client-side
 * branch that gates the prefill handoff from chat to AgentEditor.
 *
 * The e2e at agents-new.spec.ts:14 only asserts the Describe tab
 * renders; it does not drive `sendMessage` or assert `onconfig` fires.
 * These vitest cases close that coverage gap.
 *
 * Driving notes:
 *   - ChatInput.svelte:592 gates submit() on `selectedModel` being set,
 *     so the test must let ModelSelector's /api/models fetch land and
 *     fire onautoselect before pressing Enter. We stub /api/models with
 *     one available model so the autoselect path resolves deterministically.
 *   - ChatInput's textarea is `role="combobox"` (mention listbox owner),
 *     not "textbox", so we locate it via `.chat-textarea`.
 */

import "@testing-library/jest-dom/vitest";
import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";
import MetaAgentChat from "$lib/components/MetaAgentChat.svelte";
import { __resetCapabilityCacheForTests } from "$lib/chat/attachment-client";

const originalFetch = globalThis.fetch;

type GenerateBody = { text: string; config: Record<string, unknown> | null };

/**
 * Stub fetch so:
 *   /api/models → one available model (drives autoselect → submit unlocks)
 *   /api/modes  → []
 *   /api/agent-configs/generate → caller-supplied body
 *   everything else → []
 */
function stubFetch(generateBody: GenerateBody) {
	globalThis.fetch = vi.fn(async (input: any) => {
		const url = typeof input === "string" ? input : input?.url;
		// IMPORTANT: order matters — `/api/models/capabilities` shares a
		// prefix with `/api/models`, so the capabilities branch must come
		// first.
		if (url?.includes("/api/models/capabilities")) {
			// ChatInput's $effect hits this once a model is selected.
			// Return a minimal text-only capability so the derived
			// `attachmentsSupported` evaluates safely.
			return new Response(
				JSON.stringify({
					provider: "anthropic",
					model: "claude-test",
					kinds: ["text"],
					acceptedMimeTypes: [],
					maxBytesPerFile: 1024,
					maxFilesPerMessage: 0,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		if (url?.includes("/api/models")) {
			return new Response(
				JSON.stringify([
					{
						provider: "anthropic",
						model: "claude-test",
						available: true,
						reasoning: false,
						contextWindow: 200000,
					},
				]),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		if (url?.includes("/api/modes")) {
			return new Response(JSON.stringify([]), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url?.includes("/api/agent-configs/generate")) {
			return new Response(JSON.stringify(generateBody), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify([]), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as any;
	return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

function callsTo(fetchSpy: ReturnType<typeof vi.fn>, pathFragment: string): number {
	return fetchSpy.mock.calls.filter((c) => {
		const url = typeof c[0] === "string" ? c[0] : (c[0] as any)?.url;
		return typeof url === "string" && url.includes(pathFragment);
	}).length;
}

describe("MetaAgentChat — onconfig wiring", () => {
	beforeEach(() => {
		cleanup();
		// attachment-client caches capability promises per (provider,model);
		// flush between cases so the stubbed /api/models/capabilities is
		// re-hit each render.
		__resetCapabilityCacheForTests();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	test("onconfig fires when /api/agent-configs/generate returns a non-null config", async () => {
		const onconfig = vi.fn();
		const fetchSpy = stubFetch({
			text: "Here is your agent.",
			config: { name: "my-agent", prompt: "do things" },
		});

		const { container } = render(MetaAgentChat, { props: { onconfig } });

		// Wait for /api/models to land and onautoselect to unlock submit().
		await waitFor(
			() => expect(callsTo(fetchSpy, "/api/models")).toBeGreaterThan(0),
			{ timeout: 2000 },
		);

		const textarea = container.querySelector<HTMLTextAreaElement>(".chat-textarea");
		expect(textarea).not.toBeNull();
		await fireEvent.input(textarea!, { target: { value: "Make me an agent." } });
		// Wait until the Send button is enabled (autoselect resolved).
		await waitFor(
			() => {
				const btn = container.querySelector<HTMLButtonElement>(
					'button[aria-label="Send message"]',
				);
				expect(btn).not.toBeNull();
				expect(btn!.disabled).toBe(false);
			},
			{ timeout: 2000 },
		);
		// ChatInput.svelte:423 — Enter (without Shift) submits.
		await fireEvent.keyDown(textarea!, { key: "Enter" });

		await waitFor(
			() => expect(onconfig).toHaveBeenCalledTimes(1),
			{ timeout: 2000 },
		);
		expect(onconfig).toHaveBeenCalledWith({ name: "my-agent", prompt: "do things" });
	});

	test("onconfig does NOT fire when fetch returns config=null", async () => {
		const onconfig = vi.fn();
		const fetchSpy = stubFetch({ text: "Tell me more.", config: null });

		const { container } = render(MetaAgentChat, { props: { onconfig } });

		await waitFor(
			() => expect(callsTo(fetchSpy, "/api/models")).toBeGreaterThan(0),
			{ timeout: 2000 },
		);

		const textarea = container.querySelector<HTMLTextAreaElement>(".chat-textarea");
		expect(textarea).not.toBeNull();
		await fireEvent.input(textarea!, { target: { value: "Hi." } });
		await waitFor(
			() => {
				const btn = container.querySelector<HTMLButtonElement>(
					'button[aria-label="Send message"]',
				);
				expect(btn).not.toBeNull();
				expect(btn!.disabled).toBe(false);
			},
			{ timeout: 2000 },
		);
		await fireEvent.keyDown(textarea!, { key: "Enter" });

		// Wait for the generate POST to land so we know the conditional
		// branch at MetaAgentChat.svelte:76 has been evaluated.
		await waitFor(
			() => expect(callsTo(fetchSpy, "/api/agent-configs/generate")).toBeGreaterThan(0),
			{ timeout: 2000 },
		);

		// Settle the microtask queue so the post-fetch `.then` chain runs.
		await new Promise((r) => setTimeout(r, 50));

		expect(onconfig).not.toHaveBeenCalled();
	});
});
