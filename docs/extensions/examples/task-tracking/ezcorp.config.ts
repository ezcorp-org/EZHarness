import { defineExtension } from "../../../../src/extensions/sdk/define";

const TASK_PLAN_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      description:
        "List of tasks to create, in execution order. The first task will be automatically started (unless it has prerequisites listed in `dependsOn`).",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short, actionable task title" },
          description: {
            type: "string",
            description: "Detailed description of what this task entails",
          },
          subtasks: {
            type: "array",
            items: { type: "string" },
            description: "Optional checklist items within this task",
          },
          assignTo: {
            type: "string",
            description:
              "Optional agentConfigId (or agent/team name) to assign. When set, the assignment auto-starts by default — the agent/team begins working immediately. Use autoStart: false to defer to manual start.",
          },
          autoStart: {
            type: "boolean",
            description:
              "Only meaningful when assignTo is set. Defaults to true: the assignment starts immediately and the agent/team begins running. Set false to create the assignment in 'assigned' status so it only runs when manually started from the UI.",
          },
          dependsOn: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional list of prerequisite tasks. Each entry can be EITHER the title of another task in this same plan OR the taskId of an existing task. The assignments on this task will not auto-start (and cannot be manually started) until every prerequisite is `completed`. When the last prerequisite completes, any assigned assignments auto-start. Useful for ordering constraints like 'deploy depends on test depends on build'.",
          },
        },
        required: ["title"],
      },
    },
  },
  required: ["tasks"],
} as const;

const TASK_ID_SCHEMA = {
  type: "object",
  properties: {
    taskId: { type: "string", description: "The id of the task" },
  },
  required: ["taskId"],
} as const;

const TASK_COMPLETE_SCHEMA = {
  type: "object",
  properties: {
    taskId: {
      type: "string",
      description: "The id of the task to complete (from task_plan or task_list)",
    },
    summary: { type: "string", description: "Brief summary of what was accomplished" },
  },
  required: ["taskId"],
} as const;

const TASK_FAIL_SCHEMA = {
  type: "object",
  properties: {
    taskId: { type: "string", description: "The id of the task that failed" },
    reason: { type: "string", description: "Explanation of why the task failed" },
  },
  required: ["taskId", "reason"],
} as const;

const TASK_UPDATE_SCHEMA = {
  type: "object",
  properties: {
    taskId: { type: "string", description: "The id of the task to update" },
    title: { type: "string" },
    description: { type: "string" },
    status: { type: "string", enum: ["pending", "active", "completed", "failed"] },
    dependsOn: {
      type: "array",
      items: { type: "string" },
      description:
        "Replace this task's prerequisite list. Each entry must be an existing taskId. Pass an empty array to clear all dependencies. For a focused, single-purpose edit prefer task_set_dependencies.",
    },
  },
  required: ["taskId"],
} as const;

const TASK_LIST_SCHEMA = { type: "object", properties: {} } as const;

const TASK_SUBTASK_TOGGLE_SCHEMA = {
  type: "object",
  properties: {
    taskId: { type: "string" },
    subtaskId: { type: "string" },
    completed: { type: "boolean" },
  },
  required: ["taskId", "subtaskId", "completed"],
} as const;

const TASK_ASSIGN_SCHEMA = {
  type: "object",
  properties: {
    taskId: { type: "string", description: "The id of the task to assign to" },
    agentConfigId: {
      type: "string",
      description: "The agent config ID or agent name to assign",
    },
    subtaskId: {
      type: "string",
      description: "Optional: assign to a specific subtask instead of the parent task",
    },
    autoStart: {
      type: "boolean",
      description:
        "Defaults to true: the assignment starts immediately and the agent/team begins running. Set false to create the assignment in 'assigned' status so it only runs when manually started from the UI.",
    },
  },
  required: ["taskId", "agentConfigId"],
} as const;

const TASK_UNASSIGN_SCHEMA = {
  type: "object",
  properties: {
    taskId: { type: "string", description: "The id of the task" },
    assignmentId: { type: "string", description: "The assignment ID to remove" },
  },
  required: ["taskId", "assignmentId"],
} as const;

const TASK_ADD_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short, actionable task title" },
    description: {
      type: "string",
      description: "Detailed description of what this task entails",
    },
    subtasks: {
      type: "array",
      items: { type: "string" },
      description: "Optional checklist items within this task",
    },
    assignTo: {
      type: "string",
      description:
        "Optional agentConfigId (or agent/team name) to assign. When set, the assignment auto-starts by default — the agent/team begins working immediately. Use autoStart: false to defer to manual start.",
    },
    autoStart: {
      type: "boolean",
      description:
        "Only meaningful when assignTo is set. Defaults to true: the assignment starts immediately. Set false to create the assignment in 'assigned' status so it only runs when manually started from the UI.",
    },
    afterTaskId: {
      type: "string",
      description: "Optional: insert after this task ID. If omitted, appends to end.",
    },
    dependsOn: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional list of prerequisite taskIds. The assignment (if any) will not auto-start until every prerequisite is `completed`. When the last prerequisite completes, any assigned assignments auto-start.",
    },
  },
  required: ["title"],
} as const;

const TASK_SET_DEPS_SCHEMA = {
  type: "object",
  properties: {
    taskId: { type: "string", description: "The id of the task to edit" },
    dependsOn: {
      type: "array",
      items: { type: "string" },
      description:
        "The new complete prerequisite list for this task (taskIds). Replaces any existing dependencies. Pass an empty array to clear all dependencies.",
    },
  },
  required: ["taskId", "dependsOn"],
} as const;

const TASK_LIST_AGENTS_SCHEMA = { type: "object", properties: {} } as const;

export default defineExtension({
  schemaVersion: 2,
  name: "task-tracking",
  version: "1.0.0",
  description:
    "Multi-task planning and sub-agent coordination for a conversation",
  author: { name: "EzCorp" },
  entrypoint: "./index.ts",
  persistent: true,
  tools: [
    {
      name: "task_plan",
      description:
        "Create a task plan by decomposing complex work into discrete tasks and AUTOMATICALLY START the first task. Replaces all existing pending tasks. Use at the start of multi-step work (3+ steps). After this call, the first task is already active — you can begin working immediately. Use task_complete when each task is done (it auto-advances to the next). Optional subtasks are checklist items within a task. When a task has `assignTo` set, the assigned agent/team is auto-started by default so they begin working right away — pass `autoStart: false` on a task if you want the assignment to wait for manual start.",
      inputSchema: TASK_PLAN_SCHEMA as Record<string, unknown>,
    },
    {
      name: "task_add",
      description:
        "Add a single task to the existing plan without replacing other tasks. Use this to append or insert work into an ongoing plan. Optionally insert after a specific task. When `assignTo` is set, the assigned agent/team auto-starts by default — pass `autoStart: false` if you want the assignment to wait for manual start.",
      inputSchema: TASK_ADD_SCHEMA as Record<string, unknown>,
    },
    {
      name: "task_start",
      description: "Mark a task as active and begin working on it.",
      inputSchema: TASK_ID_SCHEMA as Record<string, unknown>,
    },
    {
      name: "task_complete",
      description:
        "Mark a task as completed with an optional summary. Automatically starts the next pending task.",
      inputSchema: TASK_COMPLETE_SCHEMA as Record<string, unknown>,
    },
    {
      name: "task_fail",
      description: "Mark a task as failed with a reason.",
      inputSchema: TASK_FAIL_SCHEMA as Record<string, unknown>,
    },
    {
      name: "task_update",
      description:
        "Update a task's title, description, status, or prerequisite dependencies.",
      inputSchema: TASK_UPDATE_SCHEMA as Record<string, unknown>,
    },
    {
      name: "task_set_dependencies",
      description:
        "Set or replace the list of prerequisite tasks a task depends on. Dependent tasks auto-start when all prerequisites complete.",
      inputSchema: TASK_SET_DEPS_SCHEMA as Record<string, unknown>,
    },
    {
      name: "task_list",
      description:
        "List all tasks for the current conversation with their status and assignments.",
      inputSchema: TASK_LIST_SCHEMA as Record<string, unknown>,
    },
    {
      name: "task_subtask_toggle",
      description:
        "Mark a subtask as completed or uncompleted within a parent task.",
      inputSchema: TASK_SUBTASK_TOGGLE_SCHEMA as Record<string, unknown>,
    },
    {
      name: "task_assign",
      description:
        "Assign an agent or team to a task. Multiple assignments per task allowed.",
      inputSchema: TASK_ASSIGN_SCHEMA as Record<string, unknown>,
    },
    {
      name: "task_unassign",
      description: "Remove an assignment from a task.",
      inputSchema: TASK_UNASSIGN_SCHEMA as Record<string, unknown>,
    },
    {
      name: "task_list_agents",
      description:
        "List all agents and teams available for task assignment.",
      inputSchema: TASK_LIST_AGENTS_SCHEMA as Record<string, unknown>,
    },
  ],
  permissions: {
    storage: true,
    taskEvents: true,
    agentConfig: "read",
    spawnAgents: { maxPerHour: 200, maxConcurrent: 10 },
    eventSubscriptions: ["task:assignment_update"],
  },
});
