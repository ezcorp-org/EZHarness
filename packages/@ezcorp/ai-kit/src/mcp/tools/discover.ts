// fallow-ignore-file duplicate-export
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EzcorpClient } from "../../client.js";
import { mentionSearchInput } from "../../types.js";

export const TOOLS = [
  { name: "list_projects", description: "List all EZCorp projects the authenticated user can access. Use this first to get a projectId for other tools." },
  { name: "list_agents", description: "List all agent configs defined in EZCorp. Use this to discover available agents before mentioning them in messages." },
  { name: "search_mentions", description: "Search for mentionable items (agents, teams, extensions, files, commands) by query. Use this to resolve mention tokens before composing a message." },
  { name: "list_models", description: "List all LLM models available in this EZCorp instance. Use this to validate model identifiers before starting a chat." },
  { name: "list_extensions", description: "List all installed EZCorp extensions. Use this to discover extension capabilities before referencing them in messages. (DEPRECATED — use extension_search)" },
  { name: "extension_search", description: "Search installed EZCorp extensions by name/description substring (case-insensitive). Returns matching extensions with a curated `tools` list (`{ name, description }` only) per extension. Omit `query` to list everything. Prefer this over `list_extensions`." },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export function register(server: McpServer, client: EzcorpClient): void {
  server.tool(
    "list_projects",
    "List all EZCorp projects the authenticated user can access. Use this first to get a projectId for other tools.",
    {},
    async () => {
      const projects = await client.listProjects();
      return { content: [{ type: "text" as const, text: JSON.stringify(projects) }] };
    },
  );

  server.tool(
    "list_agents",
    "List all agent configs defined in EZCorp. Use this to discover available agents before mentioning them in messages.",
    {},
    async () => {
      const agents = await client.listAgents();
      return { content: [{ type: "text" as const, text: JSON.stringify(agents) }] };
    },
  );

  server.tool(
    "search_mentions",
    "Search for mentionable items (agents, teams, extensions, files, commands) by query. Use this to resolve mention tokens before composing a message.",
    {
      q: z.string().describe("Search query"),
      type: mentionSearchInput.shape.type.optional().describe("Mention kind filter: agent | team | ext | path | cmd"),
      projectId: z.union([z.literal("global"), z.string().uuid()]).optional().describe("Scope search to a specific project"),
    },
    async (args) => {
      const hits = await client.searchMentions(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(hits) }] };
    },
  );

  server.tool(
    "list_models",
    "List all LLM models available in this EZCorp instance. Use this to validate model identifiers before starting a chat.",
    {},
    async () => {
      const models = await client.listModels();
      return { content: [{ type: "text" as const, text: JSON.stringify(models) }] };
    },
  );

  /**
   * @deprecated Use `extension_search` instead. `list_extensions` returns
   * the raw `/api/extensions` blob (full manifests, including large
   * `inputSchema` objects per tool) which bloats LLM context. The newer
   * `extension_search` tool supports a substring filter and returns a
   * curated `{ name, description }` projection of each extension's tools.
   * Kept registered for backwards compatibility with older agents/clients.
   */
  server.tool(
    "list_extensions",
    "List all installed EZCorp extensions. Use this to discover extension capabilities before referencing them in messages. (DEPRECATED — use extension_search)",
    {},
    async () => {
      const extensions = await client.listExtensions();
      return { content: [{ type: "text" as const, text: JSON.stringify(extensions) }] };
    },
  );

  server.tool(
    "extension_search",
    "Search installed EZCorp extensions by name/description substring (case-insensitive). Returns matching extensions with a curated `tools` list (`{ name, description }` only) per extension. Omit `query` to list everything. Prefer this over `list_extensions`.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Substring to match against extension name and description (case-insensitive). Omit to return all extensions.",
        ),
    },
    async ({ query }) => {
      const hits = await client.searchExtensions(query);
      return { content: [{ type: "text" as const, text: JSON.stringify(hits) }] };
    },
  );
}
