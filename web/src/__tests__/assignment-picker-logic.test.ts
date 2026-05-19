import { describe, test, expect } from "bun:test";

/**
 * Logic tests for AssignmentPicker.svelte.
 *
 * Svelte 5 runes can't run under bun:test, so we mirror the component's
 * pure filtering/splitting logic as plain functions and test them directly.
 *
 * Mirrors the derivations in web/src/lib/components/AssignmentPicker.svelte
 * (lines 43–69).
 */

// ── Types mirrored from api.ts AgentConfig (simplified) ─────────────────

interface AgentConfig {
	id: string;
	name: string;
	references?: { members?: unknown[] } | null;
}

// ── Pure logic extracted from AssignmentPicker.svelte ────────────────────

/**
 * Splits configs into teams (references.members non-empty) and agents.
 * Mirrors `teams` (lines 45–49) and `agents` (lines 52–56).
 */
function splitConfigs(configs: AgentConfig[]): { teams: AgentConfig[]; agents: AgentConfig[] } {
	const teams = configs.filter((c) => {
		const refs = c.references;
		return Array.isArray(refs?.members) && refs!.members!.length > 0;
	});
	const agents = configs.filter((c) => {
		const refs = c.references;
		return !Array.isArray(refs?.members) || refs!.members!.length === 0;
	});
	return { teams, agents };
}

/**
 * Filters a list of configs by case-insensitive name match.
 * Mirrors `query` (line 59) + `filteredTeams`/`filteredAgents` (lines 61–66).
 */
function filterByQuery(configs: AgentConfig[], query: string): AgentConfig[] {
	const q = query.toLowerCase().trim();
	if (!q) return configs;
	return configs.filter((c) => c.name.toLowerCase().includes(q));
}

/**
 * Combined: split into teams/agents, then filter each by query.
 * Mirrors the full derivation chain.
 */
function filteredSplit(
	configs: AgentConfig[],
	query: string,
): { filteredTeams: AgentConfig[]; filteredAgents: AgentConfig[]; hasResults: boolean } {
	const { teams, agents } = splitConfigs(configs);
	const filteredTeams = filterByQuery(teams, query);
	const filteredAgents = filterByQuery(agents, query);
	return {
		filteredTeams,
		filteredAgents,
		hasResults: filteredTeams.length > 0 || filteredAgents.length > 0,
	};
}

// ── Factory ─────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<AgentConfig> & { id: string; name: string }): AgentConfig {
	return {
		references: null,
		...overrides,
	};
}

// ── splitConfigs ────────────────────────────────────────────────────────

describe("splitConfigs — team vs agent classification", () => {
	test("config with non-empty members array is a team", () => {
		const configs = [
			makeConfig({ id: "t1", name: "Ops Team", references: { members: [{ id: "a" }] } }),
		];
		const { teams, agents } = splitConfigs(configs);
		expect(teams).toHaveLength(1);
		expect(teams[0]!.id).toBe("t1");
		expect(agents).toHaveLength(0);
	});

	test("config with empty members array is an agent", () => {
		const configs = [
			makeConfig({ id: "a1", name: "Coder", references: { members: [] } }),
		];
		const { teams, agents } = splitConfigs(configs);
		expect(teams).toHaveLength(0);
		expect(agents).toHaveLength(1);
		expect(agents[0]!.id).toBe("a1");
	});

	test("config with no references is an agent", () => {
		const configs = [
			makeConfig({ id: "a2", name: "Writer" }),
		];
		const { teams, agents } = splitConfigs(configs);
		expect(teams).toHaveLength(0);
		expect(agents).toHaveLength(1);
	});

	test("config with null references is an agent", () => {
		const configs = [
			makeConfig({ id: "a3", name: "Reviewer", references: null }),
		];
		const { teams, agents } = splitConfigs(configs);
		expect(teams).toHaveLength(0);
		expect(agents).toHaveLength(1);
	});

	test("config with references but no members key is an agent", () => {
		const configs = [
			makeConfig({ id: "a4", name: "Tester", references: {} }),
		];
		const { teams, agents } = splitConfigs(configs);
		expect(teams).toHaveLength(0);
		expect(agents).toHaveLength(1);
	});

	test("mixed configs split correctly", () => {
		const configs = [
			makeConfig({ id: "t1", name: "Alpha Team", references: { members: [{ id: "x" }] } }),
			makeConfig({ id: "a1", name: "Solo Agent" }),
			makeConfig({ id: "t2", name: "Beta Team", references: { members: [{ id: "y" }, { id: "z" }] } }),
			makeConfig({ id: "a2", name: "Reviewer", references: { members: [] } }),
		];
		const { teams, agents } = splitConfigs(configs);
		expect(teams.map((c) => c.id)).toEqual(["t1", "t2"]);
		expect(agents.map((c) => c.id)).toEqual(["a1", "a2"]);
	});

	test("every config is accounted for (teams + agents = total)", () => {
		const configs = [
			makeConfig({ id: "1", name: "A", references: { members: [{}] } }),
			makeConfig({ id: "2", name: "B" }),
			makeConfig({ id: "3", name: "C", references: null }),
			makeConfig({ id: "4", name: "D", references: { members: [] } }),
		];
		const { teams, agents } = splitConfigs(configs);
		expect(teams.length + agents.length).toBe(configs.length);
	});
});

// ── filterByQuery ───────────────────────────────────────────────────────

describe("filterByQuery — search filtering", () => {
	const configs = [
		makeConfig({ id: "1", name: "Code Writer" }),
		makeConfig({ id: "2", name: "Test Runner" }),
		makeConfig({ id: "3", name: "Code Reviewer" }),
	];

	test("empty query returns all configs", () => {
		expect(filterByQuery(configs, "")).toEqual(configs);
	});

	test("whitespace-only query returns all configs", () => {
		expect(filterByQuery(configs, "   ")).toEqual(configs);
	});

	test("case-insensitive substring match", () => {
		const result = filterByQuery(configs, "code");
		expect(result.map((c) => c.id)).toEqual(["1", "3"]);
	});

	test("uppercase query still matches", () => {
		const result = filterByQuery(configs, "CODE");
		expect(result.map((c) => c.id)).toEqual(["1", "3"]);
	});

	test("mixed-case query matches", () => {
		const result = filterByQuery(configs, "CoDE");
		expect(result.map((c) => c.id)).toEqual(["1", "3"]);
	});

	test("partial match works", () => {
		const result = filterByQuery(configs, "run");
		expect(result.map((c) => c.id)).toEqual(["2"]);
	});

	test("no match returns empty array", () => {
		expect(filterByQuery(configs, "zzzz")).toEqual([]);
	});

	test("query with leading/trailing whitespace is trimmed", () => {
		const result = filterByQuery(configs, "  runner  ");
		expect(result.map((c) => c.id)).toEqual(["2"]);
	});
});

// ── filteredSplit (combined) ────────────────────────────────────────────

describe("filteredSplit — combined split + search", () => {
	const configs = [
		makeConfig({ id: "t1", name: "Dev Team", references: { members: [{ id: "a" }] } }),
		makeConfig({ id: "t2", name: "QA Team", references: { members: [{ id: "b" }] } }),
		makeConfig({ id: "a1", name: "Dev Agent" }),
		makeConfig({ id: "a2", name: "Writer" }),
	];

	test("no query: returns all teams and agents", () => {
		const { filteredTeams, filteredAgents, hasResults } = filteredSplit(configs, "");
		expect(filteredTeams.map((c) => c.id)).toEqual(["t1", "t2"]);
		expect(filteredAgents.map((c) => c.id)).toEqual(["a1", "a2"]);
		expect(hasResults).toBe(true);
	});

	test("query 'dev' matches one team and one agent", () => {
		const { filteredTeams, filteredAgents, hasResults } = filteredSplit(configs, "dev");
		expect(filteredTeams.map((c) => c.id)).toEqual(["t1"]);
		expect(filteredAgents.map((c) => c.id)).toEqual(["a1"]);
		expect(hasResults).toBe(true);
	});

	test("query 'team' matches only teams (name contains 'team')", () => {
		const { filteredTeams, filteredAgents, hasResults } = filteredSplit(configs, "team");
		expect(filteredTeams.map((c) => c.id)).toEqual(["t1", "t2"]);
		expect(filteredAgents).toHaveLength(0);
		expect(hasResults).toBe(true);
	});

	test("query 'writer' matches only agent", () => {
		const { filteredTeams, filteredAgents, hasResults } = filteredSplit(configs, "writer");
		expect(filteredTeams).toHaveLength(0);
		expect(filteredAgents.map((c) => c.id)).toEqual(["a2"]);
		expect(hasResults).toBe(true);
	});

	test("query with no matches → hasResults=false", () => {
		const { filteredTeams, filteredAgents, hasResults } = filteredSplit(configs, "nope");
		expect(filteredTeams).toHaveLength(0);
		expect(filteredAgents).toHaveLength(0);
		expect(hasResults).toBe(false);
	});
});

// ── Empty states ────────────────────────────────────────────────────────

describe("empty states", () => {
	test("no configs at all → empty split, hasResults=false", () => {
		const { filteredTeams, filteredAgents, hasResults } = filteredSplit([], "");
		expect(filteredTeams).toHaveLength(0);
		expect(filteredAgents).toHaveLength(0);
		expect(hasResults).toBe(false);
	});

	test("no configs + query → still empty, hasResults=false", () => {
		const { filteredTeams, filteredAgents, hasResults } = filteredSplit([], "anything");
		expect(filteredTeams).toHaveLength(0);
		expect(filteredAgents).toHaveLength(0);
		expect(hasResults).toBe(false);
	});

	test("only teams, no agents", () => {
		const configs = [
			makeConfig({ id: "t1", name: "Only Team", references: { members: [{}] } }),
		];
		const { filteredTeams, filteredAgents, hasResults } = filteredSplit(configs, "");
		expect(filteredTeams).toHaveLength(1);
		expect(filteredAgents).toHaveLength(0);
		expect(hasResults).toBe(true);
	});

	test("only agents, no teams", () => {
		const configs = [
			makeConfig({ id: "a1", name: "Solo" }),
		];
		const { filteredTeams, filteredAgents, hasResults } = filteredSplit(configs, "");
		expect(filteredTeams).toHaveLength(0);
		expect(filteredAgents).toHaveLength(1);
		expect(hasResults).toBe(true);
	});
});
