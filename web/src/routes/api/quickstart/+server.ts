import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getDb } from "$server/db/connection";
import { settings, conversations, extensions, agentConfigs } from "$server/db/schema";
import { eq, ne, like, or, sql } from "drizzle-orm";

export const GET: RequestHandler = async ({ locals }) => {
  try {
    const scopeErr = requireScope(locals, "read");
    if (scopeErr) return scopeErr;
    const user = requireAuth(locals);
    const db = getDb();

    const [providerRow, chatRow, extensionRow, agentRow] = await Promise.all([
      db
        .select({ v: sql`1` })
        .from(settings)
        .where(or(like(settings.key, "provider:%:apiKey"), like(settings.key, "provider:oauth:%")))
        .limit(1),
      db
        .select({ v: sql`1` })
        .from(conversations)
        .where(
          sql`${conversations.userId} = ${user.id} AND ${conversations.parentConversationId} IS NULL`,
        )
        .limit(1),
      db
        .select({ v: sql`1` })
        .from(extensions)
        .where(ne(extensions.name, "builtin-tools"))
        .limit(1),
      db
        .select({ v: sql`1` })
        .from(agentConfigs)
        .where(eq(agentConfigs.userId, user.id))
        .limit(1),
    ]);

    return json({
      steps: {
        provider: providerRow.length > 0,
        chat: chatRow.length > 0,
        extension: extensionRow.length > 0,
        agent: agentRow.length > 0,
      },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
