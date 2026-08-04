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

// ── json-mode failure diagnostics ───────────────────────────────────

/** How much of the model's response is quoted back in the error. Enough
 *  to see the shape of the answer, small enough that a runaway 50k-token
 *  reply can't turn one failed step into a log bomb. */
const RESPONSE_SNIPPET_LIMIT = 300;
/** The engine's own `JSON.parse` message can EMBED the offending input
 *  (JSC quotes the unexpected token), so it needs its own bound — not
 *  just the snippet. */
const PARSE_ERROR_LIMIT = 200;

function clip(s: string, limit: number): string {
  return s.length <= limit ? s : `${s.slice(0, limit)}… (truncated)`;
}

/**
 * Turn a `JSON.parse` throw into an error a human can act on.
 *
 * By the time this runs the tokens are already spent, so the response text
 * is the ONLY evidence anyone will ever get about why the step failed. The
 * previous bare `catch` discarded it and returned one fixed sentence, which
 * made four different bugs look identical:
 *
 *   - **empty** — the provider returned nothing (dead key, filtered
 *     completion, zero-length stream). Fix: the provider/route.
 *   - **fenced code block** — the model emitted correct JSON wrapped in
 *     markdown. Fix: the prompt. This is the single most common shape a
 *     small model returns, and it is *deliberately* still a failure — see
 *     the fenced-reply invariant in `config-to-agent.test.ts`; a workflow
 *     gate reading `$steps.<x>.output.valid` must not start passing
 *     because the parser got more permissive.
 *   - **malformed JSON** — the model tried and got the syntax wrong. Fix:
 *     a stricter prompt, a bigger model, or retries.
 *   - **prose** — the model answered in English, i.e. it never understood
 *     it was under an output-format contract. Fix: the prompt or the
 *     `outputFormat` wiring.
 *
 * The VERDICT is unchanged in every case: json mode still fails closed.
 * Only the legibility of that failure changes.
 */
function describeJsonParseFailure(text: string, cause: unknown): string {
  const trimmed = text.trim();
  let shape: string;
  if (trimmed.length === 0) shape = "an empty response";
  else if (trimmed.startsWith("```")) shape = "a fenced code block";
  else if (/^[[{"]/.test(trimmed)) shape = "malformed JSON";
  else shape = "prose";

  const detail = clip(cause instanceof Error ? cause.message : String(cause), PARSE_ERROR_LIMIT);
  const head =
    `Failed to parse LLM response as JSON — the model returned ${shape} ` +
    `(${text.length} chars): ${detail}`;
  // An empty response has no evidence worth quoting, and an empty pair of
  // quotes reads like a truncation bug. The char count already said it.
  if (trimmed.length === 0) return head;
  return `${head}. Response was: ${clip(text, RESPONSE_SNIPPET_LIMIT)}`;
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
        } catch (err) {
          return {
            success: false,
            output: null,
            error: describeJsonParseFailure(response.text, err),
          };
        }
      }

      return { success: true, output };
    },
  };
}
