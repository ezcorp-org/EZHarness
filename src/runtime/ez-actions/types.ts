/**
 * Type definitions for the EZ Actions runtime sigil — `![EZ:name]`
 * tokens that invoke a server-side handler and persist a result card
 * inline in the conversation, without the LLM ever seeing the token.
 *
 * The sigil/token grammar lives in `web/src/lib/mention-logic.ts`
 * (kind="EZ" under the `!` sigil). Server-side prompt-stripping lives
 * in `src/runtime/mention-wiring.ts::stripEzActionTokens`. The registry
 * is `./registry.ts`. Each handler is a separate file under this dir.
 *
 * Design notes:
 *   - Handlers are nullary in v1 — no per-action arguments. The token
 *     `![EZ:distill]` is a verb, not a verb+args. Multi-arg actions
 *     are v2.
 *   - All three result discriminants render a card. Only `success`
 *     carries a structured `ref` (e.g. lesson slug) used by the UI to
 *     render a clickable link to the referenced entity.
 *   - Cards are persisted as `messages` rows with `role:
 *     "ez-action-result"` and the JSON `EzActionResult` payload in
 *     `content`. NO new column or check constraint — `role` is free
 *     text.
 */

/**
 * Per-invocation context handed to every action handler. Resolved
 * server-side from the request: `userId` is the authenticated user,
 * `conversationId` is the conversation owning the user message that
 * carried the token, and `projectId` is the conversation's project.
 *
 * Handlers MUST NOT trust client-supplied identifiers — these three
 * fields are populated from the auth/db layer in the dispatch
 * endpoint, never from the request body.
 */
export interface EzActionContext {
  conversationId: string;
  userId: string;
  projectId: string;
}

/**
 * The card spec a handler returns. Variant drives the UI styling
 * (success: emerald, info: sky, warning: amber, error: rose). Title
 * + body are user-facing strings; keep both short — the card renders
 * inline in chat history alongside the user's message.
 */
export interface EzActionCard {
  title: string;
  body: string;
  variant: "success" | "info" | "warning" | "error";
}

/**
 * Reference to a structured entity the success card links to. The
 * UI renders this as a clickable link that navigates to the
 * appropriate surface (e.g. `/memories` Lessons tab pre-filtered to
 * the slug for `kind: "lesson"`).
 *
 * Only present on `kind: "success"` results — `decline` and `error`
 * carry a human-readable reason in `card.body` instead.
 */
export type EzActionRef =
  | { kind: "lesson"; slug: string };

/**
 * Discriminated result of a handler invocation:
 *   - `success`: action did its thing, optional `ref` to the
 *     resulting entity for the UI to deep-link.
 *   - `decline`: the action's preconditions / output disqualify the
 *     run from producing a result, but the failure is expected (e.g.
 *     LLM returned EMPTY, conversation has no messages). Card
 *     surfaces the reason. Diagnostic value — this is the v1.5
 *     surface the lessons-keeper missed.
 *   - `error`: an unexpected failure (DB throw, auth mismatch,
 *     handler bug). Card body shows a sanitized error message.
 *     v1 surfaces these distinct from `decline` so users + dev can
 *     tell genuine bugs from "nothing to capture" cases.
 */
export type EzActionResult =
  | { kind: "success"; card: EzActionCard; ref?: EzActionRef }
  | { kind: "decline"; card: EzActionCard }
  | { kind: "error"; card: EzActionCard };

/**
 * The action contract. `name` is the slug used inside the token
 * (`![EZ:<name>]`); it must be lowercase + match the registry-key
 * uniqueness invariant. `description` shows in the popover. `handler`
 * runs under the user's session — every implementation MUST treat
 * `ctx` as authoritative and re-verify ownership against the DB
 * before mutating anything.
 */
export interface EzAction {
  name: string;
  description: string;
  handler: (ctx: EzActionContext) => Promise<EzActionResult>;
  /**
   * WS3 quality-tier routing (pi-caching/routing integration). Optional
   * model-tier need this action declares — the parallel declaration
   * surface to an extension manifest's `routing.tier`. Combined with any
   * extension-declared tiers by `strongestTier` and fed to the classifier
   * as its `declaredTier` signal (see `src/runtime/tier-classifier.ts`).
   * v1 EZ actions are code-defined and mostly action-only (they invoke a
   * handler without an LLM turn), so this field is the declaration surface;
   * threading a mixed EZ+content turn's declared tier into chat routing is
   * a documented follow-up. Absent = no tier preference.
   */
  tier?: import("../tier-classifier").RoutingTier;
}
