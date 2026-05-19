import { json } from "@sveltejs/kit";
import { complete, type Context, type Message } from "@mariozechner/pi-ai";
import { resolveModel } from "$server/providers/router";
import { resolveOAuthModel } from "$server/providers/registry";
import { getCredential } from "$server/providers/credentials";
import { getMode } from "$server/db/queries/modes";
import { requireAuth } from "$server/auth/middleware";
import { generateAgentConfigSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

const META_AGENT_SYSTEM_PROMPT = `You are an agent creation assistant. Your job is to help users design an agent persona through conversation.

Ask clarifying questions one at a time to understand:
1. What the agent should be named
2. What domain or tasks it handles
3. Its personality and communication style
4. Which LLM provider/model (if the user has a preference)
5. Any specific constraints or things it should avoid

When you have enough information, confirm your understanding by summarizing what you will create. Wait for the user to confirm before generating.

When generating, output ONLY a JSON object wrapped in <agent_config>...</agent_config> tags. No text outside the tags.

The JSON must have this exact shape:
{
  "name": "kebab-case-name",
  "description": "one sentence description",
  "prompt": "full system prompt using # Identity / # Personality & Tone / # Domain Expertise / # Constraints sections",
  "provider": "anthropic" | "google" | "openai" | null,
  "model": null,
  "temperature": null,
  "maxTokens": null,
  "category": "category label" | null
}`;

function extractAgentConfig(text: string): Record<string, unknown> | null {
  const match = text.match(/<agent_config>([\s\S]*?)<\/agent_config>/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[1]!);
    if (typeof raw.name !== "string" || !raw.name.trim()) return null;
    if (typeof raw.prompt !== "string" || !raw.prompt.trim()) return null;
    return raw;
  } catch {
    return null;
  }
}

function applyModeInstruction(
  base: string,
  instruction: string,
  position: "prepend" | "append" | "replace",
): string {
  if (position === "replace") return instruction;
  if (position === "prepend") return `${instruction}\n\n${base}`;
  return `${base}\n\n${instruction}`;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const result = generateAgentConfigSchema.safeParse(await request.json());
  if (!result.success) {
    return validationError(result.error);
  }
  const body = result.data;

  try {
    const resolved = await resolveModel(body.provider, body.model);
    const cred = await getCredential(resolved.provider);

    // When the user has an OAuth/subscription credential (not an API key),
    // the standard provider endpoints (openai-responses, google-generative-ai)
    // reject the OAuth token. Remap to the OAuth-compatible Model variant
    // (e.g. openai-codex-responses for ChatGPT subscriptions). Mirrors the
    // logic in runtime/executor.ts so meta-agent chat behaves like regular chat.
    let piModel = resolved.piModel;
    if (cred.type === "oauth") {
      const oauthModel = resolveOAuthModel(resolved.provider, piModel.id);
      if (oauthModel) {
        piModel = { ...oauthModel, provider: resolved.provider as typeof piModel.provider };
      } else if (resolved.provider === "google" || resolved.provider === "openai") {
        throw new Error(
          `Model "${piModel.id}" is not supported with ${resolved.provider} OAuth. ` +
          `Only subscription-eligible models are available with OAuth authentication.`,
        );
      }
    }

    let systemPrompt = META_AGENT_SYSTEM_PROMPT;
    if (body.modeId) {
      const mode = await getMode(body.modeId);
      if (mode?.systemPromptInstruction) {
        systemPrompt = applyModeInstruction(
          systemPrompt,
          mode.systemPromptInstruction,
          mode.instructionPosition,
        );
      }
    }

    const context: Context = {
      systemPrompt,
      messages: body.messages.map((m): Message =>
        m.role === "assistant"
          ? { role: "assistant" as const, content: [{ type: "text" as const, text: m.content }], api: "openai-completions" as any, provider: "unknown", model: "unknown", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: Date.now() }
          : { role: "user" as const, content: m.content, timestamp: Date.now() }
      ),
    };
    const reasoning =
      piModel.reasoning && body.thinkingLevel && body.thinkingLevel !== "off"
        ? body.thinkingLevel
        : undefined;
    const providerApi = piModel.api;
    const reasoningOptions: Record<string, unknown> = reasoning
      ? providerApi === "anthropic-messages"
        ? { thinking: { type: "enabled", budget_tokens: 8192 } }
        : providerApi === "google-generative-ai" || providerApi === "google-vertex"
          ? { thinkingBudget: 8192 }
          : { reasoningEffort: reasoning }
      : {};
    const result = await complete(piModel, context, {
      apiKey: cred.token,
      ...reasoningOptions,
    });
    if (result.stopReason === "error") {
      throw new Error((result as { errorMessage?: string }).errorMessage ?? "LLM call failed");
    }
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");

    const config = extractAgentConfig(text);
    return json({ text, config });
  } catch (err) {
    const message = err instanceof Error ? err.message : "LLM call failed";
    return errorJson(500, message);
  }
};
