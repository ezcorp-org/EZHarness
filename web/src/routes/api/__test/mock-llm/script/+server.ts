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

const USAGE_FIELDS = ["input", "cacheRead", "cacheWrite", "output"] as const;

/** Validate an optional synthetic-usage block. Returns an error string or null. */
function validateUsage(raw: unknown, i: number): string | null {
  if (typeof raw !== "object" || raw === null) return `turns[${i}].usage must be an object`;
  const usage = raw as Record<string, unknown>;
  for (const field of USAGE_FIELDS) {
    const v = usage[field];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      return `turns[${i}].usage.${field} must be a non-negative number`;
    }
  }
  return null;
}

/** Validate an optional fault block. Returns an error string or null. */
function validateFault(raw: unknown, i: number): string | null {
  if (typeof raw !== "object" || raw === null) return `turns[${i}].fault must be an object`;
  const fault = raw as Record<string, unknown>;
  const hasKind = fault.kind !== undefined;
  const hasStatus = fault.status !== undefined;
  if (!hasKind && !hasStatus) return `turns[${i}].fault must set status or kind`;
  if (hasKind && fault.kind !== "connection") return `turns[${i}].fault.kind must be "connection"`;
  if (hasStatus && (typeof fault.status !== "number" || !Number.isInteger(fault.status) ||
      fault.status < 400 || fault.status > 599)) {
    return `turns[${i}].fault.status must be an integer in [400,599]`;
  }
  if (fault.message !== undefined && typeof fault.message !== "string") {
    return `turns[${i}].fault.message must be a string`;
  }
  return null;
}

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
    if (turn.usage !== undefined) {
      const err = validateUsage(turn.usage, i);
      if (err) return { error: err };
    }
    if (turn.fault !== undefined) {
      const err = validateFault(turn.fault, i);
      if (err) return { error: err };
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
