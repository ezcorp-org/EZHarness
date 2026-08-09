// Knowledge-base rows with `user_id IS NULL` are SHARED — deliberately, and on
// BOTH read surfaces at once. This suite exists to make that a contract rather
// than a coincidence.
//
// ── The ruling ───────────────────────────────────────────────────────────────
//
// A prior security pass (`cross-tenant-deletion-projects-kb-modes.test.ts`)
// closed a fail-OPEN hole on `DELETE /api/knowledge-base/[id]`, where
//
//   if (file.userId && file.userId !== user.id) return 404;
//
// short-circuited on a null owner and let any authenticated caller destroy an
// unowned file. That pass deliberately did NOT touch the same shape on the READ
// side, and said so, because the read side is two coupled predicates:
//
//   list   web/src/routes/api/knowledge-base/+server.ts
//          files.filter(f => !f.userId || f.userId === user.id)
//   detail web/src/routes/api/knowledge-base/[id]/+server.ts   (GET)
//          if (file.userId && file.userId !== user.id) return 404;
//
// Tightening detail alone yields a **list-but-404**: a file the user can see in
// the list and cannot open. Tightening list alone yields a file that is
// fetchable by id but invisible. Either way the product lies to the user.
//
// The resolution is that the permissive read is CORRECT and intentional:
// `user_id IS NULL` is the knowledge base's sharing mechanism, not an orphan
// marker. Three independent reasons, all checkable in-tree:
//
//   1. A null owner cannot arise by accident. `POST /api/knowledge-base` always
//      stamps `userId: user.id` (pinned below), so no upload can mint an
//      ownerless row; one exists only because an operator put it there.
//      (This reason USED to lean on a second clause — that `migrate.ts`
//      reclaimed null-owner rows to the first admin on every boot, so they
//      could not linger. That reclaim was the bug, not the argument: it meant
//      a shared file silently un-shared itself at the next restart. It is now
//      one-shot, so sharing is durable. Pinned below.)
//   2. There is no other way to express "shared" on THIS surface. KB reads gate
//      on per-file `userId` alone — there is no project-membership check in
//      either read handler — so a null owner is the only "shared with the
//      project" the knowledge base can say.
//   3. Retrieval honours the SAME rule. `searchKBChunks` scopes to
//      `user_id IS NULL OR user_id = <caller>` — your own rows plus the shared
//      ones — so what the model is fed matches what the API will let the user
//      open, row for row. (It used to filter on `project_id` + `status` alone,
//      which injected every member's uploads into every other member's turn
//      while the API 404'd them. That confidentiality defect is closed and
//      pinned by `kb-retrieval-is-user-scoped.test.ts`, which asserts the
//      equivalence by execution.)
//
// ── What this suite guarantees ───────────────────────────────────────────────
//
// (A) The two predicates are ONE invariant. The load-bearing test walks every
//     (caller × row) pair and asserts `listed === detailReadable`. It fails if
//     EITHER side is tightened or loosened without the other — which is exactly
//     the drift the ruling is meant to prevent.
// (B) The intent is named in the source. A regression pin requires the
//     `KB-SHARED-NULL-OWNER` anchor at both predicates, so the rationale cannot
//     be deleted silently while the behaviour survives (or vice versa).
// (C) Sharing is READ-ONLY. Pinned here, next to the permissive read, because
//     the likeliest bad "fix" is a reader who takes "everyone may read it" and
//     widens it into "anyone may delete it". (The DELETE axis has its full home
//     in `cross-tenant-deletion-projects-kb-modes.test.ts`; this is the single
//     assertion that ties the two axes together at the point of confusion.)
// (D) The PREMISE holds. `POST` stamping an owner is what keeps the shared rule
//     from turning every upload world-readable; it was asserted in prose and
//     pinned nowhere until now. The migrate.ts reclaim is pinned too, as a
//     tripwire on the durability caveat rather than a blessing of it.

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import { squish } from "../helpers/source-match";
import { mockServerAlias, createMockEvent, ADMIN_USER } from "../helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────

mockServerAlias();

mock.module("../../../web/src/routes/api/knowledge-base/$types", () => ({}));
mock.module("../../../web/src/routes/api/knowledge-base/[id]/$types", () => ({}));

// The scope axis (`requireScope`) is a SEPARATE concern with its own suites
// (web/src/__tests__/api-knowledge-base*.server.test.ts). Neutralised here so a
// scope failure can never masquerade as an ownership result.
const apiKeysMock = () => ({ requireScope: () => null });
mock.module("$lib/server/security/api-keys", apiKeysMock);
mock.module("../../../web/src/lib/server/security/api-keys", apiKeysMock);

const authMiddlewareMock = () => ({
  requireAuth: (locals: any) => {
    if (!locals?.user) throw new Response("Unauthorized", { status: 401 });
    return locals.user;
  },
  // The list route consults project membership to decide whether to OFFER the
  // Share button (`canShare`); it never gates visibility on it. This suite runs
  // against an in-memory KB store with no database at all, and membership is a
  // separate axis with its own suite (`kb-file-sharing-api.test.ts`), so it is
  // neutralised here — exactly like `requireScope` above — and cannot
  // masquerade as an ownership result.
  checkProjectRole: async (locals: any) => locals?.user,
});
mock.module("$server/auth/middleware", authMiddlewareMock);
mock.module("../../auth/middleware", authMiddlewareMock);

// The upload route eagerly imports the local embedder, which drags
// onnxruntime-node onto the import graph. Stubbed: this suite never uploads.
const embeddingsMock = () => ({
  generateEmbedding: async () => new Array(384).fill(0),
  warmupEmbeddings: async () => {},
  EMBEDDING_MODEL_ID: "test-stub@384",
});
mock.module("$server/memory/embeddings", embeddingsMock);
mock.module("../../memory/embeddings", embeddingsMock);

const quotaMock = () => ({
  checkStorageQuota: async () => ({ allowed: true }),
  checkTokenBudget: async () => ({ allowed: true }),
  recordTokenUsage: async () => {},
});
mock.module("$lib/server/security/resource-quotas", quotaMock);
mock.module("../../../web/src/lib/server/security/resource-quotas", quotaMock);

// The real chunker — cheap, pure, and the upload probe below should exercise
// the genuine `isAllowedFile` gate rather than a stub of it.
mock.module("$server/memory/chunking", () => require("../../memory/chunking"));

// ── In-memory KB store ───────────────────────────────────────────

type Row = { id: string; projectId: string; userId: string | null; filename: string };

const PROJECT = "11111111-1111-4111-8111-111111111111";
let kbStore: Map<string, Row>;
let inserted: Array<Record<string, unknown>>;

const kbMock = () => ({
  listKBFiles: async (projectId: string) =>
    [...kbStore.values()].filter(r => r.projectId === projectId),
  getKBFile: async (id: string) => kbStore.get(id) ?? undefined,
  deleteKBFile: async (id: string) => kbStore.delete(id),
  insertKBFile: async (data: Record<string, unknown>) => {
    inserted.push(data);
    const row: Row = {
      id: `kb-inserted-${inserted.length}`,
      projectId: data.projectId as string,
      // Record whatever the handler actually passed — including `undefined`,
      // which is the regression this captures.
      userId: (data.userId as string | null | undefined) ?? null,
      filename: data.filename as string,
    };
    kbStore.set(row.id, row);
    return row;
  },
  updateKBFile: async () => {},
  insertKBChunk: async () => ({}),
});
mock.module("$server/db/queries/knowledge-base", kbMock);
mock.module("../../db/queries/knowledge-base", kbMock);

// ── Handler imports (AFTER mocks) ────────────────────────────────

import { GET as kbList, POST as kbUpload } from "../../../web/src/routes/api/knowledge-base/+server";
import {
  GET as kbDetail,
  DELETE as kbDelete,
} from "../../../web/src/routes/api/knowledge-base/[id]/+server";

async function call(handler: (ev: any) => unknown, event: any): Promise<Response> {
  try {
    return (await handler(event)) as Response;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

afterAll(() => {
  restoreModuleMocks();
});

const UPLOADER = { id: "user-uploader", email: "up@test.local", name: "Uploader", role: "member" } as const;
const OTHER = { id: "user-other", email: "other@test.local", name: "Other", role: "member" } as const;

const SHARED = "kb-shared-null-owner";
const OWNED_BY_UPLOADER = "kb-owned-by-uploader";

beforeEach(() => {
  inserted = [];
  kbStore = new Map<string, Row>([
    [SHARED, { id: SHARED, projectId: PROJECT, userId: null, filename: "team-handbook.md" }],
    [
      OWNED_BY_UPLOADER,
      { id: OWNED_BY_UPLOADER, projectId: PROJECT, userId: UPLOADER.id, filename: "uploader-private.md" },
    ],
  ]);
});

// ── Probe helpers: the two read surfaces, same question ──────────

/** Does `GET /api/knowledge-base?projectId=…` include this row for this user? */
async function listedFor(user: unknown, id: string): Promise<boolean> {
  const res = await call(
    kbList as any,
    createMockEvent({
      url: `http://localhost/api/knowledge-base?projectId=${PROJECT}`,
      user: user as any,
    }),
  );
  expect(res.status).toBe(200);
  const rows = (await res.json()) as Array<{ id: string }>;
  return rows.some(r => r.id === id);
}

/** Does `GET /api/knowledge-base/[id]` return the row for this user? */
async function detailReadableFor(user: unknown, id: string): Promise<boolean> {
  const res = await call(
    kbDetail as any,
    createMockEvent({
      url: `http://localhost/api/knowledge-base/${id}`,
      params: { id },
      user: user as any,
    }),
  );
  // Only 200 and 404 are legal outcomes on this path — anything else (403, 500)
  // means the probe measured something other than the ownership decision, and
  // silently coercing it to `false` would make the equivalence test vacuous.
  expect([200, 404]).toContain(res.status);
  return res.status === 200;
}

// ── (A) The load-bearing invariant: list and detail cannot disagree ──

describe("INVARIANT: KB list visibility and detail reachability are ONE contract", () => {
  const CALLERS: Array<{ label: string; user: unknown }> = [
    { label: "the uploader", user: UPLOADER },
    { label: "another member (not the uploader)", user: OTHER },
    { label: "an admin", user: ADMIN_USER },
  ];

  for (const { label, user } of CALLERS) {
    for (const id of [SHARED, OWNED_BY_UPLOADER]) {
      test(`${label} — \`${id}\`: listed === detail-readable`, async () => {
        const listed = await listedFor(user, id);
        const readable = await detailReadableFor(user, id);
        // The whole point of this suite. If a future change tightens the detail
        // GET on null owners, `listed` stays true while `readable` goes false
        // and this fails — that is the list-but-404 defect. If it tightens the
        // list filter instead, the mismatch fails the other way. Neither side
        // can move alone.
        expect({ id, listed, readable }).toEqual({ id, listed: readable, readable });
      });
    }
  }
});

// ── (A2) …and the agreed-on answer is the SHARED one ──────────────
//
// Equivalence alone would still be satisfied if BOTH sides were tightened to
// hide ownerless rows. These probes pin the direction the ruling chose.

describe("BEHAVIOUR: an ownerless row is shared with every authenticated caller", () => {
  test("a member who did not upload it sees it in the list", async () => {
    expect(await listedFor(OTHER, SHARED)).toBe(true);
  });

  test("…and can open it — no list-but-404", async () => {
    const res = await call(
      kbDetail as any,
      createMockEvent({
        url: `http://localhost/api/knowledge-base/${SHARED}`,
        params: { id: SHARED },
        user: OTHER as any,
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { filename: string }).filename).toBe("team-handbook.md");
  });

  test("the sharing is not admin-only — a plain member gets it too", async () => {
    // Reads carry no `user.role === "admin"` branch on either surface, unlike
    // DELETE. Pinned so the asymmetry reads as deliberate.
    expect(await listedFor(ADMIN_USER, SHARED)).toBe(true);
    expect(await detailReadableFor(ADMIN_USER, SHARED)).toBe(true);
    expect(await listedFor(OTHER, SHARED)).toBe(true);
    expect(await detailReadableFor(OTHER, SHARED)).toBe(true);
  });
});

describe("BEHAVIOUR: an OWNED row is still private on both surfaces", () => {
  test("a non-owner neither lists nor opens someone else's file", async () => {
    // Sharing is scoped to the null-owner row only. Widening it to owned rows
    // would be a cross-tenant read hole, not a sharing mechanism.
    expect(await listedFor(OTHER, OWNED_BY_UPLOADER)).toBe(false);
    expect(await detailReadableFor(OTHER, OWNED_BY_UPLOADER)).toBe(false);
  });

  test("the owner still lists and opens their own file", async () => {
    expect(await listedFor(UPLOADER, OWNED_BY_UPLOADER)).toBe(true);
    expect(await detailReadableFor(UPLOADER, OWNED_BY_UPLOADER)).toBe(true);
  });

  test("admins get NO read override on an owned file", async () => {
    // Deliberate and easy to misread: `DELETE` has an admin escape hatch, the
    // read surfaces do not. Both surfaces must agree here too.
    expect(await listedFor(ADMIN_USER, OWNED_BY_UPLOADER)).toBe(false);
    expect(await detailReadableFor(ADMIN_USER, OWNED_BY_UPLOADER)).toBe(false);
  });

  test("the private-file denial is a 404, not a 403 — no existence oracle", async () => {
    const forbidden = await call(
      kbDetail as any,
      createMockEvent({
        url: `http://localhost/api/knowledge-base/${OWNED_BY_UPLOADER}`,
        params: { id: OWNED_BY_UPLOADER },
        user: OTHER as any,
      }),
    );
    const missing = await call(
      kbDetail as any,
      createMockEvent({
        url: "http://localhost/api/knowledge-base/no-such-file",
        params: { id: "no-such-file" },
        user: OTHER as any,
      }),
    );
    expect(forbidden.status).toBe(404);
    expect(await forbidden.json()).toEqual(await missing.json());
  });
});

// ── (A3) The PREMISE: uploads can never mint a shared row by accident ──
//
// "Ownerless means shared" is only safe because ownerless rows cannot be
// produced through the API. If `POST` ever stopped stamping `userId`, every
// upload would silently become world-readable under the very rule this suite
// blesses. That premise was previously asserted in prose and pinned nowhere —
// the integration suite (`src/__tests__/kb-upload-integration.test.ts`) calls
// `insertKBFile` directly and never exercises the handler. Pinned here, next to
// the rule that depends on it.

describe("PREMISE: POST always stamps an owner, so the API cannot create a shared row", () => {
  async function upload(user: unknown): Promise<Response> {
    const fd = new FormData();
    fd.append("projectId", PROJECT);
    fd.append("file", new File(["# notes\n\nhello"], "notes.md", { type: "text/markdown" }));
    const req = new Request("http://localhost/api/knowledge-base", { method: "POST", body: fd });
    return call(kbUpload as any, {
      url: new URL("http://localhost/api/knowledge-base"),
      locals: { user },
      request: req,
    });
  }

  test("the inserted row carries the uploader's id, never null/undefined", async () => {
    const res = await upload(UPLOADER);
    expect(res.status).toBe(201);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.userId).toBe(UPLOADER.id);
  });

  test("…so a freshly uploaded file is PRIVATE on both read surfaces", async () => {
    // The end-to-end consequence, not just the column value: if the stamp were
    // dropped, this row would fall into the shared bucket and `OTHER` would see
    // it. Both surfaces are checked so the premise is guarded on the same two
    // predicates as the invariant above.
    const res = await upload(UPLOADER);
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;

    expect(await listedFor(UPLOADER, id)).toBe(true);
    expect(await detailReadableFor(UPLOADER, id)).toBe(true);
    expect(await listedFor(OTHER, id)).toBe(false);
    expect(await detailReadableFor(OTHER, id)).toBe(false);
  });
});

// ── (C) Sharing is read-only ─────────────────────────────────────

describe("BOUNDARY: shared-to-read is NOT shared-to-destroy", () => {
  test("a member who can READ the ownerless row still cannot DELETE it", async () => {
    // The failure mode this guards: someone reads the permissive list filter,
    // concludes null-owner rows are public, and "makes DELETE consistent".
    // Read and write are different axes; only read is shared.
    expect(await detailReadableFor(OTHER, SHARED)).toBe(true);

    const res = await call(
      kbDelete as any,
      createMockEvent({
        method: "DELETE",
        url: `http://localhost/api/knowledge-base/${SHARED}`,
        params: { id: SHARED },
        user: OTHER as any,
      }),
    );
    expect(res.status).toBe(404);
    expect(kbStore.has(SHARED)).toBe(true);
  });
});

// ── (B) Source-level pin: the intent must stay named ─────────────

describe("source: both read predicates carry the KB-SHARED-NULL-OWNER anchor", () => {
  const REPO_ROOT = resolve(import.meta.dir, "../../..");
  const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

  const LIST = "web/src/routes/api/knowledge-base/+server.ts";
  const DETAIL = "web/src/routes/api/knowledge-base/[id]/+server.ts";

  // Every token of the predicate is still required, in order — only the arrow
  // parameter's optional parens (`f =>` vs `(f) =>`) and whitespace may vary.
  // Dropping `!f.userId ||`, widening `===`, or swapping the operands all
  // still fail. See helpers/source-match.ts for why layout must not count.
  const LIST_FILTER =
    /files\.filter\(\(?f\)?\s*=>\s*!f\.userId\s*\|\|\s*f\.userId\s*===\s*user\.id\)/;

  test(`${LIST} — the list filter is annotated as deliberate sharing`, () => {
    const src = squish(read(LIST));
    expect(src).toContain("KB-SHARED-NULL-OWNER");
    // The anchor must sit with the predicate it explains, not drift to the top
    // of the file: the filter has to appear after it.
    const anchorAt = src.indexOf("KB-SHARED-NULL-OWNER");
    const filterAt = src.search(LIST_FILTER);
    expect(anchorAt).toBeGreaterThan(-1);
    expect(filterAt).toBeGreaterThan(anchorAt);
  });

  test(`${DETAIL} — the GET ownership check is annotated as deliberate sharing`, () => {
    const src = read(DETAIL);
    const getSlice = src.slice(src.indexOf("export const GET"), src.indexOf("export const DELETE"));
    // Sliced to GET so the DELETE handler's own (fail-closed) comment cannot
    // satisfy this by accident.
    expect(getSlice).toContain("KB-SHARED-NULL-OWNER");
    expect(getSlice).toMatch(/file\.userId\s*&&\s*file\.userId\s*!==\s*user\.id/);
  });

  test("both files point at THIS suite, so the pin is discoverable from the code", () => {
    const suite = "kb-ownerless-rows-are-shared";
    expect(read(LIST)).toContain(suite);
    expect(read(DETAIL)).toContain(suite);
  });

  test("the ownerless reclaim is ONE-SHOT — sharing now survives a restart", () => {
    // This was the durability caveat, and it has been resolved in the
    // sharing-is-real direction. `migrate()` still runs on every boot
    // (src/db/connection.ts), but the KB adoption no longer runs with it: it
    // moved out of migrate.ts into a marker-guarded module that fires once,
    // ever. So a file an operator makes ownerless stays ownerless — i.e. stays
    // shared — across restarts, which is what makes reason (1) above a real
    // mechanism rather than a race against the next redeploy.
    //
    // Two-sided pin, so neither half can regress quietly:
    //   - the raw statement must NOT be back inline in migrate.ts (that is the
    //     every-boot behaviour returning);
    //   - the guarded module must still be the thing migrate.ts calls.
    // Behaviour itself is proven by execution in
    // src/__tests__/db-migration-claim-ownerless-kb-once.test.ts.
    const migrateSrc = read("src/db/migrate.ts");
    expect(migrateSrc).not.toMatch(
      /UPDATE knowledge_base_files SET user_id = \(SELECT id FROM users WHERE role = 'admin'[^)]*\)\s*WHERE user_id IS NULL/,
    );
    expect(migrateSrc).toContain("upClaimOwnerlessKbFilesOnce(db)");

    const moduleSrc = read("src/db/migrations/claim-ownerless-kb-files-once.ts");
    // The guard is what makes it one-shot: the adoption is conditioned on the
    // marker row's absence, in the UPDATE's own WHERE.
    expect(moduleSrc).toMatch(/NOT EXISTS \(SELECT 1 FROM settings WHERE key = /);
  });

  test("the DELETE handler is NOT annotated as shared — writes stay fail-closed", () => {
    const src = read(DETAIL);
    const deleteSlice = src.slice(src.indexOf("export const DELETE"));
    expect(deleteSlice).not.toContain("KB-SHARED-NULL-OWNER");
    expect(deleteSlice).toMatch(/user\.role\s*!==\s*"admin"/);
  });
});
