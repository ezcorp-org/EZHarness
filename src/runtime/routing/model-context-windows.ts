/**
 * Context-window corrections — the one place that decides how big a model's
 * window REALLY is, and whether we actually know.
 *
 * WHY THIS EXISTS
 * ---------------
 * `contextWindow` is not a cosmetic label. `computeInputBudget`
 * (src/runtime/stream-chat/context-compaction.ts) derives the compaction
 * budget from it, so a wrong number is a wrong TRIM POINT, and the two failure
 * directions are not symmetric:
 *
 *   - UNDERSTATED (a synthesized 128k guess) trims a thread harder than it
 *     needs to. Silent history loss, no error — the hazard
 *     `./dropped-models.ts` exists to name.
 *   - OVERSTATED never trims at all. The thread grows past what the provider
 *     accepts and every subsequent turn hard-fails at the API
 *     (Anthropic: 400 "prompt is too long"), which the user cannot clear from
 *     the UI because the history that broke it is already saved. This is
 *     strictly worse, and it is what the Sonnet 4.5 correction below prevents.
 *
 * Deliberately pure — no catalog import, no DB, no network — so both the
 * correction and the "do we know this?" decision are testable in isolation and
 * live INSIDE the coverage gate. `src/providers/**` is in `EXCLUDES`
 * (scripts/coverage-config.ts), which is precisely why its two synthesized
 * 128k stand-ins shipped with no test naming them.
 */

/**
 * The window assumed when a model resolves to nothing better. Callers that use
 * it MUST mark the result estimated — the whole point of `WindowFacts.estimated`
 * is that an invented number stops rendering identically to a measured one.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * A model's window plus whether we actually know it.
 *
 * `estimated` is not "we are unsure" hand-waving — it is the specific claim
 * that NO catalog reported this number and it was invented by a fallback.
 */
export interface WindowFacts {
  contextWindow: number;
  estimated: boolean;
}

/**
 * Ids the installed catalog reports with a window the vendor does not honour.
 *
 * `match` runs against the NORMALIZED id (see `normalizeModelId`) so one entry
 * covers a model however it is spelled across gateways — `claude-sonnet-4-5`
 * on anthropic, `anthropic/claude-sonnet-4.5:batch` on openrouter, and the
 * same id again on kilo and vercel-ai-gateway.
 *
 * `cap` is applied as a CEILING, never as an assignment. A provider already
 * reporting the correct (or a smaller) number is left exactly as it is, so
 * this table can only ever move a window DOWN — the safe direction. That also
 * means adding an entry can never introduce the overstatement failure above,
 * only remove it.
 */
interface WindowCorrection {
  match: RegExp;
  cap: number;
  why: string;
}

const WINDOW_CORRECTIONS: readonly WindowCorrection[] = [
  {
    // Claude Sonnet 4 and 4.5 only. The 1M figure is the `context-1m-2025-08-07`
    // BETA window recorded upstream as if it were the default; EZCorp never
    // sends that header (no occurrence anywhere in src/, web/, or pi-ai's own
    // anthropic-messages transport), so 1M is unreachable for us in practice.
    //
    // The installed catalog contradicts ITSELF on this, which is the evidence
    // that 200k is right and no vendor doc is needed to see it: amazon-bedrock,
    // cloudflare-ai-gateway, opencode and github-copilot all report 200k for
    // the same model that anthropic, openrouter and vercel-ai-gateway report
    // at 1M.
    //
    // Deliberately does NOT match Sonnet 4.6 or Sonnet 5 — those are 1M on
    // every provider that lists them, consistently, and are genuinely 1M.
    match: /^claude-sonnet-4(?:[.-]5)?(?:-\d{8})?$/,
    cap: 200_000,
    why: "Claude Sonnet 4/4.5 is 200k; 1M requires the context-1m beta header, which is never sent",
  },
];

/**
 * Reduce a catalog id to the bare model name so one correction entry covers
 * every gateway's spelling of it.
 *
 * Strips a vendor prefix (`anthropic/claude-sonnet-4.5`), a region prefix
 * (bedrock's `us.anthropic.…`), and a variant suffix (`:batch`, `:free`,
 * `:thinking`). Lowercased, because gateways disagree on case.
 *
 * Intentionally conservative: it only removes structure this repo has actually
 * observed in a shipped catalog. An id it does not recognise passes through
 * unchanged and simply matches nothing, which is the correct default — a
 * missed correction leaves today's behavior, while an over-eager one would
 * silently shrink an unrelated model's budget.
 */
export function normalizeModelId(modelId: string): string {
  let id = modelId.toLowerCase().trim();
  const colon = id.indexOf(":");
  if (colon > 0) id = id.slice(0, colon);
  const slash = id.lastIndexOf("/");
  if (slash >= 0) id = id.slice(slash + 1);
  // Bedrock's region-qualified ids ("us.anthropic.claude-sonnet-4-5-…"). The
  // ":0" half of its "-v1:0" suffix is already cut by the colon rule above.
  const lastDot = id.lastIndexOf(".");
  if (lastDot >= 0 && /^[a-z0-9.]+\.[a-z]/.test(id)) id = id.slice(lastDot + 1);
  // Bedrock's trailing model-version marker ("…-20250929-v1"). Dropped so one
  // correction entry covers bedrock's spelling too; ids that merely END in a
  // version marker and match no correction are unaffected either way.
  id = id.replace(/-v\d+$/, "");
  return id;
}

/**
 * The window to actually use for this model.
 *
 * `declared` is whatever the catalog said — pass `undefined` (or a
 * non-positive/non-finite number) when nothing reported one, and the result is
 * the fallback marked `estimated: true`.
 *
 * A declared number is never marked estimated even when a correction lowers
 * it: the corrected value is MORE certain than the catalog's, not less.
 * `estimated` means "invented", and callers key their UI off exactly that.
 */
export function resolveContextWindow(
  provider: string,
  modelId: string,
  declared?: number | null,
): WindowFacts {
  if (typeof declared !== "number" || !Number.isFinite(declared) || declared <= 0) {
    return { contextWindow: FALLBACK_CONTEXT_WINDOW, estimated: true };
  }
  return { contextWindow: capForModel(modelId, declared), estimated: false };
}

/**
 * Apply the correction table to an already-known window. Split out from
 * `resolveContextWindow` for the call sites that have a catalog model in hand
 * and only need the ceiling — notably `resolveModelObject`, which must correct
 * the WIRE model's window so the compaction budget and the displayed window
 * are derived from the same corrected number.
 */
export function capForModel(modelId: string, declared: number): number {
  const normalized = normalizeModelId(modelId);
  let out = declared;
  for (const c of WINDOW_CORRECTIONS) {
    if (c.match.test(normalized)) out = Math.min(out, c.cap);
  }
  return out;
}

/**
 * Operator-facing explanation for a correction that fired, or null when the
 * declared window was already at or below every applicable cap. Used by the
 * settings/observability surfaces so a lowered window is never silent — the
 * same principle as `describeCatalogGap`.
 */
export function describeWindowCorrection(modelId: string, declared: number): string | null {
  const normalized = normalizeModelId(modelId);
  for (const c of WINDOW_CORRECTIONS) {
    if (c.match.test(normalized) && declared > c.cap) {
      return (
        `Model "${modelId}" is listed with a ${declared.toLocaleString()}-token context window, ` +
        `capped to ${c.cap.toLocaleString()}: ${c.why}.`
      );
    }
  }
  return null;
}
