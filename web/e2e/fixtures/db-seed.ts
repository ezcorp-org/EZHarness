/**
 * DB-seed helpers for real-auth Playwright specs.
 *
 * All seeding flows through HTTP because PGlite is single-writer:
 * the running webServer holds the lock, so a parallel
 * `drizzle/pglite` open from this process would deadlock. The
 * test-only endpoints under `/api/__test/*` (gated by `PI_E2E_REAL=1`)
 * are the single source of writes from the spec side.
 *
 * Why this lives under `web/e2e/fixtures/` instead of `src/`:
 *   - Specs in `e2e/real-auth/*` are the only callers.
 *   - The bun-test unit suite (`web/src/__tests__/db-seed.test.ts`)
 *     imports it via relative path so the helper is exercised in
 *     isolation, without spinning up Playwright's webServer.
 */
import type { APIRequestContext } from "@playwright/test";

export interface SeedDraftOptions {
  request: APIRequestContext;
  name: string;
  type: "tool" | "skill" | "agent" | "multi";
  description?: string;
}

export interface SeededDraft {
  draftId: string;
  draftDir: string;
  userId: string;
  files: string[];
}

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

/**
 * Resolve the authenticated user via `/api/auth/me`. The real-auth
 * setup leaves a session cookie on the request context; this call
 * returns the bootstrapped admin's row.
 *
 * Throws on non-200 so a spec that expected auth gets a fast, loud
 * failure rather than a silent `undefined.id` down the line.
 */
export async function getCurrentUser(request: APIRequestContext): Promise<AuthedUser> {
  const res = await request.get("/api/auth/me");
  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`getCurrentUser: /api/auth/me failed (${res.status()}): ${body}`);
  }
  const json = (await res.json()) as { user?: AuthedUser };
  if (!json.user?.id) {
    throw new Error(`getCurrentUser: malformed /api/auth/me payload: ${JSON.stringify(json)}`);
  }
  return json.user;
}

/**
 * Seed an extension-author draft: inserts the `ez_drafts` row + writes
 * the scaffolded file map to disk. Owner is the authenticated caller.
 *
 * Returns `{ draftId, draftDir, userId, files }` — `files` is the list
 * of relpaths the scaffolder produced (so a spec can `expect()` the
 * exact file-tree shape without re-deriving it from the SDK).
 */
export async function seedExtensionAuthorDraft(
  opts: SeedDraftOptions,
): Promise<SeededDraft> {
  const { request, name, type, description } = opts;
  const res = await request.post("/api/__test/seed-extension-author-draft", {
    data: { name, type, description: description ?? "E2E seeded extension" },
  });
  if (!res.ok()) {
    const body = await res.text();
    throw new Error(
      `seedExtensionAuthorDraft: failed (${res.status()}) — is the webServer launched with PI_E2E_REAL=1? Body: ${body}`,
    );
  }
  return (await res.json()) as SeededDraft;
}

/**
 * Discard an extension-author draft (row + on-disk dir). Uses the
 * public DELETE endpoint, which is the same code path the UI's
 * Discard button hits — keeps the cleanup contract honest.
 *
 * Idempotent: a 404 on cleanup (already gone) is treated as success.
 */
export async function cleanupExtensionAuthorDraft(
  request: APIRequestContext,
  draftId: string,
): Promise<{ ok: boolean }> {
  if (!draftId) return { ok: true };
  const res = await request.delete(`/api/extensions/author/draft/${draftId}`);
  if (res.status() === 404) return { ok: true };
  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`cleanupExtensionAuthorDraft: failed (${res.status()}): ${body}`);
  }
  return { ok: true };
}

/**
 * Remove an installed extension (row + on-disk dir). Hits the
 * test-only cleanup endpoint, which the production build serves as a
 * 404. Caller must be an admin (the bootstrapped test user is).
 *
 * Idempotent: missing row + missing dir both return `{ ok: true }`.
 */
export async function cleanupInstalledExtension(
  request: APIRequestContext,
  name: string,
): Promise<{ ok: boolean; rowDeleted: boolean; dirRemoved: boolean }> {
  const res = await request.post("/api/__test/cleanup-extension", {
    data: { name },
  });
  if (!res.ok()) {
    const body = await res.text();
    throw new Error(
      `cleanupInstalledExtension: failed (${res.status()}) — is PI_E2E_REAL=1? Body: ${body}`,
    );
  }
  return (await res.json()) as { ok: boolean; rowDeleted: boolean; dirRemoved: boolean };
}
