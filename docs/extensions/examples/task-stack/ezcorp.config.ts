import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "task-stack",
  version: "1.0.0",
  description: "Stack-based task management with subtasks, dependencies, time tracking, artifacts, and agent flags",
  author: { name: "EzCorp" },
  entrypoint: "./index.ts",
  tools: [
    // Stack Management
    {
      name: "list-stacks",
      description: "List all task stacks",
      inputSchema: { type: "object", properties: {} },
      cardType: "task-list",
    },
    {
      name: "get-top-task",
      description: "Get the highest-priority pending task in a stack (skips dependency-blocked tasks)",
      inputSchema: {
        type: "object",
        properties: {
          stackId: {
            type: "string",
            format: "combo-box",
            description: "Stack to check",
            "x-options": { options: ["inbox"], allowCustom: true },
          },
        },
      },
      cardType: "task-detail",
    },
    // Task CRUD
    {
      name: "add-task",
      description: "Create a new task",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title" },
          description: { type: "string", description: "Task description" },
          stackId: {
            type: "string",
            format: "combo-box",
            description: "Stack to add to",
            "x-options": { options: ["inbox"], allowCustom: true },
          },
          dueDate: { type: "string", format: "date", description: "Due date" },
          position: {
            type: "string",
            format: "combo-box",
            description: "Where to insert",
            "x-options": { options: ["top", "bottom"], allowCustom: false },
          },
        },
        required: ["title"],
      },
      cardType: "task-detail",
    },
    {
      name: "list-tasks",
      description: "List tasks, optionally filtered by stack",
      inputSchema: {
        type: "object",
        properties: {
          stackId: {
            type: "string",
            format: "combo-box",
            description: "Filter by stack",
            "x-options": { options: ["inbox"], allowCustom: true },
          },
          limit: { type: "number", description: "Max tasks to return" },
        },
      },
      cardType: "task-list",
    },
    {
      name: "update-task",
      description: "Update task title, description, or due date",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID" },
          title: { type: "string", description: "New title" },
          description: { type: "string", description: "New description" },
          dueDate: { type: "string", format: "date", description: "New due date" },
        },
        required: ["taskId"],
      },
    },
    {
      name: "get-task-dependencies",
      description: "Get blocking and blocked tasks for a given task",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID" },
        },
        required: ["taskId"],
      },
    },
    // Task Organization
    {
      name: "move-task",
      description: "Move a task to a new position within its stack",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID" },
          newPosition: { type: "number", description: "New position index" },
        },
        required: ["taskId", "newPosition"],
      },
    },
    {
      name: "move-task-to-stack",
      description: "Move a task to a different stack",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID" },
          targetStackId: {
            type: "string",
            format: "combo-box",
            description: "Target stack",
            "x-options": { options: ["inbox"], allowCustom: true },
          },
          position: { type: "number", description: "Position in target stack" },
        },
        required: ["taskId", "targetStackId"],
      },
    },
    {
      name: "reorder-tasks",
      description: "Set explicit task order by providing task IDs in desired order",
      inputSchema: {
        type: "object",
        properties: {
          taskIds: {
            type: "array",
            items: { type: "string" },
            description: "Task IDs in desired order",
          },
        },
        required: ["taskIds"],
      },
    },
    // Task Lifecycle
    {
      name: "start-task",
      description: "Start working on a task (sets it as active)",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID" },
        },
        required: ["taskId"],
      },
    },
    {
      name: "get-active-task",
      description: "Get the currently active task",
      inputSchema: { type: "object", properties: {} },
      cardType: "task-detail",
    },
    {
      name: "finish-task",
      description: "Complete the active task with a summary",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID" },
          summary: { type: "string", description: "Completion summary" },
          artifacts: {
            type: "array",
            description: "Artifacts to attach",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                title: { type: "string" },
                url: { type: "string" },
                metadata: { type: "object" },
              },
              required: ["type", "title", "url"],
            },
          },
        },
        required: ["taskId", "summary"],
      },
      cardType: "task-detail",
    },
    {
      name: "fail-task",
      description: "Mark a task as failed with a reason",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID" },
          reason: { type: "string", description: "Explanation of why the task failed" },
        },
        required: ["taskId", "reason"],
      },
      cardType: "task-detail",
    },
    {
      name: "get-store-snapshot",
      description: "Get the full task store snapshot, optionally filtered by stack",
      inputSchema: {
        type: "object",
        properties: {
          stackId: {
            type: "string",
            description: "Optional stack name or ID to filter by",
          },
        },
      },
    },
    // Dependencies
    {
      name: "add-dependency",
      description: "Add a blocking dependency between tasks",
      inputSchema: {
        type: "object",
        properties: {
          blockingTaskId: { type: "string", description: "Task that blocks" },
          dependentTaskId: { type: "string", description: "Task that is blocked" },
        },
        required: ["blockingTaskId", "dependentTaskId"],
      },
    },
    {
      name: "remove-dependency",
      description: "Remove a blocking dependency between tasks",
      inputSchema: {
        type: "object",
        properties: {
          blockingTaskId: { type: "string", description: "Task that blocks" },
          dependentTaskId: { type: "string", description: "Task that is blocked" },
        },
        required: ["blockingTaskId", "dependentTaskId"],
      },
    },
    // Subtasks
    {
      name: "add-subtask",
      description: "Add a subtask to a task",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Parent task ID" },
          title: { type: "string", description: "Subtask title" },
        },
        required: ["taskId", "title"],
      },
    },
    {
      name: "update-subtask",
      description: "Update a subtask's title or completion status",
      inputSchema: {
        type: "object",
        properties: {
          subtaskId: { type: "string", description: "Subtask ID" },
          title: { type: "string", description: "New title" },
          completed: { type: "boolean", description: "Completion status" },
        },
        required: ["subtaskId"],
      },
    },
    {
      name: "complete-subtask",
      description: "Mark a subtask as completed",
      inputSchema: {
        type: "object",
        properties: {
          subtaskId: { type: "string", description: "Subtask ID" },
        },
        required: ["subtaskId"],
      },
    },
    {
      name: "uncomplete-subtask",
      description: "Mark a subtask as not completed",
      inputSchema: {
        type: "object",
        properties: {
          subtaskId: { type: "string", description: "Subtask ID" },
        },
        required: ["subtaskId"],
      },
    },
    {
      name: "delete-subtask",
      description: "Delete a subtask",
      inputSchema: {
        type: "object",
        properties: {
          subtaskId: { type: "string", description: "Subtask ID" },
        },
        required: ["subtaskId"],
      },
    },
    {
      name: "reorder-subtasks",
      description: "Set explicit subtask order by providing subtask IDs in desired order",
      inputSchema: {
        type: "object",
        properties: {
          subtaskIds: {
            type: "array",
            items: { type: "string" },
            description: "Subtask IDs in desired order",
          },
        },
        required: ["subtaskIds"],
      },
    },
    // Artifacts & Flags
    {
      name: "add-artifact",
      description: "Attach an artifact to a task",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID" },
          type: {
            type: "string",
            format: "combo-box",
            description: "Artifact type",
            "x-options": { options: ["pr", "commit", "url", "file", "note"], allowCustom: true },
          },
          title: { type: "string", description: "Artifact title" },
          url: { type: "string", description: "Artifact URL or path" },
          metadata: { type: "object", description: "Additional metadata" },
        },
        required: ["taskId", "type", "title", "url"],
      },
    },
    {
      name: "mark-ready-for-agent",
      description: "Mark a task as ready for agent processing",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID" },
        },
        required: ["taskId"],
      },
    },
    {
      name: "unmark-ready-for-agent",
      description: "Unmark a task as ready for agent processing",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID" },
        },
        required: ["taskId"],
      },
    },
  ],
  permissions: {
    filesystem: ["$CWD"],
    shell: false,
  },
});
