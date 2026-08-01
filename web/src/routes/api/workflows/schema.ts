import { z } from "zod";

// Shared boundary schema for the workflow create (POST /api/workflows) and
// update (PUT /api/workflows/[name]) routes. Both parse the same body shape,
// so the schema lives here once (DRY). It only pins the outer shape — step
// interiors stay loose because the six kinds carry different fields — while
// the shared `validateWorkflow` enforces the semantic rules and drives the
// 400 message.
//
// The `kind` enum is the ONE place this schema is not loose, so it has to
// list every kind the executor dispatches or the route rejects a definition
// the runtime supports. It was already short by `approval` (C4's kind) when
// C7 added `workflow`, which made both uncreatable through the API — the
// exact failure mode a hard-coded list has.
export const workflowStepSchema = z
  .object({
    name: z.string().optional(),
    kind: z
      .enum(["agent", "transform", "gate", "tool", "approval", "workflow"])
      .optional(),
    agent: z.string().optional(),
    input: z.record(z.string(), z.string()).optional(),
    retries: z.number().optional(),
    output: z.record(z.string(), z.string()).optional(),
    condition: z.unknown().optional(),
    // Runtime-namespaced extension tool (`<extension>__<tool>`) for a
    // `kind: "tool"` step. `validateWorkflow` enforces that it is present
    // on a tool step and that `agent` is absent.
    tool: z.string().optional(),
    // Nested definition name for a `kind: "workflow"` step.
    workflow: z.string().optional(),
    // Skip guard. `unknown` for the same reason as `condition` — it is the
    // same `WorkflowCondition` grammar and `validateCondition` owns it.
    when: z.unknown().optional(),
    skipDependents: z.boolean().optional(),
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
