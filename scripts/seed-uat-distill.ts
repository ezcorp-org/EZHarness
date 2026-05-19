#!/usr/bin/env bun
/**
 * Phase 53.1 UAT seed — drops a conversation with realistic messages
 * so `!EZ:distill` has something to chew on for the no-credentials
 * error-card test.
 *
 * Usage:
 *   EZCORP_DB_PATH=<path> bun run scripts/seed-uat-distill.ts
 *
 * Outputs the conversationId on stdout. Idempotent: reuses or creates
 * a conversation tagged `uat:phase53-distill`.
 */
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { getDb, initDb } from "../src/db/connection";
import {
  conversations,
  messages,
  projects,
  users,
} from "../src/db/schema";
import { randomUUID } from "node:crypto";

async function main() {
  await initDb();
  const db = getDb();

  const userRows = await db.select().from(users).where(eq(users.email, "uat@phase53.local")).limit(1);
  if (!userRows[0]) throw new Error("No UAT user — run /setup first with uat@phase53.local");
  const userId = userRows[0].id;

  const projectRows = await db.select().from(projects).limit(1);
  let projectRow = projectRows[0];
  if (!projectRow) {
    const id = randomUUID();
    [projectRow] = await db.insert(projects).values({
      id,
      name: "Global",
      path: process.cwd(),
    }).returning();
  }
  const projectId = projectRow.id;

  const tag = "uat:phase53-distill";
  let convRow = (await db.select().from(conversations).where(sql`metadata->>'tag' = ${tag}`)).at(0);
  if (!convRow) {
    const id = randomUUID();
    [convRow] = await db.insert(conversations).values({
      id,
      projectId,
      userId,
      title: "Phase 53 UAT distill seed",
      metadata: { tag },
    }).returning();
  }
  const conversationId = convRow.id;

  // Wipe + re-seed messages so the script is idempotent.
  await db.delete(messages).where(eq(messages.conversationId, conversationId));
  const seedMsgs = [
    { role: "user" as const, content: "How do I configure a model provider for the lessons distiller?" },
    { role: "assistant" as const, content: "Open Settings → Extensions → lessons-distiller and pick a provider with an API key configured. The default is Google but you can switch to OpenAI or Anthropic if those are configured instead." },
    { role: "user" as const, content: "I switched to OpenAI but it still tries Google. Why?" },
    { role: "assistant" as const, content: "The provider setting is per-user; verify under your user account. After saving, the next `!EZ:distill` invocation should pick up the new provider." },
    { role: "user" as const, content: "Got it, that worked. Can you save this as a lesson?" },
  ];
  for (const m of seedMsgs) {
    await db.insert(messages).values({
      id: randomUUID(),
      conversationId,
      role: m.role,
      content: m.content,
      metadata: { seedTag: tag },
    });
  }

  console.log(JSON.stringify({ userId, projectId, conversationId, projectName: projectRow.name }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
