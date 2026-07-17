import type { AgentResult } from "../types";

/**
 * Shared reference-resolution language for workflows. Used by three
 * callers so the ref grammar is defined exactly once (DRY):
 *   - step-input resolution (agent input + transform `output`) — STRICT,
 *   - transform template interpolation (`{{…}}`),
 *   - condition evaluation (gate steps + loop `until`).
 *
 * Ref roots:
 *   `$input.<field>`   — the workflow's top-level input (lenient: may be
 *                        undefined without throwing).
 *   `$prev[.path]`     — the previous batch's last result (strict).
 *   `$steps.<name>[.path]` — a named earlier step's result (strict on the
 *                        step existing; lenient on a deeper missing field
 *                        for CONDITIONS, strict for step INPUTS).
 *   `$loop.iteration`  — 1-based iteration number (step inputs, in a loop).
 *   `$loop.last[.path]`— previous iteration's result (step inputs, in a
 *                        loop). On iteration 1 the key is OMITTED.
 *   `$result[.path]`   — current iteration's result (loop `until` only).
 *   `$iteration`       — 1-based iteration number (loop `until` only).
 * Anything else is a literal string.
 */
export interface RefContext {
  input: Record<string, unknown>;
  prevResult?: AgentResult;
  stepResults: Map<string, AgentResult>;
  /** Present only while resolving a looped step's input. */
  loop?: { iteration: number; last?: AgentResult };
  /** Present only while evaluating a loop `until` condition. */
  result?: AgentResult;
  iteration?: number;
}

/** Sentinel: the ref resolved to "omit this key entirely" (the single
 *  lenient exception — `$loop.last` on iteration 1). */
export const OMIT = Symbol("omit");

/** Walk a `.`-separated path, returning `undefined` on any missing hop.
 *  Only OWN properties are traversed — a crafted ref path naming
 *  `__proto__` / `constructor` / any inherited segment resolves to
 *  `undefined` rather than walking the prototype chain. */
export function getNestedValue(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    if (!Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Resolve a single step-input / transform-output ref STRICTLY: a `$prev` /
 * `$steps.X` reference to a step that hasn't produced a result, or a field
 * missing on that result, throws a descriptive error rather than silently
 * passing `undefined` downstream. `$input.field` stays lenient. Returns the
 * {@link OMIT} sentinel for the one documented lenient exception
 * (`$loop.last` on iteration 1).
 */
export function resolveInputRef(
  key: string,
  ref: string,
  ctx: RefContext,
): unknown | typeof OMIT {
  if (ref.startsWith("$input.")) {
    return ctx.input[ref.slice("$input.".length)];
  }

  if (ref === "$loop.iteration") {
    if (!ctx.loop) {
      throw new Error(
        `Cannot resolve "${ref}" for step input "${key}": not inside a loop.`,
      );
    }
    return ctx.loop.iteration;
  }

  if (ref === "$loop.last" || ref.startsWith("$loop.last.")) {
    if (!ctx.loop) {
      throw new Error(
        `Cannot resolve "${ref}" for step input "${key}": not inside a loop.`,
      );
    }
    // Iteration 1 has no previous result — omit the key (documented lenient
    // exception), never pass `undefined`.
    if (ctx.loop.last === undefined) return OMIT;
    if (ref === "$loop.last") return ctx.loop.last;
    const path = ref.slice("$loop.last.".length);
    const value = getNestedValue(ctx.loop.last, path);
    if (value === undefined) {
      throw new Error(
        `Cannot resolve "${ref}" for step input "${key}": field "${path}" is missing on the previous iteration's result.`,
      );
    }
    return value;
  }

  if (ref === "$prev" || ref.startsWith("$prev.")) {
    if (ctx.prevResult === undefined) {
      throw new Error(
        `Cannot resolve "${ref}" for step input "${key}": no previous step has produced a result yet.`,
      );
    }
    // Bare `$prev` yields the whole previous result (consistent with bare
    // `$steps.<name>` and the condition-ref grammar — never a silent
    // "$prev" literal).
    if (ref === "$prev") return ctx.prevResult;
    const field = ref.slice("$prev.".length);
    const value = getNestedValue(ctx.prevResult, field);
    if (value === undefined) {
      throw new Error(
        `Cannot resolve "${ref}" for step input "${key}": field "${field}" is missing on the previous step's result.`,
      );
    }
    return value;
  }

  if (ref.startsWith("$steps.")) {
    const rest = ref.slice("$steps.".length);
    const dotIdx = rest.indexOf(".");
    const stepName = dotIdx === -1 ? rest : rest.slice(0, dotIdx);
    if (!ctx.stepResults.has(stepName)) {
      throw new Error(
        `Cannot resolve "${ref}" for step input "${key}": step "${stepName}" has not produced a result (unknown step or it has not run yet).`,
      );
    }
    if (dotIdx === -1) return ctx.stepResults.get(stepName);
    const field = rest.slice(dotIdx + 1);
    const value = getNestedValue(ctx.stepResults.get(stepName), field);
    if (value === undefined) {
      throw new Error(
        `Cannot resolve "${ref}" for step input "${key}": field "${field}" is missing on step "${stepName}"'s result.`,
      );
    }
    return value;
  }

  // Literal value.
  return ref;
}

/**
 * Resolve a whole step-input / transform-output mapping. Keys whose ref
 * yields {@link OMIT} are dropped from the result (the loop iteration-1
 * `$loop.last` exception). Every other ref resolves strictly.
 */
export function resolveMapping(
  mapping: Record<string, string>,
  ctx: RefContext,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, ref] of Object.entries(mapping)) {
    const value = resolveInputRef(key, ref, ctx);
    if (value !== OMIT) resolved[key] = value;
  }
  return resolved;
}

/**
 * Resolve a transform step's `output` mapping. Same strict ref language as
 * {@link resolveMapping} PLUS `{{…}}` template interpolation: a value
 * containing a placeholder is string-interpolated, any other value is a
 * direct ref. Keys whose direct ref yields {@link OMIT} are dropped.
 */
export function resolveOutputMapping(
  mapping: Record<string, string>,
  ctx: RefContext,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, ref] of Object.entries(mapping)) {
    if (hasTemplate(ref)) {
      resolved[key] = interpolateTemplate(key, ref, ctx);
      continue;
    }
    const value = resolveInputRef(key, ref, ctx);
    if (value !== OMIT) resolved[key] = value;
  }
  return resolved;
}

/**
 * Resolve a condition-context ref. Unlike {@link resolveInputRef} this
 * throws ONLY on an unresolvable ROOT strict ref (a `$prev` with no
 * previous result, or a `$steps.<unknownStep>`); a deeper missing field
 * resolves to `undefined` so `exists` / comparison operators can report
 * presence without throwing. Adds the `$result` / `$iteration` roots
 * available inside a loop `until`.
 */
export function resolveConditionRef(ref: string, ctx: RefContext): unknown {
  if (ref === "$iteration") {
    if (ctx.iteration === undefined) {
      throw new Error(
        `Cannot resolve "${ref}": "$iteration" is only available inside a loop until-condition.`,
      );
    }
    return ctx.iteration;
  }

  if (ref === "$result" || ref.startsWith("$result.")) {
    if (ctx.result === undefined) {
      throw new Error(
        `Cannot resolve "${ref}": "$result" is only available inside a loop until-condition.`,
      );
    }
    if (ref === "$result") return ctx.result;
    return getNestedValue(ctx.result, ref.slice("$result.".length));
  }

  if (ref.startsWith("$input.")) {
    return ctx.input[ref.slice("$input.".length)];
  }

  if (ref === "$prev" || ref.startsWith("$prev.")) {
    if (ctx.prevResult === undefined) {
      throw new Error(
        `Cannot resolve "${ref}": no previous step has produced a result yet.`,
      );
    }
    if (ref === "$prev") return ctx.prevResult;
    return getNestedValue(ctx.prevResult, ref.slice("$prev.".length));
  }

  if (ref.startsWith("$steps.")) {
    const rest = ref.slice("$steps.".length);
    const dotIdx = rest.indexOf(".");
    const stepName = dotIdx === -1 ? rest : rest.slice(0, dotIdx);
    if (!ctx.stepResults.has(stepName)) {
      throw new Error(
        `Cannot resolve "${ref}": step "${stepName}" has not produced a result (unknown step or it has not run yet).`,
      );
    }
    if (dotIdx === -1) return ctx.stepResults.get(stepName);
    return getNestedValue(ctx.stepResults.get(stepName), rest.slice(dotIdx + 1));
  }

  // A condition ref that is not a recognised root is a literal comparison
  // value expressed as a ref — return it verbatim.
  return ref;
}

/**
 * Interpolate a template string: every `{{ ref }}` placeholder is resolved
 * as a strict input ref and string-interpolated. A value containing no
 * `{{…}}` is returned unchanged (so a bare ref like `$steps.a.output` is
 * still resolved by {@link resolveInputRef}, not here). Strict-ref failures
 * throw exactly like a direct ref.
 */
export function interpolateTemplate(
  key: string,
  template: string,
  ctx: RefContext,
): string {
  // `[^{}]*` (no `\s*` overlap) keeps matching linear — the previous
  // `\{\{\s*([^}]+?)\s*\}\}` backtracked super-linearly on input with no
  // closing `}}` (ReDoS: a few KB pinned the event loop for seconds).
  // Whitespace tolerance inside `{{ ref }}` is preserved via `.trim()`.
  return template.replace(/\{\{([^{}]*)\}\}/g, (_match, rawRef: string) => {
    const value = resolveInputRef(key, rawRef.trim(), ctx);
    if (value === OMIT) return "";
    if (value === null || value === undefined) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

/** True if a mapping value contains at least one `{{…}}` placeholder.
 *  Same linear (backtrack-free) pattern as {@link interpolateTemplate}. */
export function hasTemplate(value: string): boolean {
  return /\{\{[^{}]*\}\}/.test(value);
}
