/**
 * Phase 48 Wave 2 — propose_install_extension Ez tool.
 *
 * Resolves a marketplace lookup and produces an openUrl pointing at
 * `/marketplace?q=<query>` (or `?id=<id>` when an exact match wins).
 * Unlike the propose_create_* tools, an install draft is informational —
 * the marketplace page is the install surface, so the tool returns the
 * shortlist + URL without persisting if there's nothing user-specific
 * to remember. We still write an `extension`-kind draft for symmetry
 * with the other propose_* tools (so the UI's "open prefilled" card has
 * a consistent shape).
 *
 * Inputs: either `extensionName` (exact slug/name lookup) or
 * `searchQuery` (free-text browse). At least one is required.
 */
import { Type } from "@earendil-works/pi-ai";
import type { BuiltinToolDef } from "../types";
import { createDraft } from "../../../db/queries/ez-drafts";
import { browseMarketplace, getListingBySlug } from "../../../db/queries/marketplace";
import type { EzToolContext } from "./propose-create-project";

const MAX_RESULTS = 5;

export function createProposeInstallExtensionTool(ctx: EzToolContext): BuiltinToolDef {
  return {
    name: "propose_install_extension",
    label: "propose_install_extension",
    description:
      "Search the marketplace for an extension by name or query and return a shortlist plus a URL into the marketplace page. The user installs from there — this tool never mutates state.",
    category: "ez",
    // Routes the `{ draftId, openUrl }` result to EzToolResultCard so the
    // user gets the "Browse extensions" button the EZ prompt promises.
    cardType: "ez-propose",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        extensionName: { type: "string", description: "Exact extension slug or display name to look up." },
        searchQuery: { type: "string", description: "Free-text search query for browsing the marketplace." },
      },
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const extensionName = typeof params?.extensionName === "string" ? params.extensionName.trim() : "";
        const searchQuery = typeof params?.searchQuery === "string" ? params.searchQuery.trim() : "";
        if (!extensionName && !searchQuery) {
          return {
            content: [{ type: "text" as const, text: "Error: provide extensionName or searchQuery" }],
            details: { isError: true },
          };
        }

        let extensions: Array<{ id: string; slug: string; name: string; description: string }> = [];
        let openUrl: string;

        if (extensionName) {
          // Try exact slug first, fall back to name browse.
          const exact = await getListingBySlug(extensionName).catch(() => undefined);
          if (exact) {
            extensions = [{ id: exact.id, slug: exact.slug, name: exact.name, description: exact.description }];
            openUrl = `/marketplace?slug=${encodeURIComponent(exact.slug)}`;
          } else {
            const browsed = await browseMarketplace({ query: extensionName, limit: MAX_RESULTS });
            extensions = browsed.map((l) => ({ id: l.id, slug: l.slug, name: l.name, description: l.description }));
            openUrl = `/marketplace?q=${encodeURIComponent(extensionName)}`;
          }
        } else {
          const browsed = await browseMarketplace({ query: searchQuery, limit: MAX_RESULTS });
          extensions = browsed.map((l) => ({ id: l.id, slug: l.slug, name: l.name, description: l.description }));
          openUrl = `/marketplace?q=${encodeURIComponent(searchQuery)}`;
        }

        const draft = await createDraft({
          userId: ctx.userId,
          kind: "extension",
          payload: { extensionName, searchQuery, openUrl, extensions },
        });

        const result = { draftId: draft.id, openUrl, extensions };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: { draftId: draft.id, openUrl, kind: "extension" as const, extensions },
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: { isError: true } };
      }
    },
  };
}
