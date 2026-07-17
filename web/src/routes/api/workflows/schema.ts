import { z } from "zod";

// Shared boundary schema for the workflow create (POST /api/workflows) and
// update (PUT /api/workflows/[name]) routes. Both parse the same body shape,
// so the schema lives here once (DRY). It only pins the outer shape — step
// interiors stay loose because the three kinds (agent/transform/gate) carry
// different fields — while the shared `validateWorkflow` enforces the
// semantic rules and drives the 400 message.
export const workflowStepSchema = z
  .object({
    name: z.string().optional(),
    kind: z.enum(["agent", "transform", "gate"]).optional(),
    agent: z.string().optional(),
    input: z.record(z.string(), z.string()).optional(),
    retries: z.number().optional(),
    output: z.record(z.string(), z.string()).optional(),
    condition: z.unknown().optional(),
    dependsOn: z.array(z.string()).optional(),
    loop: z.unknown().optional(),
  })
  .loose();

export const workflowBodySchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(workflowStepSchema).optional(),
  })
  .strict();
