/**
 * Unit tests for `decideInheritedMode` — the pure first-paint mode-inheritance
 * decision used by the chat route shell to seed the composer Tools popover's
 * inherited baseline (Issue 1 of the MCP tool-UI fix pass).
 */
import { describe, test, expect } from "vitest";
import type { Conversation, Mode } from "$lib/api";
import { decideInheritedMode } from "../inherit-mode";

function makeMode(over: Partial<Mode> = {}): Mode {
	return {
		id: "mode-1",
		name: "Research",
		slug: "research",
		icon: null,
		description: "",
		systemPromptInstruction: "",
		instructionPosition: "append",
		preferredModel: null,
		preferredProvider: null,
		preferredThinkingLevel: null,
		temperature: null,
		toolRestriction: "all",
		extensionIds: ["ext-a"],
		extensionTools: null,
		builtin: false,
		...over,
	};
}

function makeConv(over: Partial<Conversation> = {}): Conversation {
	return {
		id: "conv-1",
		projectId: "proj-1",
		title: "Chat",
		model: null,
		provider: null,
		systemPrompt: null,
		agentConfigId: null,
		modeId: null,
		test: null,
		extensionTools: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...over,
	};
}

describe("decideInheritedMode", () => {
	test("no sync until the conversation has loaded", () => {
		expect(
			decideInheritedMode({
				currentConversation: null,
				availableModes: [makeMode()],
				convId: "conv-1",
				lastSyncedConvId: null,
			}),
		).toEqual({ sync: false });
	});

	test("no sync until modes have loaded", () => {
		expect(
			decideInheritedMode({
				currentConversation: makeConv({ modeId: "mode-1" }),
				availableModes: [],
				convId: "conv-1",
				lastSyncedConvId: null,
			}),
		).toEqual({ sync: false });
	});

	test("modeId present → inherits the matching mode", () => {
		const mode = makeMode({ id: "mode-1" });
		const decision = decideInheritedMode({
			currentConversation: makeConv({ modeId: "mode-1" }),
			availableModes: [makeMode({ id: "mode-x" }), mode],
			convId: "conv-1",
			lastSyncedConvId: null,
		});
		expect(decision).toEqual({ sync: true, mode, syncedConvId: "conv-1" });
	});

	test("modeId null → inherits null (stays Default)", () => {
		const decision = decideInheritedMode({
			currentConversation: makeConv({ modeId: null }),
			availableModes: [makeMode()],
			convId: "conv-1",
			lastSyncedConvId: null,
		});
		expect(decision).toEqual({ sync: true, mode: null, syncedConvId: "conv-1" });
	});

	test("modeId that matches no fetched mode → inherits null", () => {
		const decision = decideInheritedMode({
			currentConversation: makeConv({ modeId: "ghost" }),
			availableModes: [makeMode({ id: "mode-1" })],
			convId: "conv-1",
			lastSyncedConvId: null,
		});
		expect(decision).toEqual({ sync: true, mode: null, syncedConvId: "conv-1" });
	});

	test("does not inherit from a stale conversation mid-navigation", () => {
		// We still hold conv-1 but the route already advanced to conv-2.
		expect(
			decideInheritedMode({
				currentConversation: makeConv({ id: "conv-1", modeId: "mode-1" }),
				availableModes: [makeMode({ id: "mode-1" })],
				convId: "conv-2",
				lastSyncedConvId: null,
			}),
		).toEqual({ sync: false });
	});

	test("already-synced id → no re-sync (mid-session change preserved)", () => {
		// A mid-session handleModeChange stamps lastSyncedConvId = convId, so a
		// later effect re-run must NOT overwrite the user's explicit pick.
		expect(
			decideInheritedMode({
				currentConversation: makeConv({ modeId: "mode-1" }),
				availableModes: [makeMode({ id: "mode-1" })],
				convId: "conv-1",
				lastSyncedConvId: "conv-1",
			}),
		).toEqual({ sync: false });
	});

	test("switching conversation id re-inherits", () => {
		// Synced conv-1 previously; now conv-2 is active and loaded → re-inherit.
		const mode = makeMode({ id: "mode-2" });
		const decision = decideInheritedMode({
			currentConversation: makeConv({ id: "conv-2", modeId: "mode-2" }),
			availableModes: [mode],
			convId: "conv-2",
			lastSyncedConvId: "conv-1",
		});
		expect(decision).toEqual({ sync: true, mode, syncedConvId: "conv-2" });
	});
});
