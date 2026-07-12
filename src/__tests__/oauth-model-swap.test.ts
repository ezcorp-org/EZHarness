/**
 * resolveModelForCredential — the shared OAuth model swap.
 *
 * With an OAuth credential, the standard API-key endpoints
 * (openai-responses / google-generative-ai) reject the token — a
 * ChatGPT-plan token 401s api.openai.com with "Missing scopes:
 * api.responses.write" — so the model must be exchanged for its
 * subscription-eligible sibling (openai-codex / google-gemini-cli
 * backend), keeping the ORIGINAL provider name for credential lookups.
 *
 * The helper is shared by build-pi-agent (chat runs) and providers/llm.ts
 * (streamLLM/completeLLM — summarize_conversation etc.); these tests pin
 * its branch contract directly against the real pi-ai catalog + the
 * registry's LOCAL_OAUTH_OVERRIDES.
 */
import { test, expect, describe } from "bun:test";
import { resolveModelForCredential } from "../providers/registry";

const openaiStandard = { provider: "openai", id: "gpt-5.5", api: "openai-responses" } as any;

describe("resolveModelForCredential", () => {
  test("apikey credential: model passes through by reference", () => {
    expect(resolveModelForCredential(openaiStandard, "openai", "apikey")).toBe(openaiStandard);
  });

  test("oauth + openai subscription-eligible model: swapped to the codex backend, provider name kept", () => {
    const swapped = resolveModelForCredential(openaiStandard, "openai", "oauth");
    expect(swapped).not.toBe(openaiStandard);
    expect(swapped.api).toBe("openai-codex-responses");
    expect(swapped.baseUrl).toContain("chatgpt.com");
    // Credential lookups must keep resolving against "openai", not
    // "openai-codex".
    expect(swapped.provider).toBe("openai");
    expect(swapped.id).toBe("gpt-5.5");
  });

  test("oauth + openai model with NO subscription sibling: throws the named constraint", () => {
    const unknown = { provider: "openai", id: "definitely-not-a-model" } as any;
    expect(() => resolveModelForCredential(unknown, "openai", "oauth")).toThrow(
      /not supported with openai OAuth/,
    );
  });

  test("oauth + google model with NO subscription sibling: throws the named constraint", () => {
    const unknown = { provider: "google", id: "definitely-not-a-model" } as any;
    expect(() => resolveModelForCredential(unknown, "google", "oauth")).toThrow(
      /not supported with google OAuth/,
    );
  });

  test("oauth + provider without an OAuth variant: model passes through (anthropic)", () => {
    const anthropic = { provider: "anthropic", id: "claude-sonnet-4" } as any;
    expect(resolveModelForCredential(anthropic, "anthropic", "oauth")).toBe(anthropic);
  });
});
