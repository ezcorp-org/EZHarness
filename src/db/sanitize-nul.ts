/**
 * NUL (U+0000) scrubbing for values on their way into Postgres.
 *
 * Postgres cannot represent U+0000 in `text` OR `jsonb` — it is a hard
 * limitation of the storage format, not a configuration knob. Any insert
 * carrying one aborts server-side with:
 *
 *   ERROR: unsupported Unicode escape sequence
 *   DETAIL:   <NUL> cannot be converted to text.
 *
 * That is not hypothetical: extension subprocess spawn errors embed a NUL in
 * the reported path, and from 2026-07-20 onward every `tool_error` row silently
 * stopped being written to `observability_events` (198 rows, then nothing) while
 * the matching `tool_calls` rows vanished too. The failure was invisible because
 * both writers deliberately never throw — a failed tool call simply disappeared
 * from history and from the observability panel.
 *
 * ## Replace, don't strip
 *
 * Each NUL becomes U+FFFD REPLACEMENT CHARACTER rather than being deleted.
 * Stripping would turn `foo<NUL>bar` into `foobar` — a string that looks like a
 * legitimate value and gives an operator no signal that the stored data differs
 * from what the tool actually produced. U+FFFD is Unicode's designated marker
 * for "a character was here that could not be represented", so the substitution
 * stays visible and greppable in the UI, in logs, and in the DB. We are already
 * altering the value; pretending otherwise is the worse failure mode.
 *
 * ## Where this runs
 *
 * Wired into drizzle's column-level `mapToDriverValue` for `jsonb`/`json` and
 * `text` in `src/db/connection.ts`, on BOTH driver paths (PGlite and bun-sql).
 * That is the single chokepoint every one of the ~45 query modules already
 * flows through, so a new call site cannot forget it. `schema.ts` uses only
 * `text()` and `jsonb()` columns, so those two classes cover every
 * string-bearing column in the schema.
 */

/** U+0000. Built via `fromCharCode` on purpose — a literal NUL byte in a
 *  source file is invisible in review and makes the file register as binary
 *  to git and `grep`. */
const NUL = String.fromCharCode(0);

/** Unicode REPLACEMENT CHARACTER — what a stored NUL becomes. */
export const NUL_REPLACEMENT = String.fromCharCode(0xfffd);

/**
 * Replace every NUL in a single string. Returns the SAME string instance when
 * there is nothing to do, so the overwhelmingly common clean-string case costs
 * one scan and zero allocations.
 */
export function sanitizeNulString(value: string): string {
  return value.includes(NUL) ? value.replaceAll(NUL, NUL_REPLACEMENT) : value;
}

/**
 * Only plain objects are walked. A `Date`, `Buffer`, `Map`, or class instance
 * is returned untouched: rebuilding one from `Object.entries` would silently
 * destroy it (a `Date` would come back as `{}`), which is a far worse bug than
 * the one we are fixing. Values reaching a jsonb column in this codebase are
 * object/array literals or `JSON.parse` output, both of which are plain.
 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return sanitizeNulString(value);
  // null, undefined, numbers, booleans, bigints, symbols, functions: no strings
  // to scrub and nothing to recurse into.
  if (value === null || typeof value !== "object") return value;

  // Cycles and shared references: memoize the replacement container BEFORE
  // filling it, so a descendant pointing back at an ancestor resolves to the
  // same container instead of recursing forever.
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    seen.set(value, out);
    let changed = false;
    for (let i = 0; i < value.length; i++) {
      out[i] = walk(value[i], seen);
      if (out[i] !== value[i]) changed = true;
    }
    if (changed) return out;
    seen.set(value, value);
    return value;
  }

  if (!isPlainObject(value)) return value;

  // Object KEYS carry NULs too, and a NUL in a key aborts the insert exactly
  // like one in a value.
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  let changed = false;
  for (const [key, val] of Object.entries(value)) {
    const nextKey = sanitizeNulString(key);
    const nextVal = walk(val, seen);
    out[nextKey] = nextVal;
    if (nextKey !== key || nextVal !== val) changed = true;
  }
  if (changed) return out;
  seen.set(value, value);
  return value;
}

/* -------------------------------------------------------------------------- *
 * Fast path: decide whether there is anything to do BEFORE building anything.
 * -------------------------------------------------------------------------- */

/** `scan` outcomes. Plain numbers so the recursion allocates nothing. */
const CLEAN = 0;
const DIRTY = 1;
const BAILED = 2;
type ScanResult = typeof CLEAN | typeof DIRTY | typeof BAILED;

/**
 * Depth at which `scan` gives up and defers to `walk`.
 *
 * `scan` does not memoize — that is the whole point — so a cyclic value would
 * otherwise recurse until the stack dies. This is the guard that stops it, and
 * it has to be checked BEFORE the node budget: a tight self-cycle burns one
 * stack frame per node, so it would blow the stack long before 100k nodes.
 *
 * Real jsonb payloads here nest single digits deep; anything past this is
 * simply routed to the (slower, cycle-safe) `walk`, which is always correct.
 */
const MAX_SCAN_DEPTH = 128;

/**
 * Node ceiling for one `scan`. `scan` trades memoization for zero allocation,
 * so a value whose subtrees are heavily SHARED costs it one visit per path
 * rather than per node — pathologically, exponential. Bailing to the memoized
 * `walk` bounds that at "as slow as it was before this fast path existed".
 */
const MAX_SCAN_NODES = 100_000;

/** Remaining node budget for the in-flight `scan`. Module-level rather than a
 *  parameter so the recursion stays allocation-free; safe because `scan` is
 *  fully synchronous and never re-enters. */
let scanNodeBudget = 0;

/**
 * Report whether anything reachable from `value` needs scrubbing, WITHOUT
 * allocating. Deliberately mirrors `walk`'s traversal — same skip rules, same
 * key/value coverage — because a fast path that disagrees with the rebuild it
 * guards would wave a NUL straight through to Postgres.
 */
function scan(value: unknown, depth: number): ScanResult {
  if (typeof value === "string") return value.includes(NUL) ? DIRTY : CLEAN;
  if (value === null || typeof value !== "object") return CLEAN;

  if (depth > MAX_SCAN_DEPTH) return BAILED;
  if (--scanNodeBudget < 0) return BAILED;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const result = scan(value[i], depth + 1);
      if (result !== CLEAN) return result;
    }
    return CLEAN;
  }

  // `walk` leaves a Date / Buffer / class instance untouched, so there is
  // nothing for us to find inside one either.
  if (!isPlainObject(value)) return CLEAN;

  // `for…in` over a plain object yields exactly `Object.entries`' key set (a
  // plain prototype contributes no enumerable properties) and, unlike it,
  // allocates no pair arrays.
  for (const key in value) {
    if (key.includes(NUL)) return DIRTY;
    const result = scan((value as Record<string, unknown>)[key], depth + 1);
    if (result !== CLEAN) return result;
  }
  return CLEAN;
}

/**
 * Deep-scrub every string reachable from `value` — object keys and values,
 * array elements, arbitrarily nested, cycle-safe.
 *
 * Returns the ORIGINAL value (same identity) when nothing contained a NUL. The
 * clean path is the hot path — this runs on EVERY text and jsonb write on both
 * drivers — so it is served by an allocation-free scan and only falls through
 * to the rebuilding `walk` once a NUL is known to be present. Callers may rely
 * on the returned identity to detect a no-op.
 */
export function sanitizeNulDeep<T>(value: T): T {
  // A bare string is the overwhelmingly common binding (368 text columns in the
  // schema against 46 jsonb), so it never touches the graph machinery.
  if (typeof value === "string") return sanitizeNulString(value) as T;
  if (value === null || typeof value !== "object") return value;

  scanNodeBudget = MAX_SCAN_NODES;
  if (scan(value, 0) === CLEAN) return value;

  return walk(value, new WeakMap<object, unknown>()) as T;
}
