import { eq, inArray } from "drizzle-orm";
import { getDb } from "../connection";
import { messageAttachments } from "../schema";
import type { MessageAttachment, NewMessageAttachment } from "../schema";

export async function insertAttachment(data: NewMessageAttachment): Promise<MessageAttachment> {
  const db = getDb();
  const rows = await db.insert(messageAttachments).values(data).returning();
  return rows[0]!;
}

export async function getAttachment(id: string): Promise<MessageAttachment | null> {
  const db = getDb();
  const rows = await db.select().from(messageAttachments).where(eq(messageAttachments.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listAttachmentsForMessage(messageId: string): Promise<MessageAttachment[]> {
  const db = getDb();
  return db.select().from(messageAttachments).where(eq(messageAttachments.messageId, messageId));
}

export async function listAttachmentsForMessages(messageIds: string[]): Promise<MessageAttachment[]> {
  if (messageIds.length === 0) return [];
  const db = getDb();
  return db.select().from(messageAttachments).where(inArray(messageAttachments.messageId, messageIds));
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
