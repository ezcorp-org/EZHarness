/**
 * Phase 48 Wave 2 — propose_create_agent Ez tool.
 *
 * Mirror of propose_create_project for the agent-creation flow. The Ez
 * concierge calls this when the user wants to scaffold a new agent
 * (e.g. "make me an agent that summarizes review comments"). The tool
 * persists name + prompt + inputSchema + capabilities into ez_drafts
 * (kind='agent') and returns `{ draftId, openUrl: '/agents/new?prefill=<id>' }`.
 * The /agents/new page reads ?prefill, hydrates form state, and the
 * user reviews-then-submits to actually create the agent.
 *
 * inputSchema is accepted as an opaque JSON object — the agent-creation
 * form has its own validation; this tool is a pass-through serializer.
 * Same goes for capabilities[] (free-form strings).
 */
import { Type } from "@earendil-works/pi-ai";
import type { BuiltinToolDef } from "../types";
import { createDraft } from "../../../db/queries/ez-drafts";
import type { EzToolContext } from "./propose-create-project";

export function createProposeCreateAgentTool(ctx: EzToolContext): BuiltinToolDef {
  return {
    name: "propose_create_agent",
    label: "propose_create_agent",
    description:
      "Draft a new agent (name, prompt, optional inputSchema and capabilities). Returns a URL the panel renders as 'Open prefilled form' — the user reviews and submits to actually create. This tool never mutates state.",
    category: "ez",
    // Routes the `{ draftId, openUrl }` result to EzToolResultCard so the
    // user gets the "Open prefilled form" button the EZ prompt promises.
    cardType: "ez-propose",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200, description: "Agent display name." },
        prompt: { type: "string", minLength: 1, maxLength: 20000, description: "System prompt that defines the agent's behavior." },
        inputSchema: { type: "object", description: "Optional JSON Schema for the agent's inputs.", additionalProperties: true },
        capabilities: { type: "array", items: { type: "string" }, description: "Optional list of capability tags (e.g. 'llm', 'mcp')." },
      },
      required: ["name", "prompt"],
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const name = typeof params?.name === "string" ? params.name.trim() : "";
        const prompt = typeof params?.prompt === "string" ? params.prompt : "";
        if (!name) {
          return { content: [{ type: "text" as const, text: "Error: name is required" }], details: { isError: true } };
        }
        if (!prompt.trim()) {
          return { content: [{ type: "text" as const, text: "Error: prompt is required" }], details: { isError: true } };
        }
        const inputSchema = params?.inputSchema && typeof params.inputSchema === "object" ? params.inputSchema : undefined;
        const capabilities = Array.isArray(params?.capabilities)
          ? params.capabilities.filter((c: unknown): c is string => typeof c === "string")
          : undefined;

        const payload: Record<string, unknown> = { name, prompt };
        if (inputSchema) payload.inputSchema = inputSchema;
        if (capabilities && capabilities.length > 0) payload.capabilities = capabilities;

        const draft = await createDraft({ userId: ctx.userId, kind: "agent", payload });
        const openUrl = `/agents/new?prefill=${draft.id}`;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ draftId: draft.id, openUrl }) }],
          details: { draftId: draft.id, openUrl, kind: "agent" as const },
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: { isError: true } };
      }
    },
  };
}
