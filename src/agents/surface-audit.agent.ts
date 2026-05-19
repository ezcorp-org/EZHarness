import type { AgentDefinition } from "../types";
import { runAudit } from "../runtime/audit/run";
import { getProject } from "../db/queries/projects";

export default {
  name: "surface-audit",
  description: "Classify each feature against SDK / EzButton / MCP surfaces and write a gap report",
  capabilities: ["llm", "file"],
  inputSchema: {
    projectId: {
      type: "string",
      label: "Project ID",
      description: "UUID of the project to audit",
      required: true,
    },
  },

  async execute(ctx) {
    const { projectId } = ctx.input as { projectId?: string };
    if (!projectId) {
      return { success: false, output: null, error: "Provide 'projectId' in input" };
    }

    const project = await getProject(projectId);
    if (!project) {
      return { success: false, output: null, error: `Project ${projectId} not found` };
    }
    if (!project.path) {
      return { success: false, output: null, error: `Project ${projectId} has no path` };
    }

    ctx.log(`Auditing surface coverage for ${project.name}`);
    const result = await runAudit(projectId, project.path, ctx);
    return { success: true, output: result };
  },
} satisfies AgentDefinition;
