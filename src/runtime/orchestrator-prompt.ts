import type { TeamMemberOverrides, TeamToolScope } from "../types";

/**
 * Shared orchestration patterns used by both single-orchestrator and team prompts.
 */
const ORCHESTRATION_PATTERNS = `## Orchestration Patterns

**Sequential chains** - Call agent A, then use its output to inform agent B's task.
Example: research agent gathers data, then writer agent drafts a report from it.

**Parallel fan-out** - Call multiple agents simultaneously for independent tasks.
The \`invoke_agent\` tool supports parallel calls. Use this when tasks don't depend on each other.

**Conditional routing** - Based on an agent's output, decide which agent to call next.
Example: if code review finds issues, route to a fixer agent; if clean, proceed to deployment.

**Iterative refinement** - Call a reviewer agent, if issues are found call a fixer agent, then re-review. Repeat until quality is met, but cap iterations to avoid loops.

**Scratchpad for shared state** - Use \`scratchpad__scratchpad_write\` to store intermediate results (plans, data, decisions) and \`scratchpad__scratchpad_read\` to retrieve them. This lets later agent calls build on earlier outputs without stuffing everything into the task description.

**Human checkpoints** - Use \`ask_human\` when you encounter ambiguous requirements, destructive actions, or decision points with significant trade-offs. Don't block on trivial decisions.

**Task planning** - For complex multi-step work, use \`task_plan\` to decompose into tasks BEFORE starting execution. Each task should be atomic and independently verifiable. \`task_plan\` AUTOMATICALLY starts the first task — do not call \`task_start\` separately. When each task is done, call \`task_complete\` with its \`taskId\` (shown in the \`task_plan\` response) and it will auto-advance to the next pending task. Use \`task_fail\` if a task errors. Subtasks track checklist items within a task. You can assign agents/teams at plan time by including \`assignTo\` (an agentConfigId) on each task — this is preferred over separate \`task_assign\` calls. When you delegate a task to a sub-agent via \`invoke_agent\`, the task panel displays which agent owns which task, so attribution stays visible to the user throughout execution.

**Task assignment** - Prefer assigning at plan time via \`assignTo\` in \`task_plan\`. For post-hoc changes, use \`task_assign\` to assign an agent or team to a task by providing the \`taskId\` and \`agentConfigId\`. Assignments appear as pills on the task visible to the user. The user can then start the assigned agent from the UI. When an assigned agent starts, it receives the full task plan context (all tasks, statuses, and other assigned agents) so it understands the broader goal. Include detailed descriptions in each task to give assigned agents sufficient context.`;

/**
 * Task tracking instructions injected into all conversations (not just orchestrator runs).
 * This teaches single agents to decompose complex work into visible tasks.
 */
export function buildTaskTrackingInstructions(): string {
  return `## Task Tracking

You have task planning tools (\`task_plan\`, \`task_start\`, \`task_complete\`, \`task_fail\`, \`task_list\`, \`task_update\`, \`task_subtask_toggle\`, \`task_assign\`, \`task_unassign\`, \`task_list_agents\`) that show your progress to the user in a persistent panel at the bottom of the chat.

**When to plan:** If the user's request involves 3 or more distinct steps, or spans multiple files/components, call \`task_plan\` FIRST with a list of atomic tasks. Include subtasks as checklist items when a task has sub-steps.

**When NOT to plan:** Simple questions, single-file edits, quick lookups, or purely conversational responses — just answer directly without creating tasks.

**Execution flow:**
1. Call \`task_plan\` with your decomposition — the first task is AUTOMATICALLY started, so you can begin work immediately
2. Work on the active task until done
3. Call \`task_complete\` with the taskId from the \`task_plan\` response — it auto-advances to the next pending task and returns that task's taskId
4. Continue working on the next task, using the taskId from the previous \`task_complete\` response, without waiting for user input
5. If a task fails, call \`task_fail\` with the taskId and reason, then decide whether to retry, skip, or abort
6. If you lose track of taskIds mid-conversation, call \`task_list\` to see every current taskId

**Parameter format:** Every tool that takes a \`taskId\` expects the UUID string shown in the \`task_plan\`/\`task_list\` output (e.g. \`"a926c770-b40b-45b3-8121-08f92cbf1589"\`). Never pass the 1-based index (\`"1"\`, \`"2"\`) — the system has no concept of ordinal task ids.

**Discovering agents/teams:** Call \`task_list_agents\` to see all available agents and teams. Each entry shows the name, agentConfigId, and whether it's a team.

**Assigning agents/teams to tasks:** When calling \`task_plan\`, include \`assignTo\` on tasks — accepts either an agentConfigId (UUID) or agent name (e.g. \`"data-team"\`). This is preferred over separate \`task_assign\` calls. For post-hoc changes, use \`task_assign\` with \`taskId\` and an agentConfigId or name. Use \`task_unassign\` to remove an assignment that hasn't started yet. Assignments appear as clickable pills — the user starts assigned agents from the UI. Assigned agents receive the full plan context so they understand how their task fits into the bigger picture. Write detailed task descriptions to give agents the context they need.

**Dependencies between tasks:** When a task has real ordering constraints (e.g. "deploy depends on test depends on build"), pass \`dependsOn\` on the dependent task — an array of either task titles from the same \`task_plan\` call, or existing taskIds. The dependent task's assignments will NOT auto-start until every prerequisite is \`completed\`; when the last prerequisite completes, any assigned assignments auto-run. Use this instead of sequencing work through \`task_complete\` when you want parallel-then-join behavior (e.g. "C depends on both A and B — C runs only after both finish"). For mid-plan adjustments use \`task_set_dependencies\` with the \`taskId\` and the new \`dependsOn\` list. Cycles are rejected with a clear error. If a prerequisite \`task_fail\`s, its dependents stay blocked — explicitly decide to retry the prereq or fail the dependents.

The panel is always visible to the user, so the task list is your way of communicating progress throughout long-running work.`;
}

/**
 * Build the system prompt section that informs the orchestrator LLM
 * about available agents and how to invoke them.
 */
export function buildOrchestratorPrompt(
  agents: Array<{ name: string; id: string; description: string }>,
): string {
  const agentList = agents
    .map((a) => `- **${a.name}** (agentConfigId: "${a.id}"): ${a.description}`)
    .join("\n");

  return `## Available Agents

You have specialized agents available via the \`invoke_agent\` tool. Use them when the user's request would benefit from their expertise.

${agentList}

When invoking an agent, provide a clear, self-contained task description including all necessary context. Agents do not share memory unless you explicitly pass information between them.

After agents respond, synthesize their outputs into a coherent answer for the user. If an agent fails or returns unexpected results, diagnose the issue and retry with a refined task or route to a different agent.

${ORCHESTRATION_PATTERNS}`;
}

/**
 * Build the system prompt for a team orchestrator that coordinates
 * a named group of agents with a custom coordination strategy.
 */
export function buildTeamOrchestratorPrompt(
  teamName: string,
  teamPrompt: string,
  members: Array<{ name: string; id: string; description: string; overrides?: TeamMemberOverrides }>,
  autoSpinUpResults?: Array<{ name: string; output: string }>,
  teamToolScope?: TeamToolScope,
): string {
  const scopeActive = !!(teamToolScope && ((teamToolScope.allowedTools?.length ?? 0) > 0 || (teamToolScope.deniedTools?.length ?? 0) > 0));
  const memberList = members
    .map((m) => {
      const tags: string[] = [];
      // Team-level scope wins over per-member tool-related overrides, so only annotate
      // the member tag when no team scope is active (keeps the prompt honest).
      if (!scopeActive && m.overrides?.toolRestriction && m.overrides.toolRestriction !== "all") {
        tags.push(`${m.overrides.toolRestriction} tools`);
      }
      if (m.overrides?.model) tags.push(m.overrides.model);
      if (m.overrides?.permissionMode) tags.push(`${m.overrides.permissionMode} mode`);
      const suffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      return `- **${m.name}** (agentConfigId: "${m.id}"): ${m.description}${suffix}`;
    })
    .join("\n");

  const scopeHeader = scopeActive
    ? `### Team Tool Scope

These tool restrictions apply to every member below and override any per-member tool configuration:
${teamToolScope!.allowedTools?.length ? `- Allowed: ${teamToolScope!.allowedTools.join(", ")}` : ""}${teamToolScope!.allowedTools?.length && teamToolScope!.deniedTools?.length ? "\n" : ""}${teamToolScope!.deniedTools?.length ? `- Denied: ${teamToolScope!.deniedTools.join(", ")}` : ""}

`
    : "";

  return `## Team: ${teamName}

You are the coordinator for this team. Your role is to delegate work to team members, manage dependencies between their tasks, and synthesize their outputs into a unified result.

### Coordination Instructions

${teamPrompt}

${scopeHeader}### Team Members

${memberList}

When invoking a member agent, provide a clear, self-contained task description including all necessary context. Members do not share memory unless you explicitly pass information between them via the scratchpad or by including prior outputs in subsequent task descriptions.

Follow the team's coordination instructions above. They define the workflow, priorities, and decision-making rules for this team.

${autoSpinUpResults?.length ? `### Pre-computed Member Results

All team members have already been invoked with the user's message. Their responses are below. Synthesize these results into a coherent, unified response for the user. Do NOT call \`invoke_agent\` again for these members unless you need follow-up or clarification.

${autoSpinUpResults.map(r => `#### ${r.name}\n${r.output}`).join("\n\n")}

` : ""}${ORCHESTRATION_PATTERNS}`;
}
