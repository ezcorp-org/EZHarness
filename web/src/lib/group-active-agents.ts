/**
 * Grouping logic for the Active Agents home page (`/active-agents`). Takes a
 * flat list of active-agent rows and groups them under their project so the
 * UI can show a project header above each bucket.
 *
 * Ordering rules:
 *   - Projects are sorted alphabetically by name (case-insensitive).
 *   - Agents without a `projectId` land in an "Unassigned" group that
 *     always appears last.
 *   - Within each group, original input order is preserved (the API already
 *     returns rows sorted by `startedAt` desc).
 *
 * If an agent's `projectId` doesn't resolve to a known project (stale row,
 * racing delete) we still surface it under a synthesized "Unknown project"
 * label rather than dropping the row silently.
 */
export interface ProjectLike {
	id: string;
	name: string;
}

export interface ActiveAgentRowLike {
	runId: string;
	projectId: string | null;
	// Other fields are passed through untouched, so keep the generic shape open.
	[key: string]: unknown;
}

export interface ActiveAgentsGroup<Row extends ActiveAgentRowLike = ActiveAgentRowLike> {
	projectId: string | null;
	projectName: string;
	agents: Row[];
}

const UNASSIGNED_LABEL = "Unassigned";
const UNKNOWN_LABEL = "Unknown project";

export function groupAgentsByProject<Row extends ActiveAgentRowLike>(
	agents: readonly Row[],
	projects: readonly ProjectLike[],
): ActiveAgentsGroup<Row>[] {
	const projectsById = new Map(projects.map((p) => [p.id, p]));
	const groups = new Map<string, ActiveAgentsGroup<Row>>();

	for (const agent of agents) {
		const key = agent.projectId ?? "__unassigned__";
		let group = groups.get(key);
		if (!group) {
			let projectName: string;
			if (agent.projectId == null) {
				projectName = UNASSIGNED_LABEL;
			} else {
				projectName = projectsById.get(agent.projectId)?.name ?? UNKNOWN_LABEL;
			}
			group = { projectId: agent.projectId, projectName, agents: [] };
			groups.set(key, group);
		}
		group.agents.push(agent);
	}

	return [...groups.values()].sort((a, b) => {
		// Unassigned always last.
		if (a.projectId == null && b.projectId == null) return 0;
		if (a.projectId == null) return 1;
		if (b.projectId == null) return -1;
		return a.projectName.localeCompare(b.projectName, undefined, { sensitivity: "base" });
	});
}
