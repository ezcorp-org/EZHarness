import { z } from "zod";

// Shared boundary schema for the workflow create (POST /api/workflows) and
// update (PUT /api/workflows/[name]) routes. Both parse the same body shape,
// so the schema lives here once (DRY). It only pins the outer shape — step
// interiors stay loose because the four kinds (agent/transform/gate/tool)
// carry different fields — while the shared `validateWorkflow` enforces the
// semantic rules and drives the 400 message.
export const workflowStepSchema = z
  .object({
    name: z.string().optional(),
    kind: z.enum(["agent", "transform", "gate", "tool"]).optional(),
    agent: z.string().optional(),
    input: z.record(z.string(), z.string()).optional(),
    retries: z.number().optional(),
    output: z.record(z.string(), z.string()).optional(),
    condition: z.unknown().optional(),
    // Runtime-namespaced extension tool (`<extension>__<tool>`) for a
    // `kind: "tool"` step. `validateWorkflow` enforces that it is present
    // on a tool step and that `agent` is absent.
    tool: z.string().optional(),
    dependsOn: z.array(z.string()).optional(),
    loop: z.unknown().optional(),
    // Per-step model binding. Left `unknown` on purpose, exactly like
    // `condition` / `loop`: `validateModelOverride` (reached through the
    // shared `validateWorkflow`) owns the field vocabulary and bounds, and
    // duplicating them here would be a second definition to keep in sync.
    model: z.unknown().optional(),
  })
  .loose();

export const workflowBodySchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    // Definition-level fallback binding — same rationale as the step's
    // `model` above: shape is validated by `validateWorkflow`.
    defaultModel: z.unknown().optional(),
    steps: z.array(workflowStepSchema).optional(),
  })
  .strict();
