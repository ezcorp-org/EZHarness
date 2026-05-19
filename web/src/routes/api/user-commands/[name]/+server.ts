import { json } from "@sveltejs/kit";
import {
  getUserCommand,
  updateUserCommand,
  deleteUserCommand,
} from "$server/db/queries/user-commands";
import type { UserCommand } from "$server/db/schema";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { validationError } from "$lib/server/security/validation";
import { errorJson } from "$lib/server/http-errors";
import { getCommandRegistry } from "$lib/server/context";
import { COMMAND_BODY_MAX_BYTES } from "$server/runtime/commands/discovery";
import { updateUserCommandSchema, filterFrontmatter } from "../schema";
import type { RequestHandler } from "./$types";

/**
 * /api/user-commands/[name] — GET / PATCH / DELETE for a single
 * user-owned slash command. PATCH is partial (body / description /
 * frontmatter); rename is deferred to v1.5 (the UI hides the input
 * and the server doesn't accept a new name here). Successful PATCH
 * and DELETE both call invalidateUser so every popover cache entry
 * for this user (any projectId) is dropped — see the collection-route
 * comment for the rationale.
 */

// Match the collection route — strip the redundant `userId` from
// JSON responses at the boundary.
function toResponseShape(row: UserCommand): Omit<UserCommand, "userId"> {
  const { userId: _userId, ...rest } = row;
  return rest;
}

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const row = await getUserCommand(user.id, params.name);
  if (!row) return errorJson(404, "Not found");
  return json(toResponseShape(row));
};

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const raw = await request.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return errorJson(400, "Invalid request body");
  }
  const parsed = updateUserCommandSchema.safeParse(raw);
  if (!parsed.success) {
    return validationError(parsed.error);
  }
  const data = parsed.data;

  if (data.body !== undefined) {
    const byteLength = new TextEncoder().encode(data.body).length;
    if (byteLength > COMMAND_BODY_MAX_BYTES) {
      return errorJson(413, "Command body exceeds 64 KB limit", {
        maxBytes: COMMAND_BODY_MAX_BYTES,
        actualBytes: byteLength,
      });
    }
  }

  const updated = await updateUserCommand(user.id, params.name, {
    description: data.description,
    body: data.body,
    frontmatter:
      data.frontmatter !== undefined
        ? filterFrontmatter(data.frontmatter)
        : undefined,
  });
  if (!updated) return errorJson(404, "Not found");

  getCommandRegistry().invalidateUser(user.id);

  return json(toResponseShape(updated));
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const ok = await deleteUserCommand(user.id, params.name);
  if (!ok) return errorJson(404, "Not found");

  getCommandRegistry().invalidateUser(user.id);

  return new Response(null, { status: 204 });
};
