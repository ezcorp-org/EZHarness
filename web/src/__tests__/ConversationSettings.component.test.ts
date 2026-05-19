/**
 * Phase 62-05 — Coverage for Phase 6 sub-plan 06-04 deliverable:
 * ConversationSettings.svelte's agent-scoped read-only mode.
 *
 * Covers the {#if conversation.agentConfigId} branch at
 * ConversationSettings.svelte:103-131. When an agent persona owns the
 * conversation, the system prompt is read-only ("Managed by agent
 * persona"); the editable textarea (#conv-prompt) is NOT rendered.
 *
 * Regression guard: agentConfigId=null MUST render the editable
 * textarea so the agent-scoped branch doesn't leak into regular
 * conversations. The existing conversation-settings-logic.test.ts
 * only covers prompt-level prioritization, not this render branch.
 */

import "@testing-library/jest-dom/vitest";
import { test, expect, describe, vi } from "vitest";
import { render } from "@testing-library/svelte";
import ConversationSettings from "$lib/components/ConversationSettings.svelte";

// Stub $lib/api.js so loadPromptPreview()'s $effect resolves
// deterministically on mount.
vi.mock("$lib/api.js", async (importOriginal) => {
	const orig = (await importOriginal()) as Record<string, unknown>;
	return {
		...orig,
		fetchSettings: vi.fn(async () => ({})),
		upsertSetting: vi.fn(async () => {}),
	};
});

function makeConv(overrides: Record<string, unknown> = {}) {
	return {
		id: "c-1",
		projectId: "p-1",
		title: "Test conversation",
		agentConfigId: null,
		systemPrompt: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	} as any;
}

describe("ConversationSettings — agent-scoped read-only mode", () => {
	test("agent conversation: renders read-only panel + 'Managed by agent persona' notice", () => {
		const { container, getByText } = render(ConversationSettings, {
			props: {
				conversation: makeConv({
					agentConfigId: "cfg-1",
					systemPrompt: "You are a helpful agent.",
				}),
				projectId: "p-1",
				open: true,
				onclose: () => {},
				onsave: () => {},
			},
		});

		// Read-only notice (the 11px copy under the label)
		expect(getByText(/system prompt is managed by the agent persona/i)).toBeInTheDocument();

		// The follow-up 10px notice under the panel
		expect(getByText(/managed by agent persona — edit via the agent config/i)).toBeInTheDocument();

		// The system prompt content is displayed as text inside the read-only panel
		expect(getByText("You are a helpful agent.")).toBeInTheDocument();

		// The editable textarea (#conv-prompt) is NOT in the DOM
		expect(container.querySelector("#conv-prompt")).toBeNull();
	});

	test("agent conversation with null systemPrompt: renders '(none)' fallback", () => {
		const { getByText, container } = render(ConversationSettings, {
			props: {
				conversation: makeConv({ agentConfigId: "cfg-1", systemPrompt: null }),
				projectId: "p-1",
				open: true,
				onclose: () => {},
				onsave: () => {},
			},
		});

		expect(getByText("(none)")).toBeInTheDocument();
		expect(container.querySelector("#conv-prompt")).toBeNull();
	});

	test("regular conversation (agentConfigId=null): renders editable textarea + Save button", () => {
		const { container, getByRole } = render(ConversationSettings, {
			props: {
				conversation: makeConv({ agentConfigId: null, systemPrompt: "User-set prompt." }),
				projectId: "p-1",
				open: true,
				onclose: () => {},
				onsave: () => {},
			},
		});

		const textarea = container.querySelector("#conv-prompt") as HTMLTextAreaElement | null;
		expect(textarea).not.toBeNull();
		// Save button is present (regression guard against agent-scoped branch leaking)
		expect(getByRole("button", { name: /save/i })).toBeInTheDocument();
	});

	test("regular conversation: 'Managed by agent persona' notice is NOT in DOM", () => {
		const { queryByText } = render(ConversationSettings, {
			props: {
				conversation: makeConv({ agentConfigId: null }),
				projectId: "p-1",
				open: true,
				onclose: () => {},
				onsave: () => {},
			},
		});

		expect(queryByText(/system prompt is managed by the agent persona/i)).toBeNull();
		expect(queryByText(/managed by agent persona/i)).toBeNull();
	});
});
