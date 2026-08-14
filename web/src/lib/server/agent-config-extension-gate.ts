/**
 * Write-time authorization for an agent config's `extensions[]` (sec: F3).
 *
 * Shared by `POST /api/agent-configs` and `PUT /api/agent-configs/[id]`,
 * which are both scope `chat` + `requireAuth` — i.e. reachable by any
 * authenticated member.
 *
 * ## Why this exists
 *
 * `agent_configs.extensions` holds RAW extension ids, and
 * `registry.getToolsForAgent` attaches the named extensions' tools to a chat
 * turn. So an id here is a request to hand that extension's tools to an LLM.
 * Before the wire gate reached this path, a member could list extensions
 * (`GET /api/extensions` is read+auth), create an agent config naming an
 * admin-installed MCP extension's id, open a conversation with it, and send a
 * message — and the MCP tools were in the turn's tool set.
 *
 * ## This is the FAIL-FAST half only
 *
 * The half that actually protects the credential is the runtime hook in
 * `src/runtime/stream-chat/setup-tools.ts` (the `allowExtension` predicate on
 * `getToolsForAgent`), because it re-decides on EVERY turn: a config that was
 * legal when written but whose grant was since revoked, or whose extension
 * was replaced by an MCP row, stops contributing tools immediately. Write-time
 * validation cannot give that guarantee — it is a snapshot — and exists so the
 * author gets a clear 400 instead of an agent that silently has fewer tools
 * than its config lists.
 */
import { json } from "@sveltejs/kit";
import { findUnauthorizedExtensionIds } from "$server/auth/extension-wire-authz";

/** The principal shape both routes already hold from `requireAuth`. */
type Actor = { id: string; role: "admin" | "member" };

/**
 * Read an `extensions` field off a validated-but-loose body. The PUT route's
 * schema is `.passthrough()`, so the field arrives as `unknown` and a
 * malformed value must not throw here — a non-array, or an array with a
 * non-string, is simply not a list of ids to check. The zod schema on the
 * POST route already rejects those shapes; this keeps the PUT route honest
 * without duplicating the schema.
 */
export function readExtensionIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((v): v is string => typeof v === "string");
  return ids.length > 0 ? ids : undefined;
}

/**
 * Returns a 400 Response naming the ids the actor may not attach, or `null`
 * when every id is allowed (including the empty/absent case).
 *
 * The project coordinate is `null` — the "all projects" coordinate. An agent
 * config is not project-scoped, so only a NULL-project grant can cover it.
 * That is deliberately NARROWER than the runtime check (which knows the
 * conversation's project); never wider, so write time can refuse something
 * run time would have allowed, but never the reverse.
 */
export async function rejectUnauthorizedExtensions(
  extensions: unknown,
  user: Actor,
): Promise<Response | null> {
  const ids = readExtensionIds(extensions);
  if (!ids) return null;
  const denied = await findUnauthorizedExtensionIds(ids, {
    user: { id: user.id, role: user.role },
    projectId: null,
  });
  if (denied.length === 0) return null;
  // A denied id and a nonexistent id read the same, matching the wire
  // route's vocabulary. This hides nothing `GET /api/extensions` does not
  // already expose — it keeps ONE phrase for "you cannot attach this".
  return json(
    { error: "Unknown or unavailable extension(s)", unknown: denied },
    { status: 400 },
  );
}
