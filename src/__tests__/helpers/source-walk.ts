/**
 * The syntactic source walker the tool-policy surface assertions share.
 *
 * Two suites derive a security-relevant set from the tree rather than from a
 * hand-written list, and both need the same four primitives:
 *
 *   • `policy-spawn-deny-surface.test.ts` — every tool that reaches a spawn
 *     primitive must be in `POLICY_LEAF_SPAWN_DENY`;
 *   • `policy-run-start-surface.test.ts` — every route that starts a run must
 *     be in `RUN_START_ROUTES`, and every one that starts it through
 *     `streamChat` must wire Boundary 3.
 *
 * It lives here because the SECOND suite proved the first one's walker was
 * the reusable part: writing it twice would mean two comment strippers, and
 * the comment stripper is the piece that was hardest to get right (see
 * {@link stripComments}).
 *
 * ── The analysis ──────────────────────────────────────────────────────
 * Deliberately syntactic and deliberately OVER-approximating toward "this
 * declaration reaches the primitive": a false positive costs one list entry,
 * a false negative costs the boundary.
 *
 *   1. Segment each file into TOP-LEVEL declarations by line: a declaration
 *      owns every line from its own to the line before the next top-level
 *      declaration. No brace matching (nothing to get wrong on a `"{"` inside
 *      a string), and a nested helper is attributed to its enclosing
 *      declaration — which over-approximates, as intended.
 *   2. Seed: a declaration is REACHING if its lines mention a primitive.
 *   3. Propagate to a fixed point: a declaration that CALLS a reaching
 *      declaration is reaching. Module-level aliases need no special case —
 *      `let spawn: SpawnFn = spawnAssignment` is just a declaration that
 *      mentions a primitive, so `spawn(` propagates like any other call.
 *
 * Each consumer supplies its own primitive list and its own name binding
 * (tool names for one, HTTP verbs for the other); everything above the
 * binding is shared.
 */

export interface Decl {
  name: string;
  /** Every source line this declaration owns, joined. */
  body: string;
}

/** A top-level declaration opener, anchored at column 0. */
const TOP_LEVEL_DECL =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;

/**
 * `Bun.spawn` is a PROCESS spawn, not a run spawn. Erased before matching so
 * a file that shells out cannot be dragged in through a `spawn(` substring.
 */
export function eraseProcessSpawns(source: string): string {
  return source.replaceAll("Bun.spawn", "Bun.__process_spawn__");
}

/**
 * Blank every comment, preserving line count so a declaration's span is
 * unchanged.
 *
 * NOT cosmetic — comments were the first thing this analysis got wrong, and
 * in the direction that matters least but is loudest. `task_complete` and
 * `task_stop` both read as spawn-reaching on the strength of a doc comment
 * saying the words "fire `spawnAssignment` for newly-unblocked dependents",
 * which would have forced two deliberately-KEPT tools into the deny set on
 * the authority of prose. Segmentation makes it worse: a doc comment sits
 * ABOVE the declaration it documents, so it is attributed to the PREVIOUS
 * one — `stopHandler` inherited `resumeHandler`'s.
 *
 * The route walker meets the same shape and would fail the same way:
 * `tool-invoke/+server.ts` names `streamChat` only in a comment, and
 * `messages/[mid]/retry/+server.ts` names it four times in prose above the
 * declaration that actually calls it.
 *
 * Character-scanned rather than regex-replaced, so a `//` inside a string
 * (`"https://…"`) and a `/*` inside a template literal are left alone.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  // "code" | "line" | "block" | the quote char of the string being scanned
  let state: "code" | "line" | "block" | '"' | "'" | "`" = "code";
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") state = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
      } else {
        out += " ";
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        out += "  ";
        i += 2;
        continue;
      }
      // Newlines survive so line numbers and declaration spans hold.
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    // Inside a string literal: copy verbatim, honour escapes, close on the
    // matching quote.
    if (ch === "\\") {
      out += ch + (next ?? "");
      i += 2;
      continue;
    }
    if (ch === state) state = "code";
    out += ch;
    i += 1;
  }
  return out;
}

/** Split a source file into its top-level declarations by line span. */
export function segmentDeclarations(source: string): Map<string, Decl> {
  const lines = source.split("\n");
  const decls = new Map<string, Decl>();
  let current: { name: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    // A re-declared name (a `let x` reassigned in a later top-level
    // statement) merges rather than replaces — losing either half would lose
    // reachability.
    const previous = decls.get(current.name);
    const body = current.lines.join("\n");
    decls.set(current.name, {
      name: current.name,
      body: previous ? `${previous.body}\n${body}` : body,
    });
  };
  for (const line of lines) {
    const match = TOP_LEVEL_DECL.exec(line);
    if (match?.[1]) {
      flush();
      current = { name: match[1], lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return decls;
}

/** True when `body` calls `name` — call-shaped, so a bare mention of a
 *  common identifier cannot create a false edge. */
export function callsDeclaration(body: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(body);
}

/**
 * Declarations that reach one of `primitives`, directly or through a call to
 * another declaration in the same file. Fixed point, bounded by the
 * declaration count: each pass either adds a declaration or stops.
 */
export function computeReaching(
  decls: Map<string, Decl>,
  primitives: readonly string[],
): Set<string> {
  const reaching = new Set<string>();
  for (const decl of decls.values()) {
    if (primitives.some((p) => decl.body.includes(p))) reaching.add(decl.name);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const decl of decls.values()) {
      if (reaching.has(decl.name)) continue;
      for (const target of reaching) {
        if (target === decl.name) continue;
        if (callsDeclaration(decl.body, target)) {
          reaching.add(decl.name);
          changed = true;
          break;
        }
      }
    }
  }
  return reaching;
}

/** Top-level `const NAME = "literal"` values, for `tool: PING_TOOL` forms. */
export function stringConstants(decls: Map<string, Decl>): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of decls.values()) {
    const m = new RegExp(
      `^(?:export\\s+)?(?:const|let)\\s+${decl.name}\\s*(?::[^=]+)?=\\s*["'\`]([^"'\`]+)["'\`]`,
    ).exec(decl.body);
    if (m?.[1]) out.set(decl.name, m[1]);
  }
  return out;
}

/** Read a source file and return its comment-free, process-spawn-erased text
 *  segmented into top-level declarations. */
export async function declarationsOf(absPath: string): Promise<Map<string, Decl>> {
  const source = eraseProcessSpawns(stripComments(await Bun.file(absPath).text()));
  return segmentDeclarations(source);
}
