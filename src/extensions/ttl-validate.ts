/**
 * Phase 56 (per-capability TTL UI) — shared validator for the
 * `ttlOverrideMs` body field. Used by BOTH:
 *   • web/src/routes/api/extensions/[id]/reapprove/+server.ts (settings)
 *   • src/routes/tool-permission.ts                              (chat)
 *
 * Single source of truth so the picker's Never-suppression and the
 * "must be a positive number, null, or omitted" error string don't
 * drift between endpoints. Pitfall 2 (RESEARCH): `null` is the SOLE
 * Never sentinel; `0`/negative/NaN/Infinity are malformed and rejected
 * with a 400 — not collapsed to "Never" — because a `0`-ms TTL would
 * expire the grant the moment it lands on disk.
 *
 * Pure (no I/O, no logging); both web/Node Bun runtimes consume it.
 */
export type TtlValidation =
  | { ok: true; value: number | null | undefined }
  | { ok: false; error: string };

/**
 * Three-branch parser:
 *   • `undefined`                              → ok with `undefined` (legacy path).
 *   • `null`                                   → ok with `null` (Never selection).
 *   • positive finite `number`                 → ok with `Math.floor(n)` (defensive
 *                                                truncation so a fractional ms doesn't
 *                                                propagate into Date arithmetic).
 *   • everything else (0, -5, NaN, Infinity,
 *     strings, booleans, objects, arrays)      → 400 with the locked error string.
 *
 * The error string is asserted verbatim by the route tests at
 * web/src/__tests__/extensions-reapprove-route.server.test.ts and
 * src/__tests__/tool-permission-handler.test.ts (`positive number.*null.*omitted`).
 */
export function parseTtlOverrideMs(raw: unknown): TtlValidation {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return { ok: true, value: Math.floor(raw) };
  }
  return {
    ok: false,
    error: "ttlOverrideMs must be a positive number, null, or omitted",
  };
}
