/**
 * Deterministic ordering primitives shared by both chat-graph builders.
 *
 * `createdAt` is the documented ordering axis for every builder
 * (`types.ts`), but timestamps collide: a turn's tool calls are persisted
 * in the same queued flush and routinely land on the same millisecond. So
 * EVERY sort in this subsystem is `createdAt` ASC then `id` ASC — the tie
 * break is what makes the positional observability zip (see the binding
 * rule at the bottom of `types.ts`) reproducible rather than dependent on
 * row-return order.
 *
 * Extracted so level 1 and level 2 provably sort the same way instead of
 * each carrying its own comparator.
 */

/** Anything the builders sort: an id plus an ISO-8601 timestamp. */
export interface TimeOrdered {
  id: string;
  createdAt: string;
}

/** `createdAt` ASC, `id` ASC on a tie. Use with `Array#sort` on a COPY. */
export function byCreatedAtThenId(a: TimeOrdered, b: TimeOrdered): number {
  const delta = toMs(a.createdAt) - toMs(b.createdAt);
  if (delta !== 0) return delta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * ISO-8601 → epoch milliseconds for window math.
 *
 * Numeric comparison rather than lexicographic: the builders receive
 * strings produced by `Date#toISOString()` today, but an offset-bearing
 * ISO string (`…+02:00`) sorts wrong as text and right as a number, and a
 * graph that silently mis-orders a turn is worse than one that costs a
 * parse. An unparseable value yields `NaN`, which makes every comparison
 * false — the fail-quiet outcome (node keeps its position, no duration
 * match) rather than a thrown request.
 */
export function toMs(iso: string): number {
  return Date.parse(iso);
}
