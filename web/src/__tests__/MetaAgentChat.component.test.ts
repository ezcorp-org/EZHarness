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

type GenerateBody = {
	text: string;
	config: Record<string, unknown> | null;
	error?: string;
	status?: number;
};

/**
 * Stub fetch so:
 *   /api/models → one available model (drives autoselect → submit unlocks)
 *   /api/modes  → []
 *   /api/agent-configs/generate → caller-supplied body
 *   everything else → []
 */
function stubFetch(generateBody: GenerateBody, options: { reasoning?: boolean; modes?: unknown[] } = {}) {
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
						reasoning: options.reasoning ?? false,
						contextWindow: 200000,
					},
					{
						provider: "openai",
						model: "gpt-test",
						available: true,
						reasoning: true,
						contextWindow: 128000,
					},
				]),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		if (url?.includes("/api/modes")) {
			return new Response(JSON.stringify(options.modes ?? []), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url?.includes("/api/agent-configs/generate")) {
			return new Response(JSON.stringify(generateBody), {
				status: generateBody.status ?? 200,
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

	test("persists explicit model, thinking, and mode selections made in the composer", async () => {
		const mode = {
			id: "mode-deep", name: "Deep planning", slug: "deep-planning", icon: "✨",
			description: "Plan carefully", systemPromptInstruction: "plan", instructionPosition: "append",
			preferredModel: null, preferredProvider: null, preferredTier: null, preferredThinkingLevel: "xhigh",
			temperature: null, toolRestriction: "all", extensionIds: null, extensionTools: null, builtin: false,
		};
		stubFetch({ text: "", config: null }, { reasoning: true, modes: [mode] });
		const { container } = render(MetaAgentChat, { props: { onconfig: vi.fn() } });
		const modelSelector = await waitFor(() => {
			const el = container.querySelector<HTMLElement>('[data-testid="model-selector"]');
			expect(el).not.toBeNull();
			return el!;
		});
		await fireEvent.click(modelSelector.querySelector("button")!);
		const gptOption = await waitFor(() => {
			const option = Array.from(modelSelector.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((candidate) => candidate.textContent?.includes("gpt-test"));
			expect(option).toBeDefined();
			return option!;
		});
		await fireEvent.click(gptOption);
		expect(localStorage.getItem("ezcorp-last-model")).toBe(JSON.stringify({ provider: "openai", model: "gpt-test" }));

		const thinkingSelector = await waitFor(() => {
			const el = container.querySelector<HTMLElement>('[data-testid="thinking-selector"]');
			expect(el).not.toBeNull();
			return el!;
		});
		await fireEvent.click(thinkingSelector.querySelector("button")!);
		const high = await waitFor(() => {
			const option = Array.from(thinkingSelector.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((candidate) => candidate.textContent?.includes("High"));
			expect(option).toBeDefined();
			return option!;
		});
		await fireEvent.click(high);
		expect(localStorage.getItem("ezcorp-thinking-level")).toBe("high");

		const modeSelector = await waitFor(() => {
			const el = container.querySelector<HTMLElement>('[data-testid="mode-selector"]');
			expect(el).not.toBeNull();
			return el!;
		});
		await fireEvent.click(modeSelector.querySelector("button")!);
		const modeOption = await waitFor(() => {
			const option = Array.from(modeSelector.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((candidate) => candidate.textContent?.includes("Deep planning"));
			expect(option).toBeDefined();
			return option!;
		});
		await fireEvent.click(modeOption);
		expect(localStorage.getItem("ezcorp-thinking-level")).toBe("xhigh");
	});

	test("shows the server error and does not add a false assistant reply when generation is rejected", async () => {
		const fetchSpy = stubFetch({
			text: "",
			config: null,
			error: "A team name is required",
			status: 422,
		});
		const { container, getByText } = render(MetaAgentChat, { props: { onconfig: vi.fn() } });
		await waitFor(() => expect(callsTo(fetchSpy, "/api/models")).toBeGreaterThan(0));
		const textarea = container.querySelector<HTMLTextAreaElement>(".chat-textarea");
		expect(textarea).not.toBeNull();
		await fireEvent.input(textarea!, { target: { value: "Create a team" } });
		await waitFor(() => expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.disabled).toBe(false));
		await fireEvent.keyDown(textarea!, { key: "Enter" });
		await waitFor(() => expect(getByText("A team name is required")).toBeInTheDocument());
		expect(container).not.toHaveTextContent("Here is your agent.");
	});
});
