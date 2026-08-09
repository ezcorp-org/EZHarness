/**
 * Layout-insensitive matching for meta-tests that PIN an invariant by reading
 * a source file as text.
 *
 * Several security regression pins assert that a specific construct is present
 * in the source. They were written against a repo with no formatter, so they
 * matched the exact line breaks the author happened to leave. That couples the
 * pin to LAYOUT: rewrapping the pinned statement — by a formatter, or by hand
 * when a line grows past the margin — silently breaks the pin while the
 * property it guards is completely untouched. A pin that fails for a cosmetic
 * reason gets "fixed" by loosening it, and a loosened pin stops biting.
 *
 * Collapsing runs of whitespace to a single space removes layout and NOTHING
 * else: the token sequence, their order, and every string literal survive
 * intact. So a squished match is exactly as strict as the original — deleting,
 * reordering, or altering any token still fails. It only stops a line break
 * from counting as a difference.
 *
 * Use this instead of relaxing a pattern with `[\s\S]*?`, which does weaken
 * the assertion: it lets arbitrary intervening code satisfy the match.
 */

/** Collapse every run of whitespace to a single space, and trim the ends. */
export function squish(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

/**
 * `squish`, plus the two other things a formatter does to a CALL when it
 * decides the call is too long for one line:
 *   - puts the first argument on its own line  → a space just inside `(`
 *   - adds a trailing comma after the last one → `5, )` instead of `5)`
 *
 * Both are pure syntax noise. Normalizing them lets a pin quote a call the way
 * a human writes it — `f(a, b, c)` — and still match the wrapped form. The
 * arguments, their order, and their spelling are all still required exactly.
 *
 * Caveat, stated rather than hidden: this also normalizes the same characters
 * INSIDE string literals, so two literals differing only by a space after a
 * comma would compare equal. That is acceptable for pinning call sites; if you
 * are pinning the exact content of a string, use {@link squishedContains}.
 */
export function normalizeCallSyntax(source: string): string {
  return squish(source)
    .replace(/([([])\s+/g, "$1")
    .replace(/\s+([)\]])/g, "$1")
    .replace(/,\s*([)\]}])/g, "$1");
}

/**
 * Layout-insensitive `String.includes`. Both sides are squished, so the needle
 * can be written on as many lines as reads well at the call site.
 */
export function squishedContains(source: string, needle: string): boolean {
  return squish(source).includes(squish(needle));
}

/** {@link squishedContains}, tolerant of a call having been wrapped. */
export function containsCall(source: string, call: string): boolean {
  return normalizeCallSyntax(source).includes(normalizeCallSyntax(call));
}

/**
 * Layout-insensitive `String.indexOf`, for pins that assert ORDER (e.g. "the
 * rationale comment must sit above the predicate it explains"). Offsets are
 * into the squished string, so they are only meaningful against each other —
 * which is all an ordering assertion needs.
 */
export function squishedIndexOf(source: string, needle: string): number {
  return squish(source).indexOf(squish(needle));
}
