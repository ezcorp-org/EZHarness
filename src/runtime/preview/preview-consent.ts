/**
 * Requester-scoped expose-consent + per-conversation "always expose"
 * preference (Secure User-Site Preview / Port Exposure, Phase 2 — see
 * tasks/preview-port-exposure.md §3.3 + DECISION D3).
 *
 * When the port watcher emits a `preview:detected` event, this module
 * decides what happens — ALWAYS scoped to the requesting user, in the
 * originating conversation only:
 *
 *   - If the conversation has opted into "always expose" (D3), the port
 *     is auto-exposed: a `dynamic` preview_sessions row is created and the
 *     ready `<id>.preview.<host>` URL is surfaced WITHOUT a prompt. Still
 *     requester-only; still gated by the access token at serve time.
 *
 *   - Otherwise a consent card is surfaced in the conversation with
 *     `[Expose] [Ignore] [Always expose in this conversation]`. NOTHING
 *     serves until the user clicks Expose (auto-detect ≠ auto-serve).
 *
 * The "always expose" preference is persisted in the existing key/value
 * `settings` table under `preview:always-expose:<conversationId>` — DRY:
 * no new migration, and it inherits the table's upsert/get/delete. The
 * stored value records the OWNING user so the flag can never leak to a
 * conversation re-owned by a different user (defense in depth).
 *
 * The actual delivery of the consent card into the conversation's live
 * stream is the host's job (the watcher's `onDetected` handler wires this
 * module's `decideOnDetection` to the SSE bridge). This module stays pure
 * + DB-only so it is fully unit/integration testable without a renderer.
 */

import { logger } from "../../logger";
import { getSetting, upsertSetting, deleteSetting } from "../../db/queries/settings";
import { createPreviewSession } from "../../db/queries/preview-sessions";
import { mintOneTimeCode } from "./preview-token";
import { getPreviewNetns } from "./preview-netns";
import type { PreviewDetectedEvent } from "./preview-port-watcher";

const log = logger.child("preview.consent");

/** The cardType the consent card renders under (mirrors `ez-propose`). */
export const PREVIEW_CONSENT_CARD_TYPE = "ez-preview-consent";

/** Settings-table key for a conversation's "always expose" preference. */
export function alwaysExposeSettingKey(conversationId: string): string {
  return `preview:always-expose:${conversationId}`;
}

interface AlwaysExposeValue {
  /** The user who opted in — guards against a re-owned conversation. */
  userId: string;
  enabled: true;
}

/**
 * Enable the per-conversation "always expose" preference for `userId`.
 * Scoped to the (conversation, user) pair.
 */
export async function setAlwaysExpose(conversationId: string, userId: string): Promise<void> {
  if (!conversationId || !userId) return;
  const value: AlwaysExposeValue = { userId, enabled: true };
  await upsertSetting(alwaysExposeSettingKey(conversationId), value);
}

/** Turn the preference back off (default state). Idempotent. */
export async function clearAlwaysExpose(conversationId: string): Promise<void> {
  if (!conversationId) return;
  await deleteSetting(alwaysExposeSettingKey(conversationId));
}

/**
 * Whether `userId` has the "always expose" preference set for this
 * conversation. Requester-scoped: a flag stored by a DIFFERENT user does
 * NOT count (so a conversation re-owned by someone else falls back to the
 * per-site click — fail closed).
 */
export async function isAlwaysExpose(conversationId: string, userId: string): Promise<boolean> {
  if (!conversationId || !userId) return false;
  const raw = await getSetting(alwaysExposeSettingKey(conversationId));
  if (!raw || typeof raw !== "object") return false;
  const v = raw as Partial<AlwaysExposeValue>;
  return v.enabled === true && v.userId === userId;
}

/** Result shape returned to the caller for surfacing into the conversation. */
export type DetectionDecision =
  | {
      kind: "auto-exposed";
      previewId: string;
      port: number;
      /** One-time code the browser redeems at `/__open?c=<code>`. */
      code: string;
      /** The `<id>` subdomain label — the host completes it into the URL. */
      subdomainLabel: string;
    }
  | {
      kind: "consent-card";
      port: number;
      /** Card payload (see buildConsentCardPayload). */
      card: ConsentCardPayload;
    }
  | { kind: "skipped"; reason: string };

/** The payload the consent card renders from (cardType = ez-preview-consent). */
export interface ConsentCardPayload {
  conversationId: string;
  port: number;
  title: string;
  summary: string;
  /** Stable affordance identifiers the client posts back. */
  actions: { expose: string; ignore: string; alwaysExpose: string };
}

/**
 * Build the consent card payload for a detected port. Pure — no DB, no
 * side effects — so the card copy is unit-testable. The cardType
 * (PREVIEW_CONSENT_CARD_TYPE) is set by the caller when it emits the card
 * onto the conversation stream (per the prior incident: a card without
 * `cardType` won't render — see ToolCardRouter wiring).
 */
export function buildConsentCardPayload(conversationId: string, port: number): ConsentCardPayload {
  return {
    conversationId,
    port,
    title: `A site started on port ${port}`,
    summary: "Expose it to your browser? Nothing is served until you choose.",
    actions: { expose: "expose", ignore: "ignore", alwaysExpose: "always-expose" },
  };
}

/**
 * Expose a detected port: create a `dynamic` preview_sessions row owned by
 * `userId` + scoped to the conversation's netns, then mint a one-time code
 * for the browser handoff. Returns the preview id, code, and subdomain
 * label; the host completes `<label>.preview.<host>` into the final URL
 * (the app host isn't known here).
 *
 * This is the SINGLE expose path — used by both the explicit [Expose]
 * click and the D3 auto-expose branch (DRY). It does NOT serve anything by
 * itself; the access token gate still applies at serve time.
 */
export async function exposeDetectedPort(event: PreviewDetectedEvent): Promise<{
  previewId: string;
  code: string;
  subdomainLabel: string;
}> {
  const { userId, conversationId, port } = event;
  if (!userId) throw new Error("exposeDetectedPort: userId is required");
  if (!conversationId) throw new Error("exposeDetectedPort: conversationId is required");
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`exposeDetectedPort: invalid port ${port}`);
  }
  // The conversation's netns id (if allocated) pins the dynamic preview to
  // the right namespace. Null is acceptable — Phase 3 wires the live
  // passthrough; the registry row + access gate are valid today.
  const netns = getPreviewNetns(conversationId);
  const row = await createPreviewSession({
    userId,
    conversationId,
    kind: "dynamic",
    targetPort: port,
    netnsId: netns?.netnsId ?? null,
  });
  const code = mintOneTimeCode({ previewId: row.id, userId });
  return { previewId: row.id, code, subdomainLabel: row.id };
}

/**
 * Decide what to do for a requester-scoped detection event. Honors the
 * per-conversation "always expose" preference (D3): when set for THIS
 * user, auto-expose; otherwise return a consent card for the host to
 * surface in the originating conversation.
 *
 * Pure routing over the preference + the expose path — the host is
 * responsible for actually rendering the card / URL onto the stream.
 */
export async function decideOnDetection(event: PreviewDetectedEvent): Promise<DetectionDecision> {
  const { userId, conversationId, port } = event;
  if (!userId || !conversationId) {
    return { kind: "skipped", reason: "missing userId/conversationId" };
  }

  if (await isAlwaysExpose(conversationId, userId)) {
    const { previewId, code, subdomainLabel } = await exposeDetectedPort(event);
    log.info("preview auto-exposed (always-expose preference)", {
      conversationId,
      port,
      previewId,
    });
    return { kind: "auto-exposed", previewId, port, code, subdomainLabel };
  }

  log.info("preview consent card surfaced", { conversationId, port });
  return {
    kind: "consent-card",
    port,
    card: buildConsentCardPayload(conversationId, port),
  };
}
