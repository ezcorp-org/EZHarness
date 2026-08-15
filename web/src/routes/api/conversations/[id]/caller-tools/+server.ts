/**
 * Caller-executed tool declarations — `PUT`/`GET`/`DELETE`
 * `/api/conversations/[id]/caller-tools`.
 *
 * An external application holding a member-role API key declares tool
 * definitions on a conversation here. The runtime wires them into the next
 * turn as `_caller__<name>`; when the LLM calls one the run pauses behind a
 * permission gate, the call goes out over SSE as `caller:tool-call`, the app
 * executes it on its own machine and POSTs the result back to
 * `…/tool-results`.
 *
 * ── WHY THE DECLARATIONS LIVE IN `conversations.metadata` ────────────────
 *
 * They are per-conversation, caller-authored, and short-lived — a shape a
 * table would model badly and a migration would freeze. `metadata` is a
 * shared jsonb bag with several independent owners (`goal`, `spawnDepth`,
 * `spawnParentAuditId`), so every write here goes through
 * `mergeConversationMetadata` / `deleteCallerToolsMetadata`
 * (`src/db/queries/conversation-metadata.ts`), which merge inside ONE
 * statement. NEVER read-modify-write this column: `writePersistedGoal` ticks
 * on every goal-evaluator cycle, and a JS-side RMW racing it silently
 * destroys whichever side commits first.
 *
 * ── THE GATE CHAIN, AND WHY IT IS IN THAT ORDER ──────────────────────────
 *
 *   requireScope → requireAuth → ownership (404) → root-only (400)
 *     → rate limit (429) → body cap (413) → shape (400) → semantics (400)
 *
 * Ownership resolves BEFORE the root-only check so a sub-conversation
 * belonging to somebody else reports 404 (nothing leaked) rather than the
 * 400 that would confirm the id names a real sub-conversation. The rate
 * limit sits AFTER ownership for the same reason — a limiter that answers
 * before the ownership check turns into a conversation-existence oracle
 * clocked by response timing.
 *
 * ── ROOT-ONLY IS A SEMANTIC RULE, NOT A CONVENIENCE ──────────────────────
 *
 * A sub-conversation (agent run, team member) carries `userId = null` and
 * inherits nothing from its parent's declarations — the runtime wires caller
 * tools from the conversation it is running, full stop. Accepting a
 * declaration on a sub-conversation would therefore look like it worked and
 * do nothing, so it is a 400 with a message that says which id to use.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import { createRateLimiter } from "$server/extensions/rate-limit";
import {
  deleteCallerToolsMetadata,
  mergeConversationMetadata,
} from "$server/db/queries/conversation-metadata";
import {
  readCallerToolsFromMetadata,
  validateCallerToolDeclarations,
} from "$server/runtime/caller-tool-declarations";
import { mayDeclareCallerTools } from "$server/auth/tool-policy";
import { getActiveRun } from "$server/db/queries/active-runs";
import { declareCallerToolsSchema } from "./schema";

/**
 * Declaration bodies are small by construction (16 tools × an 8 KiB schema
 * ceiling), so 64 KiB is generous. The cap exists so a hostile body is
 * refused before `JSON.parse` allocates it, not to tune anything.
 */
const MAX_DECLARE_BODY_BYTES = 64 * 1024;

/**
 * One declaration write per second per USER (not per key): the identity that
 * matters is whose conversation is being rewritten, and a user with three
 * keys must not get three times the budget. Declaring is a setup step an app
 * performs once per conversation — a caller that needs more than 1/s is
 * looping on a bug.
 */
const declareLimiter = createRateLimiter(1);

/** Both mutating verbs share the budget — they write the same jsonb key. */
function rateLimited(userId: string): Response | null {
  if (declareLimiter(userId, 1)) return null;
  return errorJson(429, "Too many requests", undefined, { "Retry-After": "1" });
}

/**
 * Resolve the conversation and enforce the two authorization facts every
 * verb here needs. `rootOnly` adds the declaration-target rule; the read
 * verb skips it so an app can inspect what a sub-conversation resolved to.
 */
async function resolveTarget(
  id: string,
  locals: App.Locals,
  opts: { rootOnly: boolean },
): Promise<
  | { ok: true; userId: string; metadata: unknown }
  | { ok: false; response: Response }
> {
  const user = requireAuth(locals);
  const owned = await resolveRootConversationForOwnership(id, user);
  if (!owned) return { ok: false, response: errorJson(404, "Not found") };
  if (opts.rootOnly && owned.conv.parentConversationId !== null) {
    return {
      ok: false,
      response: errorJson(
        400,
        "Caller tools are declared on a root conversation, not a sub-conversation",
        { rootConversationId: owned.root.id },
      ),
    };
  }
  return { ok: true, userId: user.id, metadata: owned.conv.metadata };
}

/**
 * Read the body under the cap. Checked on the declared `Content-Length`
 * AND on the actual bytes — a lying header must not buy a bigger
 * allocation than an honest one.
 */
async function readCappedBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DECLARE_BODY_BYTES) {
    return { ok: false, response: errorJson(413, "Payload too large") };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_DECLARE_BODY_BYTES) {
    return { ok: false, response: errorJson(413, "Payload too large") };
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, response: errorJson(400, "Invalid body") };
  }
}

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;

  const target = await resolveTarget(params.id, locals, { rootOnly: true });
  if (!target.ok) return target.response;

  const limited = rateLimited(target.userId);
  if (limited) return limited;

  const body = await readCappedBody(request);
  if (!body.ok) return body.response;

  const parsed = declareCallerToolsSchema.safeParse(body.value);
  if (!parsed.success) {
    return errorJson(400, "Invalid body", { field: parsed.error.issues[0]?.path.join(".") });
  }

  // Semantic validation (reserved names, built-in collisions, JSON-Schema
  // structure, depth / property / byte budgets) is the runtime's, so the
  // wire and the executor agree on what a declaration means.
  const checked = validateCallerToolDeclarations(parsed.data.tools);
  if (!checked.ok) {
    return errorJson(400, checked.error, checked.field ? { field: checked.field } : undefined);
  }

  // Per-API-key declaration cap. Runs AFTER the semantic check so a
  // malformed declaration still reports what is wrong with it rather than
  // which policy field it happens to trip, and it is a 403 (not the 400 above)
  // because the declaration is well-formed — this credential simply may not
  // make it. A cookie session and an unpolicied key take the `ok: true` path
  // unchanged. Boundary 3 caps EXECUTION separately, because the bag on the
  // conversation may have been written by a different principal.
  const declareVerdict = mayDeclareCallerTools(
    locals.apiKeyToolPolicy,
    checked.tools.map((t) => t.name),
  );
  if (!declareVerdict.ok) {
    return errorJson(403, "Tool not permitted for this key", {
      field: declareVerdict.field,
      ...(declareVerdict.offender ? { tool: declareVerdict.offender } : {}),
    });
  }

  await mergeConversationMetadata(params.id, { callerTools: checked.tools });

  // `appliedFrom` is a constant, and deliberately so: tool definitions are
  // bound once when a turn is set up, so a declaration written mid-run
  // cannot reach the run that is already streaming. `activeRunId` names the
  // run it will NOT affect, which is the only thing a caller can act on.
  const active = await getActiveRun(params.id);
  return json({
    tools: checked.tools,
    appliedFrom: "next-turn",
    activeRunId: active?.id ?? null,
  });
};

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;

  const target = await resolveTarget(params.id, locals, { rootOnly: false });
  if (!target.ok) return target.response;

  return json({ tools: readCallerToolsFromMetadata(target.metadata) });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;

  const target = await resolveTarget(params.id, locals, { rootOnly: true });
  if (!target.ok) return target.response;

  const limited = rateLimited(target.userId);
  if (limited) return limited;

  // `cleared` is the count that WAS declared, read off the row the ownership
  // walk already loaded — the delete itself is a jsonb key removal and
  // reports no row count worth returning. Clearing an empty bag is a
  // success with `cleared: 0`, not a 404: DELETE is idempotent.
  const cleared = readCallerToolsFromMetadata(target.metadata).length;
  await deleteCallerToolsMetadata(params.id);
  return json({ ok: true, cleared });
};
