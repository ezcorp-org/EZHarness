import type { AgentConfig, AgentDefinition } from "../types";

// ── Composition ─────────────────────────────────────────────────────

export interface CompositionContext {
  depth: number;
  maxDepth: number;
  parentAgentId?: string;
  timeout: number;
}

export interface ComposeResult {
  agent?: AgentDefinition;
  error?: string;
  timeout?: number;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_TIMEOUT = 30_000;

export function composeAgent(
  config: Pick<AgentConfig, "name" | "description" | "capabilities" | "prompt">,
  ctx?: CompositionContext,
): ComposeResult {
  const depth = ctx?.depth ?? 0;
  const maxDepth = ctx?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const timeout = ctx?.timeout ?? DEFAULT_TIMEOUT;

  if (depth >= maxDepth) {
    return { error: `Max composition depth reached (${maxDepth}). Cannot invoke ${config.name}.` };
  }

  const agent: AgentDefinition = {
    name: config.name,
    description: config.description,
    capabilities: config.capabilities,
    async execute(agentCtx) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const inputLines = Object.entries(agentCtx.input)
          .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join("\n");

        const response = await agentCtx.llm.complete(
          [{ role: "user", content: inputLines || "(no input)" }],
          { system: config.prompt },
        );

        return { success: true, output: response.text };
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          return { success: false, output: null, error: `Agent ${config.name} timed out after ${timeout}ms` };
        }
        return { success: false, output: null, error: String(err) };
      } finally {
        clearTimeout(timer);
      }
    },
  };

  return { agent, timeout };
}

// ── Original configToAgent ──────────────────────────────────────────

export function configToAgent(config: AgentConfig): AgentDefinition {
  return {
    name: config.name,
    description: config.description,
    capabilities: config.capabilities,
    inputSchema: config.inputSchema,

    async execute(ctx) {
      const inputLines = Object.entries(ctx.input)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("\n");

      const response = await ctx.llm.complete(
        [{ role: "user", content: inputLines || "(no input)" }],
        {
          system: config.prompt,
          provider: config.provider,
          model: config.model,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
        },
      );

      let output: unknown = response.text;

      if (config.outputFormat === "json") {
        try {
          output = JSON.parse(response.text);
        } catch {
          return { success: false, output: null, error: "Failed to parse LLM response as JSON" };
        }
      }

      return { success: true, output };
    },
  };
}
