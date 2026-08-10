import { sql, type SQL } from "drizzle-orm";

/**
 * Clamp an interval count to a safe non-negative integer.
 *
 * `INTERVAL` literals can only be built via `sql.raw()` (Drizzle cannot
 * parameterize the unit), so the count MUST be reduced to a trusted integer
 * before interpolation — otherwise a non-integer value reaching the query
 * (e.g. via an unvalidated future caller or a `as` cast that defeats the
 * `number` type) would be inlined verbatim into raw SQL. `Number()` +
 * `Math.floor` + the `[0, 3650]` bound guarantee the result is a plain
 * integer regardless of input shape; non-finite input falls back.
 */
export function safeIntervalCount(value: number, fallback = 30): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(3650, Math.floor(value)));
}

/**
 * Build a `NOW() - INTERVAL 'N unit'` fragment with an injection-safe count.
 *
 * `unit` is a fixed string-literal union (never user input), so embedding it
 * via `sql.raw` is safe; `count` is clamped through {@link safeIntervalCount}
 * so the only `sql.raw` value that touches the count is a bare integer.
 */
export function nowMinusInterval(count: number, unit: "days" | "minutes", fallback = 30): SQL {
  const n = safeIntervalCount(count, fallback);
  return sql`NOW() - INTERVAL '${sql.raw(String(n))} ${sql.raw(unit)}'`;
}
