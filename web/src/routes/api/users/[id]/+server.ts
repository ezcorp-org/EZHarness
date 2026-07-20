import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireRole } from "$server/auth/middleware";
import { updateUserStatus, getUserById } from "$server/db/queries/users";
import { deactivateUserAndTransferAgents } from "$server/db/queries/user-deactivation";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";

// Boundary validation. Handler reads only `status`; the inline 400
// "Status must be 'active' or 'inactive'" message is test-pinned, so
// `status` stays a permissive string in the schema and the inline
// enum check below fires for invalid values.
const updateUserSchema = z.object({
  status: z.string().optional(),
}).strict();

export const PUT: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    const admin = requireRole(locals, "admin");
    const parsed = updateUserSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return errorJson(400, "Status must be 'active' or 'inactive'");
    }
    const { status } = parsed.data;

    if (status && !["active", "inactive"].includes(status)) {
      return errorJson(400, "Status must be 'active' or 'inactive'");
    }
    const typedStatus = status as "active" | "inactive" | undefined;

    if (typedStatus === "inactive") {
      if (params.id === admin.id) {
        return errorJson(400, "Cannot deactivate yourself");
      }

      // Atomic: agent transfer + status flip commit together (audit row
      // follows). Routes the former raw in-handler table write through the
      // queries layer. See src/db/queries/user-deactivation.ts.
      await deactivateUserAndTransferAgents(params.id, admin.id);
    } else if (typedStatus === "active") {
      await updateUserStatus(params.id, "active");
    }

    const updated = await getUserById(params.id);
    if (!updated) return errorJson(404, "User not found");

    const { passwordHash, ...user } = updated;
    return json({ user });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
