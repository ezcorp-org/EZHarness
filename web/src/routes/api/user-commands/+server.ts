import { json } from "@sveltejs/kit";
import {
  listUserCommands,
  createUserCommand,
} from "$server/db/queries/user-commands";
import type { UserCommand } from "$server/db/schema";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { validationError } from "$lib/server/security/validation";
import { errorJson } from "$lib/server/http-errors";
import { getCommandRegistry } from "$lib/server/context";
import { COMMAND_BODY_MAX_BYTES } from "$server/runtime/commands/discovery";
import { createUserCommandSchema, filterFrontmatter } from "./schema";
import type { RequestHandler } from "./$types";

/**
 * /api/user-commands — list + create for the per-user DB-backed slash
 * commands source. Mirrors /api/agent-configs's shape (auth gate via
 * requireAuth, scope gate via requireScope, zod validation, json()
 * response). Every successful mutation drops every cached entry for
 * this user across all projectIds so the popover (which keys cache by
 * the active chat's projectId, not "global") reflects the change in
 * any chat session.
 */

// Strip `userId` from JSON responses — it's redundant on a per-user
// endpoint (the client is already authenticated as that user) and
// callers shouldn't be reading owner IDs they can't act on. Keeping it
// in the DB row but projecting it out at the boundary.
function toResponseShape(row: UserCommand): Omit<UserCommand, "userId"> {
  const { userId: _userId, ...rest } = row;
  return rest;
}

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const rows = await listUserCommands(user.id);
  return json(rows.map(toResponseShape));
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const raw = await request.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return errorJson(400, "Invalid request body");
  }
  const parsed = createUserCommandSchema.safeParse(raw);
  if (!parsed.success) {
    return validationError(parsed.error);
  }
  const data = parsed.data;

  // Byte-cap check uses TextEncoder so multi-byte characters are
  // counted correctly (a 64-KB string with emoji is still over the
  // cap). Matches the filesystem scanner's `COMMAND_BODY_MAX_BYTES`
  // import — single source of truth, no redefinition.
  const byteLength = new TextEncoder().encode(data.body).length;
  if (byteLength > COMMAND_BODY_MAX_BYTES) {
    return errorJson(413, "Command body exceeds 64 KB limit", {
      maxBytes: COMMAND_BODY_MAX_BYTES,
      actualBytes: byteLength,
    });
  }

  const created = await createUserCommand({
    userId: user.id,
    name: data.name,
    description: data.description ?? "",
    body: data.body,
    frontmatter: filterFrontmatter(data.frontmatter),
  });

  // Invalidate every cache entry for this user (any projectId). The
  // popover keys its cache by the active chat's projectId — see
  // web/src/routes/api/mentions/search/+server.ts — so a project-
  // scoped invalidate({...projectId:"global"}) would miss in-project
  // popover entries and leave them stale for up to 2s.
  getCommandRegistry().invalidateUser(user.id);

  return json(toResponseShape(created), { status: 201 });
};
