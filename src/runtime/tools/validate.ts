import { resolve, relative } from "node:path";

/**
 * The `params` blob a built-in tool's `execute` actually receives.
 *
 * FOLLOW-UP — the highest-value `any` left in the tree, named in one place so
 * that fixing it is one edit rather than sixteen.
 *
 * `BuiltinToolDef.execute` declares `params: unknown`, which is the honest
 * type: pi-agent-core hands over decoded JSON and never validates it against
 * the tool's own `parameters` JSON Schema at runtime. But 16 handlers index
 * straight into it (`params.path`, `params.command`, …), so each widened the
 * parameter back to `any` at its own signature — legal, since a handler may
 * accept a broader type than the interface promises, and invisible, since
 * nobody had to say why.
 *
 * The real fix is to derive a TypeScript type from each tool's `parameters`
 * schema, which is the actual contract. Until something does, `unknown` here
 * would only relocate the same casts into every handler body. That work is its
 * own change: 16 tools, each needing its schema threaded through and its
 * narrowing covered.
 *
 * It lives HERE, next to the validators, rather than in `./types` beside
 * `BuiltinToolDef`, for a gate reason worth knowing: `types.ts` is
 * declaration-only, so it compiles to nothing, never appears in lcov, and the
 * patch-coverage gate rejects any edit to a source file with no coverage data.
 * `validate.ts` is the measured module this type is about.
 */
// biome-ignore lint/suspicious/noExplicitAny: LLM-supplied JSON that nothing validates against the tool's `parameters` schema at runtime; the doc comment above records why `unknown` is not a drop-in replacement and what the real fix is.
export type ToolParams = any;

export function validatePath(projectPath: string, relativePath: string): string {
  const resolved = resolve(projectPath, relativePath);
  const rel = relative(projectPath, resolved);
  if (rel.startsWith("..") || resolve(resolved) !== resolved && rel.startsWith("..")) {
    throw new Error("Path traversal detected: path must stay within the project directory");
  }
  if (!resolved.startsWith(projectPath)) {
    throw new Error("Path traversal detected: path must stay within the project directory");
  }
  return resolved;
}

export function validateTimeout(timeout?: number, max: number = 600000): number {
  const defaultTimeout = 120000;
  if (timeout === undefined || timeout === null) return defaultTimeout;
  return Math.max(1000, Math.min(timeout, max));
}
