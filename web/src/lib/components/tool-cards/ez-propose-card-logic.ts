/**
 * Pure parsing for the `propose_*` concierge tools' result card
 * (`cardType: "ez-propose"`).
 *
 * `propose_create_project` / `propose_create_agent` /
 * `propose_install_extension` each persist an `ez_drafts` row server-side
 * and return `{ draftId, openUrl }` (the deep-link into the prefilled
 * destination form, e.g. `/new-project?prefill=<id>`). By the time the
 * result reaches `ToolCallState.output` the store has unwrapped the MCP
 * envelope to its joined text, so `output` is a JSON string here (or,
 * defensively, the raw object) — handled uniformly by
 * {@link extractEzCardObject}.
 *
 * Unlike the install card, the heading/label copy is NOT baked in here:
 * `EzToolResultCard` derives the title, summary, and button label from
 * the tool name (propose_create_project → "Open new project form", etc.).
 * We only need to surface a usable `openUrl` — without it the card has no
 * actionable affordance, so we return `null` and let the router fall back
 * to DefaultCard (raw JSON), exactly the pre-fix behavior.
 */

import type { EzProposeResult } from "$lib/components/ez/ez-tool-result.js";
import { extractEzCardObject } from "./ez-install-card-logic.js";

export function parseProposeCardResult(output: unknown): EzProposeResult | null {
  const obj = extractEzCardObject(output);
  if (!obj) return null;
  if (typeof obj.openUrl !== "string" || obj.openUrl.length === 0) return null;
  const draftId = typeof obj.draftId === "string" ? obj.draftId : undefined;
  return {
    openUrl: obj.openUrl,
    ...(draftId ? { draftId } : {}),
  };
}
