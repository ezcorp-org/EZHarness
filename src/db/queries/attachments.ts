import { eq } from "drizzle-orm";
import { getDb } from "../connection";
import { messageAttachments } from "../schema";
import type { MessageAttachment, NewMessageAttachment } from "../schema";

export async function insertAttachment(data: NewMessageAttachment): Promise<MessageAttachment> {
  const db = getDb();
  const rows = await db.insert(messageAttachments).values(data).returning();
  return rows[0]!;
}

export async function listAttachmentsForMessage(messageId: string): Promise<MessageAttachment[]> {
  const db = getDb();
  return db.select().from(messageAttachments).where(eq(messageAttachments.messageId, messageId));
}

export async function listAttachmentsForConversation(conversationId: string): Promise<MessageAttachment[]> {
  const db = getDb();
  return db.select().from(messageAttachments).where(eq(messageAttachments.conversationId, conversationId));
}

export async function deleteAttachmentsForMessage(messageId: string): Promise<MessageAttachment[]> {
  const db = getDb();
  return db.delete(messageAttachments).where(eq(messageAttachments.messageId, messageId)).returning();
}

export async function deleteAttachmentsForConversation(conversationId: string): Promise<MessageAttachment[]> {
  const db = getDb();
  return db.delete(messageAttachments).where(eq(messageAttachments.conversationId, conversationId)).returning();
}
