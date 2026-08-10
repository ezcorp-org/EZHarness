/**
 * Pure parsing for the `create_extension` tool-result card
 * (`cardType: "ez-draft"`).
 *
 * `create_extension`'s only actionable output is the `openUrl` deep-link
 * into the draft editor (`/extensions/author?prefill=<draftId>`), and it
 * used to be invisible: the tool declared no `cardType`, so the result
 * rendered in `DefaultCard` — collapsed by default, and the collapsed
 * header preview truncates at 50 chars, which cut the URL off entirely.
 * Expanding showed it as plain text in a `<pre>`, never a link. The
 * README claimed the user "opens that URL"; nothing made that possible
 * in one click.
 *
 * Routing it to `EzToolResultCard` renders the URL as a real anchor
 * (same-origin relative href, SvelteKit-enhanced), so the scaffold →
 * edit hand-off is one click.
 */

import type { EzProposeResult } from "$lib/components/ez/ez-tool-result.js";
import { extractEzCardObject } from "./ez-install-card-logic.js";

/**
 * Parse a `create_extension` output into the card's render props.
 * Returns `null` — router falls back to DefaultCard — when the payload
 * carries no usable `openUrl`, or when the tool reported a failure
 * (`ok:false`), so a failed scaffold can never render as a success card.
 */
export function parseDraftCardResult(output: unknown): EzProposeResult | null {
  const obj = extractEzCardObject(output);
  if (!obj) return null;
  if (obj.ok === false) return null;
  if (typeof obj.openUrl !== "string" || obj.openUrl.length === 0) return null;
  const name = typeof obj.name === "string" ? obj.name : undefined;
  const type = typeof obj.type === "string" ? obj.type : undefined;
  const draftId = typeof obj.draftId === "string" ? obj.draftId : undefined;
  return {
    openUrl: obj.openUrl,
    ...(draftId ? { draftId } : {}),
    openUrlLabel: "Open draft editor",
    title: name ? `Draft ready: ${name}` : "Extension draft ready",
    summary: name
      ? `Scaffolded ${name}${type ? ` (${type})` : ""}. Review and edit the files, then install.`
      : "Review and edit the scaffolded files, then install.",
  };
}
