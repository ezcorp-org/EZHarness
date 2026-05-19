/**
 * Phase 48 Wave 2 — propose_create_project Ez tool.
 *
 * The Ez concierge calls this when the user asks to scaffold a new
 * project. The tool persists the proposed name/path/description into the
 * `ez_drafts` table (kind='project') and returns a one-shot openUrl that
 * deep-links into `/new-project?prefill=<draftId>`. The destination page
 * reads `?prefill=`, hydrates form state, and the user reviews before
 * submitting — the form's existing Submit button IS the accept. No
 * separate "approve this draft" UI: the prefilled form is the surface.
 *
 * The tool itself never mutates the projects table — drafts are
 * inert until the user submits. Drafts auto-expire after 24h (see
 * `src/db/queries/ez-drafts.ts#sweepExpired`).
 */
import { Type } from "@mariozechner/pi-ai";
import type { BuiltinToolDef } from "../types";
import { createDraft } from "../../../db/queries/ez-drafts";

export interface EzToolContext {
  /** Acting user — required so the draft is owned by the right account
   *  and can only be redeemed by the same user (cross-user reads return
   *  undefined per the ownership check in getDraft). */
  userId: string;
}

export function createProposeCreateProjectTool(ctx: EzToolContext): BuiltinToolDef {
  return {
    name: "propose_create_project",
    label: "propose_create_project",
    description:
      "Draft a new project for the user from name/path/description. Returns a URL the panel renders as a one-button 'Open prefilled form' card. The user reviews the form and submits to actually create the project — this tool never mutates state on its own.",
    category: "ez",
    cardType: "default",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200, description: "Display name for the new project." },
        path: { type: "string", minLength: 1, maxLength: 500, description: "Filesystem path where the project lives or will live." },
        description: { type: "string", maxLength: 2000, description: "Short description of what the project is for." },
      },
      required: ["name", "path"],
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const name = typeof params?.name === "string" ? params.name.trim() : "";
        const path = typeof params?.path === "string" ? params.path.trim() : "";
        const description = typeof params?.description === "string" ? params.description : undefined;
        if (!name) {
          return { content: [{ type: "text" as const, text: "Error: name is required" }], details: { isError: true } };
        }
        if (!path) {
          return { content: [{ type: "text" as const, text: "Error: path is required" }], details: { isError: true } };
        }
        const draft = await createDraft({
          userId: ctx.userId,
          kind: "project",
          payload: { name, path, ...(description ? { description } : {}) },
        });
        const openUrl = `/new-project?prefill=${draft.id}`;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ draftId: draft.id, openUrl }) }],
          details: { draftId: draft.id, openUrl, kind: "project" as const },
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: { isError: true } };
      }
    },
  };
}
