// fallow-ignore-file duplicate-export
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EzcorpClient } from "../../client.js";
import { createAgentInput, generateAgentInput } from "../../types.js";
import { withLink } from "./_response.js";

export const TOOLS = [
  { name: "create_agent", description: "Create a new EZCorp agent config directly from a full specification. Use this when you already have all the agent parameters." },
  { name: "generate_agent", description: "Multi-turn wizard that generates an agent config from a conversation. Use this when you want the server to help craft the agent — keep sending messages until config is non-null." },
  { name: "get_agent", description: "Fetch a single agent config by its UUID. Use this to read an agent's full prompt and settings." },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export function register(server: McpServer, client: EzcorpClient): void {
  server.tool(
    "create_agent",
    "Create a new EZCorp agent config directly from a full specification. Use this when you already have all the agent parameters.",
    {
      name: createAgentInput.shape.name.describe("Human-readable agent name"),
      prompt: createAgentInput.shape.prompt.describe("System prompt for the agent (max 50 000 chars)"),
      description: createAgentInput.shape.description.describe("Short description shown in the UI"),
      capabilities: createAgentInput.shape.capabilities.describe("List of capability tags"),
      category: createAgentInput.shape.category.describe("Category string for grouping"),
      provider: createAgentInput.shape.provider.describe("LLM provider override"),
      model: createAgentInput.shape.model.describe("LLM model override"),
      temperature: createAgentInput.shape.temperature.describe("Sampling temperature"),
      maxTokens: createAgentInput.shape.maxTokens.describe("Max output tokens"),
      outputFormat: createAgentInput.shape.outputFormat.describe("'text' or 'json'"),
      extensions: createAgentInput.shape.extensions.describe("Extension IDs the agent can use"),
      references: createAgentInput.shape.references.describe("Team/member references for orchestration"),
    },
    async (args) => {
      const agent = await client.createAgent(args);
      const url = client.entityUrl({ kind: "agent", name: agent.name });
      return withLink(agent, url, agent.name);
    },
  );

  server.tool(
    "generate_agent",
    "Multi-turn wizard that generates an agent config from a conversation. Use this when you want the server to help craft the agent — keep sending messages until config is non-null.",
    {
      messages: generateAgentInput.shape.messages.describe("Conversation so far; role must be 'user' or 'assistant'"),
      provider: generateAgentInput.shape.provider.describe("LLM provider for generation"),
      model: generateAgentInput.shape.model.describe("LLM model for generation"),
      thinkingLevel: generateAgentInput.shape.thinkingLevel.describe("Reasoning depth"),
      modeId: generateAgentInput.shape.modeId.describe("Mode override"),
    },
    async (args) => {
      const result = await client.generateAgent(args);
      // The wizard may still be gathering requirements — only link once
      // the agent has actually been persisted (id + name present).
      const cfg = (result as { config?: { id?: string; name?: string } }).config;
      if (cfg?.id && cfg?.name) {
        const url = client.entityUrl({ kind: "agent", name: cfg.name });
        return withLink(result, url, cfg.name);
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "get_agent",
    "Fetch a single agent config by its UUID. Use this to read an agent's full prompt and settings.",
    {
      agentId: z.string().uuid().describe("UUID of the agent config to fetch"),
    },
    async (args) => {
      const agents = await client.listAgents();
      const agent = agents.find((a) => a.id === args.agentId);
      if (!agent) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "not_found", agentId: args.agentId }) }],
          isError: true,
        };
      }
      const url = client.entityUrl({ kind: "agent", name: agent.name });
      return withLink(agent, url, agent.name);
    },
  );
}
