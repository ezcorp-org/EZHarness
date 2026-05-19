import { z } from "zod";

const teamMemberOverridesSchema = z.object({
  permissionMode: z.enum(["ask", "auto-edit", "yolo"]).optional(),
  toolRestriction: z.enum(["all", "read-only", "none"]).optional(),
  modeId: z.string().optional(),
  allowedTools: z.array(z.string().max(200)).max(500).optional(),
  deniedTools: z.array(z.string().max(200)).max(500).optional(),
  provider: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  systemPromptAppend: z.string().max(10000).optional(),
}).optional();

/**
 * Team-level tool scope: allow / deny lists that apply to every invoked member
 * and override their per-member tool configuration. Both lists optional.
 */
const teamToolScopeSchema = z.object({
  allowedTools: z.array(z.string().max(200)).max(500).optional(),
  deniedTools: z.array(z.string().max(200)).max(500).optional(),
}).optional();

type TeamMemberInput = {
  agentConfigId: string;
  overrides?: z.infer<typeof teamMemberOverridesSchema>;
  subAgents?: TeamMemberInput[];
};

const teamMemberSchema: z.ZodType<TeamMemberInput> = z.lazy(() =>
  z.object({
    agentConfigId: z.string(),
    overrides: teamMemberOverridesSchema,
    subAgents: z.array(teamMemberSchema).max(20).optional(),
  }),
);

/** Validate that a members tree doesn't exceed max nesting depth */
function checkMemberDepth(members: TeamMemberInput[], maxDepth = 3, current = 1): boolean {
  if (current > maxDepth) return false;
  for (const m of members) {
    if (m.subAgents?.length && !checkMemberDepth(m.subAgents, maxDepth, current + 1)) return false;
  }
  return true;
}

export const createAgentConfigSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  prompt: z.string().min(1, "Prompt is required").max(50000),
  description: z.string().max(500).optional(),
  capabilities: z.array(z.string()).optional(),
  category: z.string().max(100).optional(),
  provider: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(1000000).optional(),
  outputFormat: z.enum(["text", "json"]).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  // Top-level extensions: IDs of extensions whose tools should be attached to
  // this agent at runtime (see src/runtime/mention-wiring.ts — wired when the
  // agent is @mentioned). Distinct from references.extensions (unused by
  // runtime). Was silently dropped by the query layer before the fix.
  extensions: z.array(z.string().max(200)).max(100).optional(),
  references: z.object({
    agents: z.array(z.string()).optional(),
    extensions: z.array(z.string()).optional(),
    members: z.array(teamMemberSchema).max(20).optional(),
    autoSpinUp: z.boolean().optional(),
    teamToolScope: teamToolScopeSchema,
  }).optional(),
}).refine(
  (data) => {
    const members = data.references?.members;
    if (!members?.length) return true;
    return checkMemberDepth(members);
  },
  { message: "Team member nesting cannot exceed 3 levels", path: ["references", "members"] },
);

export type CreateAgentConfigInput = z.infer<typeof createAgentConfigSchema>;
