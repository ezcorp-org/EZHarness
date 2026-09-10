import "@testing-library/jest-dom/vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

const { setTaskSnapshot } = vi.hoisted(() => ({ setTaskSnapshot: vi.fn() }));
vi.mock("$lib/stores.svelte.js", () => ({
	store: {
		agentConfigs: [
			{ id: "team-1", name: "Release Team", references: { members: ["agent-1"] } },
			{ id: "agent-1", name: "Reviewer", references: { members: [] } },
		],
	},
	setTaskSnapshot,
}));
vi.mock("$lib/use-breakpoint.svelte", () => ({ useBreakpoint: () => ({ below: false }) }));

import AssignmentPicker from "$lib/components/AssignmentPicker.svelte";

afterEach(() => {
	vi.unstubAllGlobals();
	setTaskSnapshot.mockReset();
});

describe("AssignmentPicker", () => {
	test("filters available teams and agents, then assigns the selected team", async () => {
		const onclose = vi.fn();
		const response = Promise.withResolvers<Response>();
		const fetchMock = vi.fn(() => response.promise);
		vi.stubGlobal("fetch", fetchMock);
		const { getByText, getByPlaceholderText } = render(AssignmentPicker, {
			open: true,
			conversationId: "conv-1",
			taskId: "task-1",
			onclose,
		});
		expect(getByText("Teams")).toBeInTheDocument();
		expect(getByText("Release Team")).toBeInTheDocument();
		expect(getByText("Agents")).toBeInTheDocument();
		const search = getByPlaceholderText("Search agents...");
		await fireEvent.input(search, { target: { value: "release" } });
		expect(getByText("Release Team")).toBeInTheDocument();
		await fireEvent.click(getByText("Release Team"));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conv-1/tasks/task-1/assign",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ agentConfigId: "team-1" }) }),
		));
		expect(setTaskSnapshot).not.toHaveBeenCalled();
		expect(onclose).not.toHaveBeenCalled();
		response.resolve(new Response(JSON.stringify({ snapshot: { conversationId: "conv-1", tasks: [] } }), { status: 200 }));
		await waitFor(() => {
			expect(setTaskSnapshot).toHaveBeenCalledWith({ conversationId: "conv-1", tasks: [] });
			expect(onclose).toHaveBeenCalledTimes(1);
		});
	});

	test("shows an empty search state and closes with Escape or an outside click", async () => {
		const onclose = vi.fn();
		const { getByPlaceholderText, getByText } = render(AssignmentPicker, {
			open: true,
			conversationId: "conv-1",
			taskId: "task-1",
			onclose,
		});
		await fireEvent.input(getByPlaceholderText("Search agents..."), { target: { value: "missing" } });
		expect(getByText("No agents found")).toBeInTheDocument();
		await fireEvent.keyDown(document, { key: "Escape" });
		expect(onclose).toHaveBeenCalledTimes(1);
		await fireEvent.mouseDown(document.body);
		expect(onclose).toHaveBeenCalledTimes(2);
	});
});
