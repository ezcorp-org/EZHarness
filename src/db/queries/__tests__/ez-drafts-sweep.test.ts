// Tests for `sweepExpired()` in `src/db/queries/ez-drafts.ts`.
//
// Two surfaces:
//   1. The DB delete (existing behavior — pin so the rm extension
//      doesn't regress it).
//   2. The Phase 5 fs cleanup: rows whose `kind === 'extension'` AND
//      `payload.mode === 'author'` get their on-disk draft dir
//      removed. Other kinds → row deleted, no fs side effect.

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "../../../__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../../__tests__/helpers/mock-cleanup";

mockDbConnection();

const { sweepExpired, createDraft } = await import("../ez-drafts");
const { ezDrafts, users } = await import("../../schema");
const { eq } = await import("drizzle-orm");

const USER = "user-sweep";
let TMP: string;
let DRAFT_ROOT: string;
let originalCwd: string;

beforeAll(async () => {
  await setupTestDb();
  await getTestDb().insert(users).values({
    id: USER,
    email: `${USER}@t.local`,
    passwordHash: "x",
    name: USER,
  } as never).onConflictDoNothing();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

beforeEach(() => {
  // Each test gets a fresh tmp dir + chdir's into it so the sweep's
  // findProjectRoot resolves to our tmp area, not the worktree.
  TMP = join(tmpdir(), `ez-drafts-sweep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(join(TMP, ".git"), { recursive: true });
  DRAFT_ROOT = join(TMP, ".ezcorp/extension-data/extension-author/drafts");
  mkdirSync(DRAFT_ROOT, { recursive: true });
  originalCwd = process.cwd();
  process.chdir(TMP);
});

afterEach(async () => {
  try { process.chdir(originalCwd); } catch { /* swallow */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* swallow */ }
  // Clear all drafts between tests so each run is isolated.
  await getTestDb().delete(ezDrafts);
});

async function insertDraft(opts: {
  kind: "extension" | "agent" | "project";
  payload: Record<string, unknown>;
  expired: boolean;
}): Promise<{ id: string }> {
  if (opts.expired) {
    // Insert a row that's already past its TTL by directly setting
    // expiresAt. createDraft's TTL is positive so we bypass it.
    const past = new Date(Date.now() - 60_000);
    const rows = await getTestDb()
      .insert(ezDrafts)
      .values({
        userId: USER,
        kind: opts.kind,
        payload: opts.payload,
        createdAt: past,
        expiresAt: past,
      } as never)
      .returning();
    return { id: (rows as Array<{ id: string }>)[0]!.id };
  }
  const row = await createDraft({ userId: USER, kind: opts.kind, payload: opts.payload });
  return { id: row.id };
}

function seedDraftDir(draftId: string, content = "manifest stub"): string {
  // New layout: `drafts/<userId>/<draftId>/` (reviewer C1).
  const dir = join(DRAFT_ROOT, USER, draftId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ezcorp.config.ts"), content, "utf8");
  return dir;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("sweepExpired — DB delete pin", () => {
  test("deletes only expired rows", async () => {
    await insertDraft({ kind: "agent", payload: { x: 1 }, expired: true });
    await insertDraft({ kind: "agent", payload: { x: 2 }, expired: false });
    const deleted = await sweepExpired();
    expect(deleted).toBe(1);
    const remaining = await getTestDb().select().from(ezDrafts);
    expect(remaining.length).toBe(1);
  });

  test("zero rows when none expired", async () => {
    await insertDraft({ kind: "agent", payload: { x: 1 }, expired: false });
    const deleted = await sweepExpired();
    expect(deleted).toBe(0);
  });
});

describe("sweepExpired — extension-author dir cleanup", () => {
  test("expired extension-author draft → row deleted + dir removed", async () => {
    const { id } = await insertDraft({
      kind: "extension",
      payload: { name: "x", type: "tool", mode: "author" },
      expired: true,
    });
    const dir = seedDraftDir(id);
    expect(existsSync(dir)).toBe(true);

    const deleted = await sweepExpired();
    expect(deleted).toBe(1);
    expect(existsSync(dir)).toBe(false);

    // Row gone
    const rows = await getTestDb().select().from(ezDrafts).where(eq(ezDrafts.id, id));
    expect(rows.length).toBe(0);
  });

  test("non-author extension draft → row deleted, dir untouched", async () => {
    const { id } = await insertDraft({
      kind: "extension",
      payload: { name: "x", type: "tool", mode: "marketplace" },
      expired: true,
    });
    const dir = seedDraftDir(id);
    expect(existsSync(dir)).toBe(true);

    const deleted = await sweepExpired();
    expect(deleted).toBe(1);
    // Dir survives — not an author draft.
    expect(existsSync(dir)).toBe(true);
  });

  test("non-extension kind → no fs side effect", async () => {
    const { id } = await insertDraft({
      kind: "agent",
      payload: { name: "x", mode: "author" }, // mode set but kind != extension
      expired: true,
    });
    const dir = seedDraftDir(id);
    expect(existsSync(dir)).toBe(true);

    const deleted = await sweepExpired();
    expect(deleted).toBe(1);
    expect(existsSync(dir)).toBe(true);
  });

  test("extension-author draft with no on-disk dir → no error, row deleted", async () => {
    const { id } = await insertDraft({
      kind: "extension",
      payload: { name: "x", type: "tool", mode: "author" },
      expired: true,
    });
    // No seedDraftDir — dir doesn't exist
    const deleted = await sweepExpired();
    expect(deleted).toBe(1);
    expect(existsSync(join(DRAFT_ROOT, USER, id))).toBe(false);
    const rows = await getTestDb().select().from(ezDrafts).where(eq(ezDrafts.id, id));
    expect(rows.length).toBe(0);
  });

  test("multiple expired drafts of mixed kinds — only author dirs removed", async () => {
    const a = await insertDraft({ kind: "extension", payload: { mode: "author" }, expired: true });
    const b = await insertDraft({ kind: "extension", payload: { mode: "marketplace" }, expired: true });
    const c = await insertDraft({ kind: "agent", payload: {}, expired: true });
    const dirA = seedDraftDir(a.id);
    const dirB = seedDraftDir(b.id);
    const dirC = seedDraftDir(c.id);

    const deleted = await sweepExpired();
    expect(deleted).toBe(3);
    expect(existsSync(dirA)).toBe(false); // author → removed
    expect(existsSync(dirB)).toBe(true);  // marketplace → kept
    expect(existsSync(dirC)).toBe(true);  // agent kind → kept
  });

  test("non-expired author draft → row + dir both survive", async () => {
    const { id } = await insertDraft({
      kind: "extension",
      payload: { mode: "author" },
      expired: false,
    });
    const dir = seedDraftDir(id);

    const deleted = await sweepExpired();
    expect(deleted).toBe(0);
    expect(existsSync(dir)).toBe(true);
    const rows = await getTestDb().select().from(ezDrafts).where(eq(ezDrafts.id, id));
    expect(rows.length).toBe(1);
  });
});
