import { eq, desc, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { knowledgeBaseFiles, knowledgeBaseChunks } from "../schema";
import type { KBFile, NewKBFile, KBChunk, NewKBChunk } from "../schema";
import type { KBChunkResult } from "../../memory/types";
import { toVectorLiteral } from "../../memory/vector-utils";

export async function insertKBFile(data: NewKBFile): Promise<KBFile> {
  const db = getDb();
  const rows = await db.insert(knowledgeBaseFiles).values(data).returning();
  return rows[0]!;
}

export async function updateKBFile(
  id: string,
  updates: Partial<Pick<KBFile, "status" | "chunkCount">>,
): Promise<void> {
  const db = getDb();
  await db.update(knowledgeBaseFiles).set(updates).where(eq(knowledgeBaseFiles.id, id));
}

export async function listKBFiles(projectId: string): Promise<KBFile[]> {
  const db = getDb();
  return db
    .select()
    .from(knowledgeBaseFiles)
    .where(eq(knowledgeBaseFiles.projectId, projectId))
    .orderBy(desc(knowledgeBaseFiles.createdAt));
}

export async function getKBFile(id: string): Promise<KBFile | undefined> {
  const db = getDb();
  const rows = await db.select().from(knowledgeBaseFiles).where(eq(knowledgeBaseFiles.id, id));
  return rows[0];
}

export async function deleteKBFile(id: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.delete(knowledgeBaseFiles).where(eq(knowledgeBaseFiles.id, id)).returning();
  return rows.length > 0;
}

export async function insertKBChunk(data: NewKBChunk): Promise<KBChunk> {
  const db = getDb();
  // Use raw SQL for vector insertion
  if (data.embedding) {
    const vectorLiteral = toVectorLiteral(data.embedding);
    const results = await db.execute(sql`
      INSERT INTO knowledge_base_chunks (id, file_id, content, chunk_index, embedding)
      VALUES (${data.id ?? crypto.randomUUID()}, ${data.fileId}, ${data.content}, ${data.chunkIndex}, ${sql.raw(vectorLiteral)})
      RETURNING id, file_id as "fileId", content, chunk_index as "chunkIndex", created_at as "createdAt"
    `);
    return (results.rows ?? [])[0] as unknown as KBChunk;
  }
  const rows = await db.insert(knowledgeBaseChunks).values(data).returning();
  return rows[0]!;
}

export async function searchKBChunks(
  embedding: number[],
  projectId: string,
  limit: number = 5,
): Promise<KBChunkResult[]> {
  const db = getDb();
  const vectorLiteral = toVectorLiteral(embedding);
  const results = await db.execute(sql`
    SELECT c.id, c.content, c.chunk_index as "chunkIndex", f.filename, c.file_id as "fileId",
           1 - (c.embedding <=> ${sql.raw(vectorLiteral)}) as similarity
    FROM knowledge_base_chunks c
    JOIN knowledge_base_files f ON c.file_id = f.id
    WHERE f.project_id = ${projectId}
      AND f.status = 'ready'
      AND c.embedding IS NOT NULL
    ORDER BY c.embedding <=> ${sql.raw(vectorLiteral)}
    LIMIT ${limit}
  `);
  return (results.rows ?? []) as unknown as KBChunkResult[];
}

/** Fast check: does this project have any indexed KB chunks?
 *  Imported dynamically by src/runtime/stream-chat/setup-tools.ts. */
// fallow-ignore-next-line unused-export
export async function hasKBChunks(projectId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.execute(
    sql`SELECT EXISTS(
      SELECT 1 FROM knowledge_base_chunks c
      JOIN knowledge_base_files f ON c.file_id = f.id
      WHERE f.project_id = ${projectId} AND f.status = 'ready'
    ) AS has_data`,
  );
  return (rows.rows[0] as { has_data?: boolean } | undefined)?.has_data === true;
}
