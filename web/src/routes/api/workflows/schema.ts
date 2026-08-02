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
    // Skip guard and its opt-out. Both `unknown` for the same reason as
    // `condition` / `loop` / `model`: the shared `validateWorkflow` owns the
    // vocabulary, and a duplicate rule here would be a second definition to
    // keep in sync. `skipDependents` is deliberately NOT `z.boolean()` —
    // that would reject a bad value at the boundary with the generic
    // "name and steps required" instead of the validator's
    // `Step "s" "skipDependents" must be a boolean`, which is the message
    // that actually tells the author what to fix.
    when: z.unknown().optional(),
    skipDependents: z.unknown().optional(),
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
    // The confidentiality tier, chosen by the author. Before this key
    // existed the schema's `.strict()` rejected any body carrying one, so
    // no caller could reach `private` at all and every workflow that could
    // exist was readable and runnable by every authenticated principal.
    //
    // Listing the three literals here rather than leaving the field loose
    // is the point: `.strict()` makes this an explicit opt-in, and the
    // enum makes a typo a 400 instead of a row with a visibility the
    // ladder has no branch for. WHO may assign which value is a separate,
    // authorization question — `denyVisibilityAssignment` in the ladder
    // module owns it, never this schema.
    visibility: z.enum(["system", "project", "private"]).optional(),
  })
  .strict();
