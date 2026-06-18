/**
 * TEST-ONLY mock-LLM script seeding. Gated by `isTestSurfaceEnabled()`
 * (404 otherwise). Unlike the completions endpoint, this is called by the
 * EXTERNAL harness, so it goes through normal auth — a `chat`-scoped API
 * key (or cookie session). The harness seeds an ordered list of turns under
 * a key, then drives a conversation with `model:"mock:<key>"`.
 *
 * POST   { scriptKey, turns: MockTurn[] }  → replace the script for a key
 * DELETE                                   → clear all scripts
 */
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { isTestSurfaceEnabled } from "$lib/server/test-surface";
import { setMockScript, clearMockScripts, type MockTurn } from "$lib/server/mock-llm";
import type { RequestHandler } from "./$types";

function parseTurns(raw: unknown): MockTurn[] | { error: string } {
  if (!Array.isArray(raw)) return { error: "`turns` must be an array" };
  const turns: MockTurn[] = [];
  for (const [i, t] of raw.entries()) {
    if (!t || typeof t !== "object") return { error: `turns[${i}] must be an object` };
    const turn = t as Record<string, unknown>;
    if (turn.text !== undefined && typeof turn.text !== "string") {
      return { error: `turns[${i}].text must be a string` };
    }
    if (turn.finishReason !== undefined &&
        !["stop", "tool_calls", "length"].includes(turn.finishReason as string)) {
      return { error: `turns[${i}].finishReason must be stop|tool_calls|length` };
    }
    if (turn.toolCalls !== undefined) {
      if (!Array.isArray(turn.toolCalls)) return { error: `turns[${i}].toolCalls must be an array` };
      for (const [j, tc] of turn.toolCalls.entries()) {
        if (!tc || typeof tc !== "object" || typeof (tc as { name?: unknown }).name !== "string") {
          return { error: `turns[${i}].toolCalls[${j}] must have a string name` };
        }
      }
    }
    turns.push(turn as MockTurn);
  }
  return turns;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  let body: { scriptKey?: unknown; turns?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorJson(400, "Invalid JSON body");
  }
  if (typeof body.scriptKey !== "string" || body.scriptKey.length === 0) {
    return errorJson(400, "`scriptKey` must be a non-empty string");
  }
  const parsed = parseTurns(body.turns);
  if (!Array.isArray(parsed)) return errorJson(400, parsed.error);

  setMockScript(body.scriptKey, parsed);
  return json({ ok: true, scriptKey: body.scriptKey, turns: parsed.length }, { status: 201 });
};

export const DELETE: RequestHandler = async ({ locals }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  clearMockScripts();
  return json({ ok: true });
};
