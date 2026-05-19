import { test, expect, describe } from "bun:test";
import {
	groupAgentsByProject,
	type ActiveAgentRowLike,
} from "$lib/group-active-agents.js";

const proj = (id: string, name: string) => ({ id, name });
const row = (runId: string, projectId: string | null): ActiveAgentRowLike => ({
	runId,
	projectId,
});

describe("groupAgentsByProject", () => {
	test("empty input → empty output", () => {
		expect(groupAgentsByProject([], [])).toEqual([]);
		expect(groupAgentsByProject([], [proj("p1", "Alpha")])).toEqual([]);
	});

	test("groups agents under their projects and sorts project groups alphabetically", () => {
		const projects = [proj("p2", "Zeta"), proj("p1", "Alpha"), proj("p3", "Mango")];
		const agents = [
			row("r1", "p2"),
			row("r2", "p1"),
			row("r3", "p3"),
			row("r4", "p1"),
		];

		const groups = groupAgentsByProject(agents, projects);

		expect(groups.map((g) => g.projectName)).toEqual(["Alpha", "Mango", "Zeta"]);
		// Alpha holds r2 and r4 (preserved input order).
		expect(groups[0]!.projectId).toBe("p1");
		expect(groups[0]!.agents.map((a) => a.runId)).toEqual(["r2", "r4"]);
		expect(groups[1]!.projectId).toBe("p3");
		expect(groups[1]!.agents.map((a) => a.runId)).toEqual(["r3"]);
		expect(groups[2]!.projectId).toBe("p2");
		expect(groups[2]!.agents.map((a) => a.runId)).toEqual(["r1"]);
	});

	test("agents without projectId fall into an 'Unassigned' group that comes last", () => {
		const projects = [proj("p1", "Alpha")];
		const agents = [row("r1", null), row("r2", "p1"), row("r3", null)];

		const groups = groupAgentsByProject(agents, projects);

		expect(groups).toHaveLength(2);
		expect(groups[0]!.projectName).toBe("Alpha");
		expect(groups[1]!.projectId).toBeNull();
		expect(groups[1]!.projectName).toBe("Unassigned");
		// Order within the unassigned group preserves input order (r1 before r3).
		expect(groups[1]!.agents.map((a) => a.runId)).toEqual(["r1", "r3"]);
	});

	test("unassigned group still last even when it is alphabetically first", () => {
		const projects = [proj("p1", "Zeta")];
		const agents = [row("r1", null), row("r2", "p1")];

		const groups = groupAgentsByProject(agents, projects);

		expect(groups.map((g) => g.projectName)).toEqual(["Zeta", "Unassigned"]);
	});

	test("agent with unknown projectId surfaces under 'Unknown project' rather than silently dropping", () => {
		const projects = [proj("p1", "Alpha")];
		const agents = [row("r1", "p-gone"), row("r2", "p1")];

		const groups = groupAgentsByProject(agents, projects);

		expect(groups.map((g) => g.projectName).sort()).toEqual(["Alpha", "Unknown project"]);
		const unknown = groups.find((g) => g.projectName === "Unknown project")!;
		expect(unknown.projectId).toBe("p-gone");
		expect(unknown.agents.map((a) => a.runId)).toEqual(["r1"]);
	});

	test("project name sort is case-insensitive", () => {
		const projects = [proj("p1", "banana"), proj("p2", "Apple")];
		const agents = [row("r1", "p1"), row("r2", "p2")];

		const groups = groupAgentsByProject(agents, projects);

		// "Apple" before "banana" regardless of case.
		expect(groups.map((g) => g.projectName)).toEqual(["Apple", "banana"]);
	});

	test("preserves original row fields untouched (generic shape)", () => {
		const projects = [proj("p1", "Alpha")];
		const agents = [
			{ runId: "r1", projectId: "p1", agentName: "Worker", startedAt: 42 },
		];

		const groups = groupAgentsByProject(agents, projects);

		expect(groups[0]!.agents[0]).toEqual({
			runId: "r1",
			projectId: "p1",
			agentName: "Worker",
			startedAt: 42,
		});
	});

	test("multiple agents for one project + unknown + unassigned at once", () => {
		const projects = [proj("p1", "Alpha"), proj("p2", "Bravo")];
		const agents = [
			row("r1", "p1"),
			row("r2", "p2"),
			row("r3", "p1"),
			row("r4", null),
			row("r5", "p-gone"),
		];

		const groups = groupAgentsByProject(agents, projects);

		const names = groups.map((g) => g.projectName);
		// Known projects (alpha sort), then "Unknown project", then "Unassigned" last.
		expect(names[names.length - 1]).toBe("Unassigned");
		expect(names.includes("Unknown project")).toBe(true);
		expect(names.includes("Alpha")).toBe(true);
		expect(names.includes("Bravo")).toBe(true);

		const alpha = groups.find((g) => g.projectName === "Alpha")!;
		expect(alpha.agents.map((a) => a.runId)).toEqual(["r1", "r3"]);
	});
});
