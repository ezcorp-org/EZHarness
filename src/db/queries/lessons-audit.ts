/**
 * Queries for the `lessons_audit_log` table (Phase 50.4).
 *
 * Mirrors `memory_audit_log` shape — full before/after body + frontmatter
 * captured on every lesson mutation. Forever retention (small table,
 * debugging gold). Cascade delete with the parent lesson row.
 *
 * Body cap: 64 KB. If exceeded we store the first 32 KB plus a sha256
 * of the original — same shape as `redactForAudit` truncation. This
 * keeps the audit row useful for forensic comparison without risking
 * unbounded JSONB bloat from a runaway lesson body.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { getDb } from "../connection";
import { lessonsAuditLog } from "../schema";
import type { LessonAuditEntry, NewLessonAuditEntry } from "../schema";

export type { LessonAuditEntry, NewLessonAuditEntry };

const DEFAULT_LIMIT = 100;

const BODY_CAP_BYTES = 64 * 1024;
const BODY_KEEP_BYTES = 32 * 1024;
const TRUNCATION_PREFIX = "[truncated:";

function sha256Hex(input: string): string {
  // Bun fast path; node:crypto fallback. Mirrors the redactor.
  const BunGlobal = (globalThis as unknown as {
    Bun?: { CryptoHasher: new (algo: string) => { update(s: string): void; digest(enc: string): string } };
  }).Bun;
  if (BunGlobal?.CryptoHasher) {
    const h = new BunGlobal.CryptoHasher("sha256");
    h.update(input);
    return h.digest("hex");
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(input).digest("hex");
}

/** Truncate a body at `BODY_CAP_BYTES`. Format:
 *    "[truncated:<sha256-of-original>]<first 32 KB>"
 *  preserves a forensic anchor (the sha256) plus a human-readable
 *  preview. Callers who need full bodies must pull from a backup. */
function capBody(body: string | null | undefined): string | null {
  if (body == null) return null;
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes <= BODY_CAP_BYTES) return body;
  const sha = sha256Hex(body);
  return `${TRUNCATION_PREFIX}${sha}]${body.slice(0, BODY_KEEP_BYTES)}`;
}

export async function insertLessonAuditEntry(entry: NewLessonAuditEntry): Promise<void> {
  await getDb().insert(lessonsAuditLog).values({
    ...entry,
    previousBody: capBody(entry.previousBody),
    newBody: capBody(entry.newBody),
  });
}

export async function listLessonAuditByLessonId(
  lessonId: string,
  limit = DEFAULT_LIMIT,
): Promise<LessonAuditEntry[]> {
  return getDb()
    .select()
    .from(lessonsAuditLog)
    .where(eq(lessonsAuditLog.lessonId, lessonId))
    .orderBy(desc(lessonsAuditLog.createdAt))
    .limit(limit);
}

export async function listLessonAuditByActorExtension(
  extensionId: string,
  opts: { limit?: number; cursor?: number } = {},
): Promise<LessonAuditEntry[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const conds = [eq(lessonsAuditLog.actorExtensionId, extensionId)];
  if (opts.cursor !== undefined) conds.push(lt(lessonsAuditLog.id, opts.cursor));
  return getDb()
    .select()
    .from(lessonsAuditLog)
    .where(and(...conds))
    .orderBy(desc(lessonsAuditLog.id))
    .limit(limit);
}
