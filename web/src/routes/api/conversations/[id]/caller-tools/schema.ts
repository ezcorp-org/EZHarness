/**
 * Boundary schema for the caller-executed-tools declaration API.
 *
 * This is the SHAPE gate only. It answers "is this JSON the right kind of
 * object" and nothing else — the semantic rules (reserved names, built-in
 * collisions, JSON-Schema structure, depth/property/byte budgets) live in
 * `src/runtime/caller-tool-declarations.ts` and run AFTER this, so the
 * runtime and the HTTP boundary can never disagree about what a valid
 * declaration is. Keep it that way: a rule added here and not there would
 * be enforceable over HTTP and unenforceable for anything that reads the
 * declarations straight out of `conversations.metadata`.
 *
 * ── THE NAME REGEX ──────────────────────────────────────────────────────
 *
 * `/^[a-z](?!.*__)[a-z0-9_]{2,47}$/` — lowercase start, 3–48 characters,
 * `[a-z0-9_]` thereafter, and NO consecutive underscores anywhere. The
 * `__` ban is load-bearing rather than stylistic: the runtime namespaces a
 * declaration as `_caller__<name>`, and every consumer of a namespaced tool
 * name splits on the FIRST `__` (`scoped-tools.ts`, `stripToolNamespace` in
 * `runtime/tools/filter.ts`). A name containing its own `__` would strip to
 * something other than what was declared, which is how a revocation toggle
 * silently stops matching the tool it is supposed to revoke.
 */
import { z } from "zod";

/** See the module header — the `__` ban is a namespace-stripping invariant. */
export const CALLER_TOOL_NAME_RE = /^[a-z](?!.*__)[a-z0-9_]{2,47}$/;

/** Per-conversation declaration ceiling. */
export const MAX_CALLER_TOOLS = 16;

/** Applied by the runtime when a declaration omits `timeoutMs`. */
export const DEFAULT_CALLER_TOOL_TIMEOUT_MS = 120_000;

/**
 * One declared tool.
 *
 * `parameters` is deliberately `z.record(z.string(), z.unknown())` and not a
 * JSON-Schema model: TypeBox validates nothing behind `BuiltinToolDef.
 * parameters` (`Type.Unsafe`), so a malformed schema would otherwise reach
 * the provider and 400 every subsequent turn of the conversation. The
 * structural validator in `caller-tool-declarations.ts` is what actually
 * rejects it; this line only guarantees the value is a plain JSON object so
 * that validator has something to walk.
 */
export const callerToolSchema = z
  .object({
    name: z.string().regex(CALLER_TOOL_NAME_RE),
    description: z.string().min(1).max(1024),
    parameters: z.record(z.string(), z.unknown()),
    timeoutMs: z.number().int().min(5_000).max(600_000).optional(),
  })
  .strict();

export const declareCallerToolsSchema = z
  .object({
    tools: z.array(callerToolSchema).max(MAX_CALLER_TOOLS),
  })
  .strict();

export type CallerToolInput = z.infer<typeof callerToolSchema>;
export type DeclareCallerToolsBody = z.infer<typeof declareCallerToolsSchema>;
