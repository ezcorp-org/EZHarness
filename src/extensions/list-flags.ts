/**
 * Derived, read-only flags the Extensions page needs on every row.
 *
 * `isCritical` is not a column: it is a property of the BUNDLED CATALOG
 * (`critical: true` in `src/extensions/bundled.ts`), which the browser has
 * no business hardcoding. Deriving it here keeps the two surfaces that ship
 * extension rows to that page — the SSR loader and `GET /api/extensions` —
 * agreeing on the same answer, which is the whole reason this is a shared
 * mapper and not two inline `.map()` calls.
 *
 * It lives HERE, next to the catalog it reads, rather than under
 * `web/src/lib/server/`, for a coverage reason worth stating: the web
 * bun-leg suite `web/src/__tests__/extensions-api.test.ts` imports the
 * extensions route, which imports this module. Bun's coverage emitter
 * attributes zero-hit records to the DECLARATION lines of a multi-line
 * function signature — lines V8, and so the vitest leg, never emits at all
 * — and `merge-lcov.ts` sums per `(SF, line)`. Under `web/src/lib/**` (a
 * vitest-measured path) those bun-only records survived the merge as
 * permanent misses no test could reach, and this file read 54% while being
 * fully tested. See the "Coverage trap" note in the root CLAUDE.md.
 */
import { isCriticalBundledExtensionName } from "./bundled";
import { userConsequenceFor } from "./critical-consequence";

/** A row with its derived flags. `isCritical` is always present. */
export type WithListFlags<T> = T & {
  isCritical: boolean;
  /** Present only when `isCritical` — what turning it off costs. */
  criticalConsequence?: string;
};

/** Attach the derived flags to one extension row. */
export function withListFlags<T extends { name: string }>(row: T): WithListFlags<T> {
  const isCritical = isCriticalBundledExtensionName(row.name);
  return {
    ...row,
    isCritical,
    // Sent only for the rows that need it, so the page never has to decide
    // whether a consequence sentence applies — its presence IS the answer.
    ...(isCritical ? { criticalConsequence: userConsequenceFor(row.name) } : {}),
  };
}

/** Attach the derived flags to every row in a list. */
export function withListFlagsAll<T extends { name: string }>(rows: T[]): WithListFlags<T>[] {
  return rows.map(withListFlags);
}
