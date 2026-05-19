/**
 * Phase 48 Wave 1 — ez_drafts CRUD + expiry sweep.
 *
 * Drafts back the propose_* tool family. Critical invariants:
 *  - createDraft stores the payload + 24h-from-now expiry by default
 *  - getDraft enforces ownership (cross-user reads return undefined)
 *  - getDraft returns undefined once expiresAt has passed
 *  - consumeDraft is idempotent (second call doesn't shift consumedAt)
 *  - sweepExpired GCs only past-due rows
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const drafts = await import("../db/queries/ez-drafts");
const { getDb } = await import("../db/connection");
const { ezDrafts } = await import("../db/schema");
const { eq, sql } = await import("drizzle-orm");

let userA: string;
let userB: string;

beforeAll(async () => {
  await setupTestDb();
  const a = await createUser({ email: "drafts-a@test.com", passwordHash: "h", name: "A" });
  const b = await createUser({ email: "drafts-b@test.com", passwordHash: "h", name: "B" });
  userA = a.id;
  userB = b.id;
});

afterAll(async () => {
  await closeTestDb();
});

describe("ez-drafts queries", () => {
  test("createDraft persists the payload and stamps a 24h expiry", async () => {
    const before = Date.now();
    const row = await drafts.createDraft({
      userId: userA,
      kind: "project",
      payload: { name: "My App", path: "./my-app" },
    });
    const after = Date.now();

    expect(row.id).toBeDefined();
    expect(row.userId).toBe(userA);
    expect(row.kind).toBe("project");
    expect(row.payload).toEqual({ name: "My App", path: "./my-app" });
    expect(row.consumedAt).toBeNull();

    const expiry = row.expiresAt.getTime() - row.createdAt.getTime();
    // ~24h, allow a 1s tolerance for test scheduler jitter.
    expect(expiry).toBeGreaterThan(24 * 60 * 60 * 1000 - 1000);
    expect(expiry).toBeLessThan(24 * 60 * 60 * 1000 + 1000);
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(after);
  });

  test("createDraft stores payload as a jsonb OBJECT, not a string scalar (no double-encoding)", async () => {
    // Defect-3 root-cause guard. createDraft binds `payload` as the
    // raw JS object; under external Postgres `initPostgres()`'s identity
    // `mapToDriverValue` patch makes Bun.sql serialize it to jsonb
    // natively. This must yield a real jsonb object — NOT the
    // double-encoded string scalar (`"{\"x\":1}"`) that a JSON-text
    // bind (`sql`${JSON.stringify(...)}::jsonb``) or `to_jsonb(text)`
    // produces and that breaks every `payload->>'key'` lookup. See
    // jsonb-double-encoding.test.ts. (Under PGlite, used by this test,
    // both forms behave; the guard locks the contract regardless.)
    const created = await drafts.createDraft({
      userId: userA,
      kind: "extension",
      payload: { name: "weather", nested: { a: 1 }, list: [1, 2] },
    });
    const probe = await getDb().execute(sql`
      SELECT jsonb_typeof(payload) AS t,
             payload->>'name' AS name,
             payload#>>'{nested,a}' AS nested_a
      FROM ez_drafts WHERE id = ${created.id}
    `);
    const r = (probe as { rows: Array<Record<string, unknown>> }).rows[0]!;
    expect(r.t).toBe("object");
    expect(r.name).toBe("weather");
    expect(r.nested_a).toBe("1");
  });

  test("createDraft requires userId — empty throws", async () => {
    expect(
      drafts.createDraft({ userId: "", kind: "agent", payload: {} }),
    ).rejects.toThrow();
  });

  test("getDraft returns the row to its owner", async () => {
    const created = await drafts.createDraft({
      userId: userA,
      kind: "agent",
      payload: { name: "Email Triager" },
    });
    const fetched = await drafts.getDraft(created.id, userA);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.payload).toEqual({ name: "Email Triager" });
  });

  test("getDraft refuses cross-user access (returns undefined)", async () => {
    const created = await drafts.createDraft({
      userId: userA,
      kind: "extension",
      payload: { name: "pdf-reader" },
    });
    const stolenAttempt = await drafts.getDraft(created.id, userB);
    expect(stolenAttempt).toBeUndefined();
  });

  test("getDraft returns undefined once expiresAt is in the past", async () => {
    // Create with a tiny TTL (1 ms). The next event-loop tick the row
    // is logically expired.
    const created = await drafts.createDraft({
      userId: userA,
      kind: "project",
      payload: { name: "Soon-stale" },
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 5));
    const fetched = await drafts.getDraft(created.id, userA);
    expect(fetched).toBeUndefined();
  });

  test("consumeDraft stamps consumedAt and is idempotent on second call", async () => {
    const created = await drafts.createDraft({
      userId: userA,
      kind: "project",
      payload: { name: "Consume me" },
    });
    const first = await drafts.consumeDraft(created.id, userA);
    expect(first).toBeDefined();
    expect(first!.consumedAt).toBeDefined();
    const stamp1 = first!.consumedAt!.getTime();

    // Second call must not advance the timestamp.
    await new Promise((r) => setTimeout(r, 5));
    const second = await drafts.consumeDraft(created.id, userA);
    expect(second!.consumedAt!.getTime()).toBe(stamp1);
  });

  test("consumeDraft refuses cross-user access (returns undefined)", async () => {
    const created = await drafts.createDraft({
      userId: userA,
      kind: "agent",
      payload: { name: "Cross-user attack" },
    });
    const stolen = await drafts.consumeDraft(created.id, userB);
    expect(stolen).toBeUndefined();
    // Verify the row remains unconsumed.
    const fresh = await drafts.getDraft(created.id, userA);
    expect(fresh!.consumedAt).toBeNull();
  });

  test("sweepExpired removes only past-due rows; live rows survive", async () => {
    // Wipe slate clean so prior-test rows don't pollute the count.
    await getDb().delete(ezDrafts).where(eq(ezDrafts.userId, userA));
    await getDb().delete(ezDrafts).where(eq(ezDrafts.userId, userB));

    // Insert: one already-expired (1ms TTL), two still-live (24h default).
    const stale = await drafts.createDraft({
      userId: userA,
      kind: "project",
      payload: { name: "Stale" },
      ttlMs: 1,
    });
    await drafts.createDraft({ userId: userA, kind: "agent", payload: { name: "Live A" } });
    await drafts.createDraft({ userId: userB, kind: "extension", payload: { name: "Live B" } });

    await new Promise((r) => setTimeout(r, 5));
    const removed = await drafts.sweepExpired();
    expect(removed).toBeGreaterThanOrEqual(1);

    // The stale row is gone, the two live rows survive.
    const goneStale = await drafts.getDraft(stale.id, userA);
    expect(goneStale).toBeUndefined();
    const surviving = await drafts.listActiveDraftsForUser(userA);
    expect(surviving.find((r) => r.payload?.name === "Live A")).toBeDefined();
    expect(surviving.find((r) => r.payload?.name === "Stale")).toBeUndefined();
  });
});

// ── Host-side draft materializer ───────────────────────────────────
//
// `writeExtensionAuthorDraftFiles` is the deterministic create path:
// the host (not the sandboxed subprocess) writes the scaffold files,
// so a fresh-project `create_extension` can never deadlock on the
// filesystem permission gate. These pin the disk side effect + the
// defense-in-depth validation that stops a (hypothetically forged)
// subprocess from writing arbitrary paths.

import { existsSync, readFileSync, mkdtempSync as mkdtemp3, rmSync as rm3 } from "node:fs";
import { tmpdir as tmpdir3 } from "node:os";
import { join as join3 } from "node:path";

describe("writeExtensionAuthorDraftFiles", () => {
  let prevCwd = "";
  let root = "";

  beforeAll(() => {
    // chdir to a .git-free temp dir so getExtensionAuthorDraftDir's
    // findProjectRoot(cwd) resolves HERE, not the real repo tree.
    root = mkdtemp3(join3(tmpdir3(), "ezd-mat-"));
    prevCwd = process.cwd();
    process.chdir(root);
  });
  afterAll(() => {
    if (prevCwd) try { process.chdir(prevCwd); } catch { /* */ }
    if (root) try { rm3(root, { recursive: true, force: true }); } catch { /* */ }
  });

  test("writes the allowlisted file map under the userId-namespaced dir", async () => {
    const files = {
      "ezcorp.config.ts": "export default {};\n",
      "index.ts": "// entry\n",
      "README.md": "# hi\n",
      ".gitignore": "node_modules/\n",
    };
    const { draftDir, written } = await drafts.writeExtensionAuthorDraftFiles(
      "draft-abc",
      userA,
      files,
    );
    expect(draftDir).toBe(
      join3(root, ".ezcorp/extension-data/extension-author/drafts", userA, "draft-abc"),
    );
    expect(written.sort()).toEqual(
      [".gitignore", "README.md", "ezcorp.config.ts", "index.ts"].sort(),
    );
    expect(existsSync(draftDir)).toBe(true);
    expect(readFileSync(join3(draftDir, "ezcorp.config.ts"), "utf-8")).toBe(
      "export default {};\n",
    );
    expect(readFileSync(join3(draftDir, ".gitignore"), "utf-8")).toBe(
      "node_modules/\n",
    );
  });

  test("rejects a non-allowlisted file name and writes NOTHING", async () => {
    expect(
      drafts.writeExtensionAuthorDraftFiles("draft-bad1", userA, {
        "ezcorp.config.ts": "ok",
        "evil.sh": "rm -rf /",
      }),
    ).rejects.toThrow(/not in the scaffold allowlist/);
    // All-or-nothing: the validation runs before any write.
    expect(
      existsSync(
        join3(root, ".ezcorp/extension-data/extension-author/drafts", userA, "draft-bad1"),
      ),
    ).toBe(false);
  });

  test("rejects path-traversal / separators / absolute names", async () => {
    for (const bad of ["../escape.ts", "sub/index.ts", "/etc/passwd"]) {
      expect(
        drafts.writeExtensionAuthorDraftFiles("draft-bad2", userA, {
          [bad]: "x",
        }),
      ).rejects.toThrow();
    }
  });

  test("rejects non-string content and an empty map", async () => {
    expect(
      drafts.writeExtensionAuthorDraftFiles("draft-bad3", userA, {
        "index.ts": 123 as unknown as string,
      }),
    ).rejects.toThrow(/content must be a string/);
    expect(
      drafts.writeExtensionAuthorDraftFiles("draft-bad4", userA, {}),
    ).rejects.toThrow(/empty/);
  });

  test("invalid draftId shape is rejected (reuses getExtensionAuthorDraftDir gate)", async () => {
    expect(
      drafts.writeExtensionAuthorDraftFiles("bad id!", userA, {
        "index.ts": "x",
      }),
    ).rejects.toThrow(/Invalid draftId/);
  });
});
