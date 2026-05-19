/**
 * Phase 48 Wave 2 — find_agents Ez tool.
 *
 * Ranked search across the user's accessible agentConfigs (owned +
 * shared) by query against name, prompt, capabilities, and category.
 * Returns up to 10 hits with a deep-link URL into `/agents/<id>` so the
 * Ez panel can render a list-of-cards.
 *
 * Ranking is a simple tiered score — exact name match > name substring
 * > capability tag match > prompt substring > category match. We do
 * the ranking in-memory because the candidate set is small (single-user
 * agent libraries rarely exceed dozens of rows). When that stops being
 * true, swap in tsvector full-text search.
 */
import { Type } from "@mariozechner/pi-ai";
import type { BuiltinToolDef } from "../types";
import { listAgentConfigs } from "../../../db/queries/agent-configs";
import type { EzToolContext } from "./propose-create-project";

const MAX_RESULTS = 10;

interface RankedHit {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  category: string | null;
  shared: boolean;
  score: number;
  url: string;
}

function scoreAgent(
  q: string,
  agent: { name: string; prompt: string; description: string; capabilities: string[] | null; category: string | null },
): number {
  const ql = q.toLowerCase();
  const name = agent.name.toLowerCase();
  const prompt = agent.prompt.toLowerCase();
  const desc = (agent.description ?? "").toLowerCase();
  const caps = (agent.capabilities ?? []).map((c) => c.toLowerCase());
  const cat = (agent.category ?? "").toLowerCase();

  let score = 0;
  if (name === ql) score += 100;
  else if (name.includes(ql)) score += 50;
  if (caps.some((c) => c === ql)) score += 30;
  else if (caps.some((c) => c.includes(ql))) score += 15;
  if (prompt.includes(ql)) score += 10;
  if (desc.includes(ql)) score += 8;
  if (cat && cat.includes(ql)) score += 5;
  return score;
}

export function createFindAgentsTool(ctx: EzToolContext): BuiltinToolDef {
  return {
    name: "find_agents",
    label: "find_agents",
    description:
      "Search the user's accessible agents (owned + shared) by name, capability, prompt content, and category. Returns ranked matches with deep-link URLs.",
    category: "ez",
    cardType: "default",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Search term — checked against name, capabilities, prompt, and category." },
      },
      required: ["query"],
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const query = typeof params?.query === "string" ? params.query.trim() : "";
        if (!query) {
          return { content: [{ type: "text" as const, text: "Error: query is required" }], details: { isError: true } };
        }
        const all = await listAgentConfigs(ctx.userId);

        const ranked: RankedHit[] = all
          .map((a) => {
            const capabilities = (a.capabilities ?? []) as string[];
            const score = scoreAgent(query, {
              name: a.name,
              prompt: a.prompt,
              description: a.description,
              capabilities,
              category: a.category,
            });
            const shared = (a as { shared?: boolean }).shared === true;
            return {
              id: a.id,
              name: a.name,
              description: a.description,
              capabilities,
              category: a.category,
              shared,
              score,
              url: `/agents/${a.id}`,
            };
          })
          .filter((h) => h.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_RESULTS);

        const result = {
          query,
          count: ranked.length,
          agents: ranked.map((h) => ({
            id: h.id,
            name: h.name,
            description: h.description,
            capabilities: h.capabilities,
            category: h.category,
            shared: h.shared,
            url: h.url,
          })),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: { isError: true } };
      }
    },
  };
}
