import { eq, ne, like, or, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { settings, conversations, extensions, agentConfigs } from "../schema";

export interface QuickstartSteps {
  provider: boolean;
  chat: boolean;
  extension: boolean;
  agent: boolean;
}

export async function hasAnyProvider(): Promise<boolean> {
  const rows = await getDb()
    .select({ v: sql`1` })
    .from(settings)
    .where(or(like(settings.key, "provider:apiKey:%"), like(settings.key, "provider:oauth:%")))
    .limit(1);
  return rows.length > 0;
}

export async function getQuickstartSteps(userId: string): Promise<QuickstartSteps> {
  const db = getDb();
  const [providerRow, chatRow, extensionRow, agentRow] = await Promise.all([
    db
      .select({ v: sql`1` })
      .from(settings)
      .where(or(like(settings.key, "provider:apiKey:%"), like(settings.key, "provider:oauth:%")))
      .limit(1),
    db
      .select({ v: sql`1` })
      .from(conversations)
      .where(
        sql`${conversations.userId} = ${userId} AND ${conversations.parentConversationId} IS NULL`,
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
      .where(eq(agentConfigs.userId, userId))
      .limit(1),
  ]);
  return {
    provider: providerRow.length > 0,
    chat: chatRow.length > 0,
    extension: extensionRow.length > 0,
    agent: agentRow.length > 0,
  };
}
