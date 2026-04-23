import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireRole } from "$server/auth/middleware";
import { updateUserStatus, getUserById } from "$server/db/queries/users";
import { getDb } from "$server/db/connection";
import { agentConfigs } from "$server/db/schema";
import { eq } from "drizzle-orm";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";

export const PUT: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    const admin = requireRole(locals, "admin");
    const { status } = (await request.json()) as { status?: "active" | "inactive" };

    if (status && !["active", "inactive"].includes(status)) {
      return errorJson(400, "Status must be 'active' or 'inactive'");
    }

    if (status === "inactive") {
      if (params.id === admin.id) {
        return errorJson(400, "Cannot deactivate yourself");
      }

      // Transfer ownership of all agents from deactivated user to admin
      await getDb()
        .update(agentConfigs)
        .set({ userId: admin.id, updatedAt: new Date() })
        .where(eq(agentConfigs.userId, params.id));
    }

    if (status) {
      await updateUserStatus(params.id, status);
      if (status === "inactive") {
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
