import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import TeamBuilderForm from "./TeamBuilderForm.svelte";

const agents = [
	{ id: "agent-1", name: "Builder", description: "Builds the change", category: "agent", extensions: ["ext-1"], provider: "openai", model: "gpt-5", prompt: "Build safely" },
	{ id: "agent-2", name: "Reviewer", description: "Reviews the result", category: "agent", extensions: [], provider: "anthropic", model: "sonnet", prompt: "Review carefully" },
] as any[];

function stubCatalogs() {
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
		const path = String(input);
		if (path === "/api/extensions") return new Response(JSON.stringify([{ id: "ext-1", name: "filesystem" }]));
		if (path === "/api/tools") return new Response(JSON.stringify({ tools: [{ extension: "filesystem", name: "read_file", description: "Read a file", extensionType: "extension" }] }));
		if (path === "/api/user/agent-picker") return new Response(JSON.stringify({ savedSearches: [], pinned: [] }));
		return new Response("missing", { status: 404 });
	}));
}

afterEach(() => vi.unstubAllGlobals());

describe("TeamBuilderForm", () => {
	test("shows each required error before it accepts an incomplete team", async () => {
		stubCatalogs();
		const onsubmit = vi.fn();
		const { container } = render(TeamBuilderForm, { agentConfigs: agents, onsubmit });
		await fireEvent.submit(container.querySelector("form")!);
		expect(screen.getByText("Name is required")).toBeInTheDocument();
		await fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Release" } });
		await fireEvent.submit(container.querySelector("form")!);
		expect(screen.getByText("Coordination instructions are required")).toBeInTheDocument();
		await fireEvent.input(screen.getByLabelText("Coordination Instructions"), { target: { value: "Coordinate carefully" } });
		await fireEvent.submit(container.querySelector("form")!);
		expect(screen.getByText("Add at least one team member")).toBeInTheDocument();
		expect(onsubmit).not.toHaveBeenCalled();
	});

	test("adds an agent through its picker and submits the complete team contract", async () => {
		stubCatalogs();
		const onsubmit = vi.fn();
		const { container } = render(TeamBuilderForm, { agentConfigs: agents, onsubmit });
		await fireEvent.input(screen.getByLabelText("Name"), { target: { value: " Release team " } });
		await fireEvent.input(screen.getByLabelText("Description"), { target: { value: " Ship safely " } });
		await fireEvent.input(screen.getByLabelText("Coordination Instructions"), { target: { value: " Review every patch " } });
		await fireEvent.click(screen.getByText("Auto-invoke all members"));
		const picker = screen.getByPlaceholderText("Search and add a member...");
		await fireEvent.focus(picker);
		await fireEvent.keyDown(picker, { key: "ArrowDown" });
		await fireEvent.keyDown(picker, { key: "Enter" });
		await screen.findByText("Builder");
		expect(screen.getByTestId("member-default-tools")).toHaveTextContent("filesystem");
		await fireEvent.submit(container.querySelector("form")!);
		await waitFor(() => expect(onsubmit).toHaveBeenCalledWith({
			name: "Release team",
			description: "Ship safely",
			prompt: "Review every patch",
			category: "team",
			references: {
				agents: ["agent-1"],
				extensions: [],
				members: [{ agentConfigId: "agent-1" }],
				autoSpinUp: true,
			},
		}));
	});

	test("preserves nested members and saved tool scope when an existing team is edited", async () => {
		stubCatalogs();
		const onsubmit = vi.fn();
		const { container } = render(TeamBuilderForm, {
			agentConfigs: agents,
			onsubmit,
			initial: {
				name: "Existing", prompt: "Delegate", references: {
					members: [{ agentConfigId: "agent-1", subAgents: [{ agentConfigId: "agent-2" }] }],
					teamToolScope: { allowedTools: ["filesystem__read_file"] },
				},
			},
		});
		expect(screen.getByText("Reviewer")).toBeInTheDocument();
		await fireEvent.submit(container.querySelector("form")!);
		expect(onsubmit).toHaveBeenCalledWith(expect.objectContaining({
			references: expect.objectContaining({
				agents: ["agent-1", "agent-2"],
				teamToolScope: { allowedTools: ["filesystem__read_file"] },
			}),
		}));
	});

	test("shows inherited member configuration, then permits resetting an edited override", async () => {
		stubCatalogs();
		render(TeamBuilderForm, {
			agentConfigs: agents,
			onsubmit: vi.fn(),
			initial: {
				name: "Existing", prompt: "Delegate", references: { members: [{
					agentConfigId: "agent-1",
					overrides: { provider: "openai", model: "gpt-5-mini", allowedTools: ["filesystem__read_file"], systemPromptAppend: "Be brief" },
				}] },
			},
		});
		await fireEvent.click(screen.getByText("Builder"));
		expect(screen.getByText(/Reset to inherited/)).toBeInTheDocument();
		expect(screen.getByDisplayValue("Be brief")).toBeInTheDocument();
		await fireEvent.click(screen.getByText("Reset to defaults"));
		expect(screen.queryByText(/Reset to inherited/)).toBeNull();
		await fireEvent.click(screen.getByText("Builder"));
		expect(screen.getByTestId("member-default-tools")).toHaveTextContent("filesystem");
	});

	test("adds a nested member through the member action and removes the parent without leaving stale rows", async () => {
		stubCatalogs();
		const onsubmit = vi.fn();
		const { container } = render(TeamBuilderForm, {
			agentConfigs: agents,
			onsubmit,
			initial: { name: "Existing", prompt: "Delegate", references: { members: [{ agentConfigId: "agent-1" }] } },
		});
		await fireEvent.click(screen.getByTitle("Add sub-agent"));
		const picker = screen.getByPlaceholderText("Search for sub-agent...");
		await fireEvent.focus(picker);
		await fireEvent.keyDown(picker, { key: "ArrowDown" });
		await fireEvent.keyDown(picker, { key: "ArrowDown" });
		await fireEvent.keyDown(picker, { key: "Enter" });
		await waitFor(() => expect(screen.getAllByTitle("Remove member")).toHaveLength(2));
		await fireEvent.submit(container.querySelector("form")!);
		expect(onsubmit).toHaveBeenCalledWith(expect.objectContaining({
			references: expect.objectContaining({
				agents: ["agent-1", "agent-2"],
				members: [{ agentConfigId: "agent-1", subAgents: [{ agentConfigId: "agent-2" }] }],
			}),
		}));
		await fireEvent.click(screen.getAllByTitle("Remove member")[0]!);
		expect(screen.getByText("No members added yet. Add agents to build your team.")).toBeInTheDocument();
	});

	test("a legacy team saved as a flat agent list opens as members", async () => {
		stubCatalogs();
		const onsubmit = vi.fn();
		const { container } = render(TeamBuilderForm, {
			agentConfigs: agents,
			onsubmit,
			initial: { name: "Legacy", prompt: "Delegate", references: { agents: ["agent-1", "agent-2"] } },
		});
		expect(screen.getByText("Builder")).toBeInTheDocument();
		expect(screen.getByText("Reviewer")).toBeInTheDocument();
		await fireEvent.submit(container.querySelector("form")!);
		expect(onsubmit).toHaveBeenCalledWith(expect.objectContaining({
			references: expect.objectContaining({
				members: [{ agentConfigId: "agent-1" }, { agentConfigId: "agent-2" }],
			}),
		}));
	});

	test("a collapsed member summarises each saved override as a pill", async () => {
		stubCatalogs();
		render(TeamBuilderForm, {
			agentConfigs: agents,
			onsubmit: vi.fn(),
			initial: {
				name: "Existing", prompt: "Delegate", references: { members: [
					{
						agentConfigId: "agent-1",
						overrides: {
							modeId: "mode-9",
							toolRestriction: "read-only",
							permissionMode: "plan",
							allowedTools: ["filesystem__read_file", "filesystem__list"],
							deniedTools: ["filesystem__write_file"],
						},
					},
					{ agentConfigId: "agent-2", overrides: { toolRestriction: "none" } },
				] },
			},
		});
		expect(screen.getByTitle("modeId: mode-9")).toHaveTextContent("mode override");
		expect(screen.getByText("read-only")).toHaveAttribute("title", "Tool restriction");
		expect(screen.getByTitle("Permission mode")).toHaveTextContent("plan");
		expect(screen.getByTitle("Allowed tools: filesystem__read_file, filesystem__list")).toHaveTextContent("2 allowed");
		expect(screen.getByTitle("Denied tools: filesystem__write_file")).toHaveTextContent("1 denied");
		expect(screen.getByText("no tools")).toBeInTheDocument();
	});

	test("nested members can be added, configured and removed at depth", async () => {
		stubCatalogs();
		const onsubmit = vi.fn();
		const { container } = render(TeamBuilderForm, {
			agentConfigs: agents,
			onsubmit,
			initial: { name: "Deep", prompt: "Delegate", references: { members: [
				{ agentConfigId: "agent-1", subAgents: [{ agentConfigId: "agent-2" }] },
				{ agentConfigId: "agent-2" },
			] } },
		});
		// Add a grandchild under the nested Reviewer (row 2 of 3).
		await fireEvent.click(screen.getAllByTitle("Add sub-agent")[1]!);
		const picker = screen.getByPlaceholderText("Search for sub-agent...");
		await fireEvent.focus(picker);
		await fireEvent.keyDown(picker, { key: "ArrowDown" });
		await fireEvent.keyDown(picker, { key: "Enter" });
		await waitFor(() => expect(screen.getAllByTitle("Remove member")).toHaveLength(4));

		// Give the nested Reviewer its own prompt append.
		await fireEvent.click(screen.getAllByText("Reviewer")[0]!);
		const append = screen.getByPlaceholderText("Additional instructions for this member...");
		await fireEvent.change(append, { target: { value: "Check the tests" } });

		await fireEvent.submit(container.querySelector("form")!);
		expect(onsubmit).toHaveBeenLastCalledWith(expect.objectContaining({
			references: expect.objectContaining({
				members: [
					{
						agentConfigId: "agent-1",
						subAgents: [{
							agentConfigId: "agent-2",
							overrides: { systemPromptAppend: "Check the tests" },
							subAgents: [{ agentConfigId: "agent-1" }],
						}],
					},
					{ agentConfigId: "agent-2" },
				],
			}),
		}));

		// Remove the grandchild (row 3); its siblings stay.
		await fireEvent.click(screen.getAllByTitle("Remove member")[2]!);
		await fireEvent.submit(container.querySelector("form")!);
		expect(onsubmit.mock.calls.at(-1)![0].references.members[0].subAgents[0].subAgents).toEqual([]);
		expect(screen.getAllByTitle("Remove member")).toHaveLength(3);
	});

	test("model and allowed-tool overrides each reset back to the agent defaults", async () => {
		stubCatalogs();
		const onsubmit = vi.fn();
		const { container } = render(TeamBuilderForm, {
			agentConfigs: agents,
			onsubmit,
			initial: { name: "Existing", prompt: "Delegate", references: { members: [{
				agentConfigId: "agent-1",
				overrides: { provider: "openai", model: "gpt-5-mini", allowedTools: ["filesystem__read_file"], systemPromptAppend: "Be brief" },
			}] } },
		});
		await fireEvent.click(screen.getByText("Builder"));
		await fireEvent.click(screen.getByText("Reset to inherited (openai/gpt-5)"));
		await fireEvent.click(screen.getByText(/Reset to agent defaults/));
		expect(screen.queryByText(/Reset to inherited/)).toBeNull();
		expect(screen.queryByText(/Reset to agent defaults/)).toBeNull();
		await fireEvent.submit(container.querySelector("form")!);
		expect(onsubmit.mock.calls[0]![0].references.members[0].overrides).toEqual({
			provider: undefined,
			model: undefined,
			allowedTools: undefined,
			systemPromptAppend: "Be brief",
		});
	});

	test("the sub-agent picker says so when every config is a team", async () => {
		stubCatalogs();
		const teamOnly = [{ ...agents[0], category: "team" }];
		render(TeamBuilderForm, {
			agentConfigs: teamOnly,
			onsubmit: vi.fn(),
			initial: { name: "T", prompt: "P", references: { members: [{ agentConfigId: "agent-1" }] } },
		});
		await fireEvent.click(screen.getByTitle("Add sub-agent"));
		expect(screen.getByText("No available agents to add.")).toBeInTheDocument();
	});

	test("team-wide allowed and denied tools are saved as the team tool scope", async () => {
		stubCatalogs();
		const onsubmit = vi.fn();
		const { container } = render(TeamBuilderForm, {
			agentConfigs: agents,
			onsubmit,
			initial: { name: "T", prompt: "P", references: { members: [{ agentConfigId: "agent-1" }] } },
		});
		for (const placeholder of ["Search tools to allow...", "Search tools to deny..."]) {
			const picker = screen.getByPlaceholderText(placeholder);
			await fireEvent.focus(picker);
			await screen.findByText("read_file");
			await fireEvent.keyDown(picker, { key: "ArrowDown" });
			await fireEvent.keyDown(picker, { key: "Enter" });
			await fireEvent.keyDown(picker, { key: "Escape" });
		}
		await fireEvent.submit(container.querySelector("form")!);
		expect(onsubmit.mock.calls[0]![0].references.teamToolScope).toEqual({
			allowedTools: ["filesystem__read_file"],
			deniedTools: ["filesystem__read_file"],
		});
	});
});

