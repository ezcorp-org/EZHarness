/**
 * Store helpers behind the team panel, the dock and run control: each
 * transition updates the live store AND survives a reload through its
 * persisted slot.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
	closeTeamDrillDown,
	closeTeamPanel,
	openDock,
	openTeamDrillDown,
	openTeamPanel,
	readPersistedDockSlot,
	sendToolKill,
	startStreaming,
	store,
} from "$lib/stores.svelte.js";
import { readTeamPanel } from "$lib/panel-persistence.js";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("team panel", () => {
	test("open, drill in, drill out and close are each persisted", () => {
		openTeamPanel("conv-1", "team-1", "Release");
		expect(store.teamPanel).toEqual({
			open: true, agentConfigId: "team-1", teamName: "Release", conversationId: "conv-1", drillDownAgent: null,
		});
		expect(readTeamPanel()).toEqual(store.teamPanel);

		openTeamDrillDown("sub-1", "Builder", 2);
		expect(readTeamPanel()?.drillDownAgent).toEqual({ subConversationId: "sub-1", agentName: "Builder", turnIndex: 2 });

		closeTeamDrillDown();
		expect(readTeamPanel()).toMatchObject({ open: true, drillDownAgent: null });

		closeTeamPanel();
		expect(readTeamPanel()).toEqual({
			open: false, agentConfigId: null, teamName: null, conversationId: null, drillDownAgent: null,
		});
	});
});

describe("run control", () => {
	test("a run that finished before streaming started is not streamed, once", () => {
		store.completedBeforeStream = new Set(["run-done", "run-other"]);

		expect(startStreaming("run-done", "conv-1")).toBe(false);

		expect([...store.completedBeforeStream]).toEqual(["run-other"]);
		expect(store.streamingMessages["run-done"]).toBeUndefined();
	});

	test("killing a tool call posts the kill and tolerates a network failure", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
		vi.stubGlobal("fetch", fetchMock);

		sendToolKill("tc-1");

		expect(fetchMock).toHaveBeenCalledWith("/api/tool-calls/tc-1/kill", { method: "POST" });
		// The rejection is swallowed: no unhandled error reaches the test run.
		await Promise.resolve();
	});
});

describe("dock", () => {
	test("re-opening the same tool call keeps the slot and re-persists it", () => {
		openDock("conv-d", "tc-1");
		localStorage.clear();

		openDock("conv-d", "tc-1");

		expect(store.dockState["conv-d"]?.toolCallId).toBe("tc-1");
		expect(readPersistedDockSlot("conv-d")?.toolCallId).toBe("tc-1");
	});

	test("a corrupt persisted dock slot reads as none", () => {
		openDock("conv-e", "tc-2");
		const key = Object.keys(localStorage).find((k) => k.includes("conv-e"))!;
		localStorage.setItem(key, "{not json");

		expect(readPersistedDockSlot("conv-e")).toBeNull();
	});
});
