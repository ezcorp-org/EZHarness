/**
 * KB retrieval must show the model exactly what the API would show the user.
 *
 * ── The defect this closes ───────────────────────────────────────────────────
 *
 * `searchKBChunks` filtered on `project_id` + `status = 'ready'` and NOTHING
 * else. `setup-tools.ts` passed no acting user. So one member's uploaded file
 * was injected verbatim into EVERY project member's chat turns — while those
 * same members got a flat 404 from `GET /api/knowledge-base/[id]` for the very
 * same file. The API asserted an ownership boundary the prompt ignored, which
 * is the worst of both worlds: users believed their uploads were private, and
 * the model quoted them to everyone.
 *
 * The memory path next door had already been fixed this way — `hybridSearch`
 * scopes to `memories.user_id = userId`. KB retrieval had no equivalent. Now it
 * does, and the predicate is deliberately the API's own:
 *
 *     your own rows, PLUS ownerless rows — and nobody else's.
 *
 * Ownerless (`user_id IS NULL`) stays readable by everyone because that is the
 * knowledge base's ONE sharing mechanism, ruled on in
 * `kb-ownerless-rows-are-shared.test.ts` and now genuinely durable (the every-
 * boot reclaim in `migrate.ts` became one-shot — see
 * `db-migration-claim-ownerless-kb-once.test.ts`).
 *
 * ── How the equivalence is proven, not asserted ──────────────────────────────
 *
 * The load-bearing suite below walks every (caller × file) pair and asserts
 *
 *     retrieved-into-the-prompt  ===  readable-through-the-API
 *
 * with BOTH sides executed against the SAME real PGlite: the left by the real
 * `searchKBChunksForQuery`, the right by the real `GET /api/knowledge-base/[id]`
 * handler. Neither side is replicated or hand-fed, so the two cannot drift.
 *
 * The API side is probed through the DETAIL route because it is the cheaper of
 * the two read surfaces to mount honestly (the list route drags the upload
 * pipeline's embedder onto the import graph). That loses nothing: the existing
 * `kb-ownerless-rows-are-shared.test.ts` already pins `list === detail` by
 * execution, so `retrieval === detail === list` is a closed chain.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setupTestDb, closeTestDb, mockDbConnection } from "../helpers/test-pglite";
import { mockEmbedding, mockEmbeddingsModule } from "../helpers/mock-vectors";
import { mockServerAlias, createMockEvent } from "../helpers/mock-request";
import { containsCall } from "../helpers/source-match";
import { mock } from "bun:test";

mockDbConnection();
mockEmbeddingsModule();
mockServerAlias();

mock.module("../../../web/src/routes/api/knowledge-base/[id]/$types", () => ({}));
mock.module("../../../web/src/routes/api/knowledge-base/[id]/share/$types", () => ({}));
mock.module("$lib/server/http-errors", () => require("../../../web/src/lib/server/http-errors"));

// The scope axis (`requireScope`) has its own suites; neutralised so a scope
// failure can never masquerade as an ownership result.
const apiKeysMock = () => ({ requireScope: () => null });
mock.module("$lib/server/security/api-keys", apiKeysMock);
mock.module("../../../web/src/lib/server/security/api-keys", apiKeysMock);

// Only `requireAuth` is stubbed (these events carry a plain user object, not a
// real session). `checkProjectRole` — the membership gate the share route
// applies — is the REAL one, running against the same PGlite, so nothing about
// who may share is faked here.
const realAuthMiddleware = await import("../../auth/middleware");
const authMiddlewareMock = () => ({
  ...realAuthMiddleware,
  requireAuth: (locals: any) => {
    if (!locals?.user) throw new Response("Unauthorized", { status: 401 });
    return locals.user;
  },
});
mock.module("$server/auth/middleware", authMiddlewareMock);
mock.module("../../auth/middleware", authMiddlewareMock);

const { insertKBFile, updateKBFile, insertKBChunk, hasKBChunks } = await import(
  "../../db/queries/knowledge-base"
);
const { searchKBChunksForQuery } = await import("../../memory/retrieval");
const { createProject } = await import("../../db/queries/projects");
const { createUser } = await import("../../db/queries/users");
const { upsertProjectMember } = await import("../../db/queries/project-members");
const { GET: kbDetail } = await import("../../../web/src/routes/api/knowledge-base/[id]/+server");
const { POST: kbShare, DELETE: kbUnshare } = await import(
  "../../../web/src/routes/api/knowledge-base/[id]/share/+server"
);

const SHARED_TEXT = "shared-handbook-chunk";
const PRIVATE_TEXT = "uploader-private-chunk";

let projectId: string;
let otherProjectId: string;
let uploader: { id: string; email: string; name: string; role: string };
let other: { id: string; email: string; name: string; role: string };
let admin: { id: string; email: string; name: string; role: string };
let sharedFileId: string;
let ownedFileId: string;

async function readyFileWithChunk(
  project: string,
  filename: string,
  content: string,
  userId: string | null,
): Promise<string> {
  const file = await insertKBFile({
    projectId: project,
    filename,
    mimeType: "text/markdown",
    fileSize: 32,
    ...(userId ? { userId } : {}),
  });
  await updateKBFile(file.id, { status: "ready", chunkCount: 1 });
  await insertKBChunk({ fileId: file.id, content, chunkIndex: 0, embedding: mockEmbedding() });
  return file.id;
}

beforeAll(async () => {
  await setupTestDb();
  projectId = (await createProject({ name: "kb-scope", path: "/tmp/kb-scope" })).id;
  otherProjectId = (await createProject({ name: "kb-scope-b", path: "/tmp/kb-scope-b" })).id;

  uploader = (await createUser({
    email: "uploader@test.local",
    name: "Uploader",
    passwordHash: "x",
    role: "member",
  })) as typeof uploader;
  other = (await createUser({
    email: "other@test.local",
    name: "Other",
    passwordHash: "x",
    role: "member",
  })) as typeof other;
  admin = (await createUser({
    email: "admin@test.local",
    name: "Admin",
    passwordHash: "x",
    role: "admin",
  })) as typeof admin;

  sharedFileId = await readyFileWithChunk(projectId, "team-handbook.md", SHARED_TEXT, null);
  ownedFileId = await readyFileWithChunk(
    projectId,
    "uploader-private.md",
    PRIVATE_TEXT,
    uploader.id,
  );

  // The share route gates on real project membership (PR #89).
  for (const u of [uploader, other]) await upsertProjectMember(projectId, u.id, "member");
});

afterAll(async () => {
  await closeTestDb();
});

// ── The two probes: same question, two surfaces ──────────────────

/** Which chunk texts would be injected into this user's prompt? */
async function retrievedBy(userId: string | null, project = projectId): Promise<Set<string>> {
  const hits = await searchKBChunksForQuery("handbook", mockEmbedding(), project, userId, 50);
  return new Set(hits.map((h) => h.content));
}

/** Does `GET /api/knowledge-base/[id]` return the row for this user? */
async function detailReadableFor(user: unknown, id: string): Promise<boolean> {
  let res: Response;
  try {
    res = (await (kbDetail as any)(
      createMockEvent({
        url: `http://localhost/api/knowledge-base/${id}`,
        params: { id },
        user: user as any,
      }),
    )) as Response;
  } catch (e) {
    if (e instanceof Response) res = e;
    else throw e;
  }
  // Only 200/404 are legal here. Coercing anything else to `false` would make
  // the equivalence below vacuous by measuring a crash instead of a decision.
  expect([200, 404]).toContain(res.status);
  return res.status === 200;
}

/** Did any of this file's chunks reach the prompt? */
async function retrievedFileFor(userId: string | null, id: string): Promise<boolean> {
  const texts = await retrievedBy(userId);
  return (
    (id === sharedFileId && texts.has(SHARED_TEXT)) ||
    (id === ownedFileId && texts.has(PRIVATE_TEXT))
  );
}

// ── (A) The load-bearing invariant ────────────────────────────────

describe("INVARIANT: what retrieval injects === what the API would let the caller open", () => {
  test("every (caller × file) pair agrees", async () => {
    const callers = [
      { label: "the uploader", user: () => uploader },
      { label: "another member", user: () => other },
      { label: "an admin", user: () => admin },
    ];
    const files = [
      { label: "the shared (ownerless) file", id: () => sharedFileId },
      { label: "the uploader's own file", id: () => ownedFileId },
    ];

    for (const c of callers) {
      for (const f of files) {
        const injected = await retrievedFileFor(c.user().id, f.id());
        const readable = await detailReadableFor(c.user(), f.id());
        // If retrieval is ever widened back to project-wide, `injected` goes
        // true for a file the API still 404s and this fails. If the API is
        // tightened on ownerless rows without retrieval, it fails the other
        // way. Neither side can move alone.
        expect({ caller: c.label, file: f.label, injected, readable }).toEqual({
          caller: c.label,
          file: f.label,
          injected: readable,
          readable,
        });
      }
    }
  });
});

// ── (B) …and the agreed answer is the SCOPED one ──────────────────
//
// Equivalence alone would still hold if BOTH sides went project-wide. These
// pin the direction.

describe("BEHAVIOUR: another member's upload no longer reaches your prompt", () => {
  test("a member who did not upload the file gets none of its chunks", async () => {
    // THE confidentiality fix. Before it, this set contained PRIVATE_TEXT.
    const texts = await retrievedBy(other.id);
    expect(texts.has(PRIVATE_TEXT)).toBe(false);
  });

  test("…and an admin gets no override either — retrieval matches the API's no-admin-read rule", async () => {
    const texts = await retrievedBy(admin.id);
    expect(texts.has(PRIVATE_TEXT)).toBe(false);
  });

  test("the owner still gets their own file", async () => {
    const texts = await retrievedBy(uploader.id);
    expect(texts.has(PRIVATE_TEXT)).toBe(true);
  });
});

describe("BEHAVIOUR: ownerless rows stay shared — the scoping is not a blanket lockout", () => {
  test("every caller, including one with no user at all, still gets the shared file", async () => {
    for (const actor of [uploader.id, other.id, admin.id, null]) {
      const texts = await retrievedBy(actor);
      expect({ actor, shared: texts.has(SHARED_TEXT) }).toEqual({ actor, shared: true });
    }
  });

  test("a null actor (agent/CLI run, ownerless conversation) gets the shared row and NOTHING else", async () => {
    // `f.user_id = NULL` is never true in SQL, so a null actor degrades to the
    // ownerless subset — the rows any caller may read, never a superset.
    const texts = await retrievedBy(null);
    expect([...texts].sort()).toEqual([SHARED_TEXT]);
  });
});

describe("BEHAVIOUR: the project boundary still holds on top of the user boundary", () => {
  test("the owner's own file does not leak into a different project's retrieval", async () => {
    const texts = await retrievedBy(uploader.id, otherProjectId);
    expect(texts.size).toBe(0);
  });
});

// ── (B2) The invariant survives the SHARE verb ────────────────────
//
// Everything above proves the rule against rows a fixture wrote. Users can now
// produce ownerless rows themselves, through
// `POST /api/knowledge-base/[id]/share`. These tests re-run the equivalence on
// state the PRODUCT created, and — the part a fixture can never show — across
// the transition in both directions. Sharing is the one operation that MOVES a
// file between the two sides of this boundary, so if the mechanism and the
// predicate were ever to come apart, this is where it would show.

/** Drive the real share/un-share handler for `user` on `id`. */
async function callShare(handler: unknown, id: string, user: unknown): Promise<Response> {
  try {
    return (await (handler as any)(
      createMockEvent({
        url: `http://localhost/api/knowledge-base/${id}/share`,
        params: { id },
        user: user as any,
      }),
    )) as Response;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

describe("BEHAVIOUR: sharing a file through the API moves it across the SAME boundary retrieval reads", () => {
  const NEW_TEXT = "newly-shared-chunk";
  let newFileId: string;

  test("before sharing: the uploader's file reaches only the uploader, on both surfaces", async () => {
    newFileId = await readyFileWithChunk(projectId, "to-share.md", NEW_TEXT, uploader.id);

    expect((await retrievedBy(uploader.id)).has(NEW_TEXT)).toBe(true);
    expect((await retrievedBy(other.id)).has(NEW_TEXT)).toBe(false);
    expect(await detailReadableFor(other, newFileId)).toBe(false);
  });

  test("POST /share: retrieval AND the API open to everyone, in the same step", async () => {
    // No second signal is written — the route nulls `user_id`, which is the
    // predicate both surfaces and `visibleReadyFileIds` already read. That is
    // exactly why sharing needed no change to any of them.
    expect((await callShare(kbShare, newFileId, uploader)).status).toBe(200);

    for (const caller of [uploader, other, admin]) {
      const injected = (await retrievedBy(caller.id)).has(NEW_TEXT);
      const readable = await detailReadableFor(caller, newFileId);
      expect({ caller: caller.name, injected, readable }).toEqual({
        caller: caller.name,
        injected: true,
        readable: true,
      });
    }
    // And a null actor (agent/CLI run) too — an ownerless row is ownerless for
    // everybody, with no special case for "no user".
    expect((await retrievedBy(null)).has(NEW_TEXT)).toBe(true);
  });

  test("DELETE /share: both surfaces close again, in the same step", async () => {
    expect((await callShare(kbUnshare, newFileId, uploader)).status).toBe(200);

    for (const caller of [other, admin]) {
      const injected = (await retrievedBy(caller.id)).has(NEW_TEXT);
      const readable = await detailReadableFor(caller, newFileId);
      expect({ caller: caller.name, injected, readable }).toEqual({
        caller: caller.name,
        injected: false,
        readable: false,
      });
    }
    // The file went back to its ORIGINAL owner — un-sharing is not a transfer.
    expect((await retrievedBy(uploader.id)).has(NEW_TEXT)).toBe(true);
    expect(await detailReadableFor(uploader, newFileId)).toBe(true);
    expect((await retrievedBy(null)).has(NEW_TEXT)).toBe(false);
  });

  test("a member cannot use the share verb to publish someone ELSE's file", async () => {
    // The confidentiality fix, re-asserted at the new write surface: if this
    // ever returns 2xx, `other` has just injected the uploader's private
    // document into every member's prompt — the precise defect (A) closed.
    const before = await retrievedBy(other.id);
    expect((await callShare(kbShare, ownedFileId, other)).status).toBe(404);
    expect((await callShare(kbShare, ownedFileId, admin)).status).toBe(404);

    const after = await retrievedBy(other.id);
    expect([...after].sort()).toEqual([...before].sort());
    expect(after.has(PRIVATE_TEXT)).toBe(false);
    expect(await detailReadableFor(other, ownedFileId)).toBe(false);
  });
});

// ── (C) The fast path agrees with the search ──────────────────────

describe("hasKBChunks is scoped the same way, so the fast path cannot disagree", () => {
  test("true for callers who would get chunks, false for a project with none of theirs", async () => {
    // `setup-tools.ts` skips the embedding call entirely when this is false. If
    // it stayed project-wide it would answer `true` for a caller whose search
    // then returns nothing — an embedding round-trip bought for an empty result.
    expect(await hasKBChunks(projectId, other.id)).toBe(true); // the shared row
    expect(await hasKBChunks(otherProjectId, uploader.id)).toBe(false);
  });

  test("a project holding ONLY another member's file reads as empty", async () => {
    const solo = (await createProject({ name: "kb-scope-solo", path: "/tmp/kb-scope-solo" })).id;
    await readyFileWithChunk(solo, "only-mine.md", "solo-private-chunk", uploader.id);

    expect(await hasKBChunks(solo, uploader.id)).toBe(true);
    expect(await hasKBChunks(solo, other.id)).toBe(false);
    expect(await hasKBChunks(solo, null)).toBe(false);
    expect((await retrievedBy(other.id, solo)).size).toBe(0);
  });
});

// ── (D) Source-level pins ─────────────────────────────────────────

describe("source: the scope is named, and the call site actually threads a user", () => {
  const REPO_ROOT = resolve(import.meta.dir, "../../..");
  const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

  const QUERIES = "src/db/queries/knowledge-base.ts";
  const SETUP_TOOLS = "src/runtime/stream-chat/setup-tools.ts";

  test(`${QUERIES} — the predicate carries the KB-RETRIEVAL-FOLLOWS-API anchor`, () => {
    const src = read(QUERIES);
    const anchorAt = src.indexOf("KB-RETRIEVAL-FOLLOWS-API");
    const predicateAt = src.indexOf("f.user_id IS NULL OR f.user_id =");
    expect(anchorAt).toBeGreaterThan(-1);
    // The anchor must sit WITH the predicate it explains, not drift to the top.
    expect(predicateAt).toBeGreaterThan(anchorAt);
  });

  test(`${QUERIES} — the anchor points at THIS suite, so the rule is discoverable from the code`, () => {
    expect(read(QUERIES)).toContain("kb-retrieval-is-user-scoped");
  });

  test(`${SETUP_TOOLS} — the injection call site passes the conversation owner, not a placeholder`, () => {
    // The query being scoped is worth nothing if the one production caller
    // hardcodes a user (or drops back to a 4-arg call). Pinned literally.
    // Matched layout-insensitively so that wrapping the call across lines is
    // not mistaken for changing it; the argument list itself is still required
    // verbatim, in order (see helpers/source-match.ts).
    const src = read(SETUP_TOOLS);
    expect(
      containsCall(
        src,
        "searchKBChunksForQuery(userMessage, queryEmbedding, options.projectId!, convRecord?.userId ?? null, 5)",
      ),
      "the searchKBChunksForQuery call site no longer threads the conversation owner",
    ).toBe(true);
    expect(
      containsCall(src, "hasKBChunks(options.projectId!, convRecord?.userId ?? null)"),
      "the hasKBChunks call site no longer threads the conversation owner",
    ).toBe(true);
  });
});
