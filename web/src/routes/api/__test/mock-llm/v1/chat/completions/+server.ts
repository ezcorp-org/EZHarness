/**
 * TEST-ONLY deterministic mock LLM — OpenAI chat-completions wire protocol.
 *
 * Gated by `isTestSurfaceEnabled()` (404 otherwise). This endpoint is NOT
 * called by external clients: pi-ai's HTTP client targets it over loopback
 * from inside this same process when a conversation selects
 * `provider:"ezcorp-mock"`. `hooks.server.ts` lets the loopback call through
 * its auth gate (see `isLoopbackTestBypass`), so this handler does NOT
 * require a session/key — the loopback + flag gates are the security
 * boundary.
 *
 * It replays the next scripted turn for the key encoded in `model`
 * (`mock:<key>`) as a streaming OpenAI response. See `$lib/server/mock-llm`.
 */
import { errorJson } from "$lib/server/http-errors";
import { isTestSurfaceEnabled } from "$lib/server/test-surface";
import {
  buildMockStreamResponse,
  dequeueMockTurn,
  mockScriptKeyFromModel,
} from "$lib/server/mock-llm";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");

  let body: { model?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorJson(400, "Invalid JSON body");
  }

  const key = mockScriptKeyFromModel(body.model);
  const turn = dequeueMockTurn(key);
  // Always stream — pi-agent-core only ever uses the streaming path.
  return buildMockStreamResponse(turn);
};
