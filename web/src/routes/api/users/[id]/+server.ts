import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireRole } from "$server/auth/middleware";
import { updateUserStatus, getUserById } from "$server/db/queries/users";
import { getDb } from "$server/db/connection";
import { agentConfigs } from "$server/db/schema";
import { eq } from "drizzle-orm";
import { insertAuditEntry } from "$server/db/queries/audit-log";
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

      // Transfer ownership of all agents from deactivated user to admin
      await getDb()
        .update(agentConfigs)
        .set({ userId: admin.id, updatedAt: new Date() })
        .where(eq(agentConfigs.userId, params.id));
    }

    if (typedStatus) {
      await updateUserStatus(params.id, typedStatus);
      if (typedStatus === "inactive") {
        await insertAuditEntry(admin.id, "user:deactivated", params.id);
      }
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
