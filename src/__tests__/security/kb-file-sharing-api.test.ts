/**
 * `POST` / `DELETE /api/knowledge-base/[id]/share` — the verb that finally lets
 * a user create the ownerless row `KB-SHARED-NULL-OWNER` has always described.
 *
 * ── What is being guarded ────────────────────────────────────────────────────
 *
 * Sharing changes whose chat turns a document is injected into. This route is
 * therefore built on the same surface a confidentiality fix just landed on
 * (`kb-retrieval-is-user-scoped.test.ts`), and the failure mode to prevent is
 * not "the button does not work" — it is "a member published a document that
 * was not theirs". So the suite is written owner-first:
 *
 *   share    → the file's CURRENT OWNER, who is a member of its project.
 *              NOT other members. NOT instance admins.
 *   un-share → the user who SHARED it, or an instance admin — and it always
 *              restores the file to `shared_by`, never to the actor.
 *
 * Everything below runs the REAL handler against a REAL PGlite. The decision
 * module is not stubbed, so what this suite proves about the route is the same
 * thing `kb-sharing-rule.test.ts` proves about the rule.
 *
 * ── The property that makes it more than a table of status codes ─────────────
 *
 * `describeKBFileSharing` is what the list route sends the UI as
 * `canShare` / `canUnshare`. If the advertised answer and the enforced answer
 * ever diverge you get a button that 403s, or — worse — a hidden button on an
 * action the server would have allowed, which is how a "nobody can share"
 * regression hides in plain sight. The last describe block walks every
 * (caller × file) pair and asserts ADVERTISED === ENFORCED by executing both.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "../helpers/test-pglite";
import { mockEmbeddingsModule } from "../helpers/mock-vectors";
import { mockServerAlias, createMockEvent } from "../helpers/mock-request";

mockDbConnection();
mockEmbeddingsModule();
mockServerAlias();

mock.module("../../../web/src/routes/api/knowledge-base/[id]/share/$types", () => ({}));
mock.module("../../../web/src/routes/api/knowledge-base/$types", () => ({}));

// Aliases the backend test runner cannot resolve on its own. Every one of these
// points at the REAL implementation (the embedder excepted, which the list
// route only drags in for the upload path) so nothing about the gates is faked.
mock.module("$lib/server/http-errors", () =>
  require("../../../web/src/lib/server/http-errors"),
);
mock.module("$lib/server/security/api-keys", () =>
  require("../../../web/src/lib/server/security/api-keys"),
);
mock.module("$lib/server/security/resource-quotas", () =>
  require("../../../web/src/lib/server/security/resource-quotas"),
);
mock.module("$server/memory/chunking", () => require("../../memory/chunking"));
mock.module("$server/memory/embeddings", () => require("../../memory/embeddings"));
mock.module("$server/logger", () => require("../../logger"));

const realKbQueries = await import("../../db/queries/knowledge-base");

/**
 * A hook that fires ONCE, immediately after the route's `getKBFile` read and
 * before its guarded UPDATE — i.e. exactly in the window a concurrent request
 * would land in. Used to drive the two "lost the race" branches with a REAL
 * competing write rather than a stubbed return value; every other call in this
 * file goes straight to the real query layer.
 */
let raceHook: (() => Promise<void>) | null = null;
mock.module("$server/db/queries/knowledge-base", () => ({
  ...realKbQueries,
  getKBFile: async (id: string) => {
    const row = await realKbQueries.getKBFile(id);
    if (raceHook) {
      const hook = raceHook;
      raceHook = null;
      await hook();
    }
    return row;
  },
}));

const { insertKBFile, getKBFile, shareKBFile, unshareKBFile } = realKbQueries;
const { createProject } = await import("../../db/queries/projects");
const { createUser } = await import("../../db/queries/users");
const { upsertProjectMember, removeProjectMember } = await import(
  "../../db/queries/project-members"
);
const { POST: share, DELETE: unshare } = await import(
  "../../../web/src/routes/api/knowledge-base/[id]/share/+server"
);
const { GET: kbList } = await import("../../../web/src/routes/api/knowledge-base/+server");

type User = { id: string; email: string; name: string; role: "member" | "admin" };

let projectId: string;
let owner: User;
let other: User;
let admin: User;
let outsider: User;

async function makeFile(userId: string | null, project: string | null = projectId) {
  return insertKBFile({
    filename: "handbook.md",
    mimeType: "text/markdown",
    fileSize: 16,
    ...(project ? { projectId: project } : {}),
    ...(userId ? { userId } : {}),
  });
}

/** Call the share/un-share handler the way SvelteKit would. */
async function call(
  handler: unknown,
  id: string,
  user: User | undefined,
  locals: Record<string, unknown> = {},
): Promise<Response> {
  const event = createMockEvent({
    url: `http://localhost/api/knowledge-base/${id}/share`,
    params: { id },
    user: user as never,
  });
  Object.assign(event.locals, locals);
  try {
    return (await (handler as (e: unknown) => Promise<Response>)(event)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

beforeAll(async () => {
  await setupTestDb();
  projectId = (await createProject({ name: "kb-share", path: "/tmp/kb-share" })).id;

  const mk = async (email: string, name: string, role: User["role"]) =>
    (await createUser({ email, name, passwordHash: "x", role })) as User;
  owner = await mk("owner@test.local", "Owner", "member");
  other = await mk("other@test.local", "Other", "member");
  admin = await mk("admin@test.local", "Admin", "admin");
  outsider = await mk("outsider@test.local", "Outsider", "member");

  for (const u of [owner, other]) await upsertProjectMember(projectId, u.id, "member");
});

beforeEach(() => {
  raceHook = null;
});

afterAll(async () => {
  await closeTestDb();
});

// ── Sharing ──────────────────────────────────────────────────────────────────

describe("POST — the owner, who is a project member, may share", () => {
  test("the owner's file becomes ownerless, with the owner recorded as the sharer", async () => {
    const file = await makeFile(owner.id);
    const res = await call(share, file.id, owner);
    expect(res.status).toBe(200);

    const row = await getKBFile(file.id);
    // `user_id IS NULL` IS the share — no second signal, so retrieval and both
    // read surfaces pick this up with no change of their own.
    expect(row!.userId).toBeNull();
    // …and `shared_by` remembers where it came from, which is the ONLY thing
    // that makes un-sharing authorizable at all.
    expect(row!.sharedBy).toBe(owner.id);
  });

  test("an instance admin may share a file that is genuinely their own", async () => {
    // `checkProjectRole` lets admins bypass MEMBERSHIP. That bypass is reached
    // only after the ownership test above has passed, so it can widen nothing.
    const file = await makeFile(admin.id);
    const res = await call(share, file.id, admin);
    expect(res.status).toBe(200);
    expect((await getKBFile(file.id))!.sharedBy).toBe(admin.id);
  });
});

describe("POST — everything that must NOT be able to share", () => {
  test("another project member gets 404 on a file they do not own", async () => {
    const file = await makeFile(owner.id);
    const res = await call(share, file.id, other);
    // 404, not 403: `other` cannot read this row through `GET [id]` either, so
    // the refusal must not confirm that it exists.
    expect(res.status).toBe(404);
    expect((await getKBFile(file.id))!.userId).toBe(owner.id);
  });

  test("an INSTANCE ADMIN gets 404 on someone else's file — no override", async () => {
    // The load-bearing one. An admin cannot read this file, so an admin share
    // would publish a document they are not permitted to open.
    const file = await makeFile(owner.id);
    const res = await call(share, file.id, admin);
    expect(res.status).toBe(404);
    expect((await getKBFile(file.id))!.userId).toBe(owner.id);
  });

  test("a non-member owner gets 403 — you cannot publish into a project you are not in", async () => {
    // Neither KB read route checks membership, so an outsider CAN upload here.
    // Without this gate they could then inject text into every member's prompt.
    const file = await makeFile(outsider.id);
    const res = await call(share, file.id, outsider);
    expect(res.status).toBe(403);
    expect((await getKBFile(file.id))!.userId).toBe(outsider.id);
  });

  test("a file with no project is 409 — there is nobody to share it with", async () => {
    const file = await makeFile(owner.id, null);
    const res = await call(share, file.id, owner);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "File is not attached to a project" });
  });

  test("an already-shared file is 409, not a silent re-share", async () => {
    const file = await makeFile(owner.id);
    await call(share, file.id, owner);
    const res = await call(share, file.id, owner);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "File is already shared" });
    // The original sharer is not overwritten by the second attempt.
    expect((await getKBFile(file.id))!.sharedBy).toBe(owner.id);
  });

  test("a missing file is 404", async () => {
    expect((await call(share, "kb-does-not-exist", owner)).status).toBe(404);
  });

  test("an unauthenticated caller is 401 before any row is read", async () => {
    const file = await makeFile(owner.id);
    expect((await call(share, file.id, undefined)).status).toBe(401);
  });

  test("an API key without the write scope is 403", async () => {
    const file = await makeFile(owner.id);
    const res = await call(share, file.id, owner, { apiKeyScopes: ["read"] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "Insufficient scope", required: "write" });
  });

  test("losing the race to a concurrent delete writes nothing and 404s", async () => {
    // A REAL competing write (`DELETE /api/knowledge-base/[id]`), landing
    // between the route's read and its UPDATE. The ownership test lives in the
    // UPDATE's own WHERE, so a decision that has gone stale cannot resurrect a
    // row — or, in the ownership-change case, publish one whose owner moved.
    const file = await makeFile(owner.id);
    raceHook = async () => {
      await realKbQueries.deleteKBFile(file.id);
    };
    const res = await call(share, file.id, owner);
    expect(res.status).toBe(404);
    expect(await getKBFile(file.id)).toBeUndefined();
  });
});

// ── Un-sharing ───────────────────────────────────────────────────────────────

describe("DELETE — the sharer, or an admin, may take it back", () => {
  test("the sharer gets their file back and the provenance is cleared", async () => {
    const file = await makeFile(owner.id);
    await call(share, file.id, owner);

    const res = await call(unshare, file.id, owner);
    expect(res.status).toBe(200);
    const row = await getKBFile(file.id);
    expect(row!.userId).toBe(owner.id);
    expect(row!.sharedBy).toBeNull();
  });

  test("an admin may un-share — and the file goes to its ORIGINAL owner, not to the admin", async () => {
    // The whole reason admins are admitted here and refused on POST:
    // un-sharing only narrows exposure, and it cannot be used to take a file.
    const file = await makeFile(owner.id);
    await call(share, file.id, owner);

    const res = await call(unshare, file.id, admin);
    expect(res.status).toBe(200);
    const row = await getKBFile(file.id);
    expect(row!.userId).toBe(owner.id);
    expect(row!.userId).not.toBe(admin.id);
  });
});

describe("DELETE — everything that must NOT be able to un-share", () => {
  test("an unrelated member gets 403, and the file stays shared", async () => {
    const file = await makeFile(owner.id);
    await call(share, file.id, owner);

    const res = await call(unshare, file.id, other);
    // 403 rather than 404 here on purpose: the row is SHARED, so `other` can
    // already read it. There is no existence to protect, and a 404 would just
    // lie about a file sitting in their own list.
    expect(res.status).toBe(403);
    expect((await getKBFile(file.id))!.userId).toBeNull();
  });

  test("a member cannot STEAL a shared file by un-sharing it to themselves", async () => {
    // The failure mode that forced `shared_by` to exist. Without provenance the
    // only implementable un-share is "give it to whoever clicked", which is an
    // ownership takeover: the thief becomes the sole reader and the sole
    // deleter, and the real owner gets a 404 on their own document.
    const file = await makeFile(owner.id);
    await call(share, file.id, owner);
    await call(unshare, file.id, other);

    const row = await getKBFile(file.id);
    expect(row!.userId).not.toBe(other.id);
    expect(row!.sharedBy).toBe(owner.id);
  });

  test("a legacy ownerless row (no recorded sharer) is un-shareable by nobody, admin included", async () => {
    // Rows that were already ownerless before this shipped have no recoverable
    // owner. Deliberately NOT backfilled, so they fail closed rather than being
    // handed to whoever asks first.
    const file = await makeFile(null);
    for (const actor of [owner, other, admin]) {
      const res = await call(unshare, file.id, actor);
      expect({ actor: actor.name, status: res.status }).toEqual({
        actor: actor.name,
        status: 403,
      });
    }
    expect((await getKBFile(file.id))!.userId).toBeNull();
  });

  test("your own file that is not shared is 409 — an honest 'nothing to undo'", async () => {
    const file = await makeFile(owner.id);
    const res = await call(unshare, file.id, owner);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "File is not shared" });
  });

  test("someone ELSE's unshared file is 404, never a 'not shared' existence oracle", async () => {
    const file = await makeFile(owner.id);
    const res = await call(unshare, file.id, other);
    expect(res.status).toBe(404);
  });

  test("a missing file is 404", async () => {
    expect((await call(unshare, "kb-nope", owner)).status).toBe(404);
  });

  test("an unauthenticated caller is 401", async () => {
    const file = await makeFile(owner.id);
    await call(share, file.id, owner);
    expect((await call(unshare, file.id, undefined)).status).toBe(401);
  });

  test("an API key without the write scope is 403", async () => {
    const file = await makeFile(owner.id);
    const res = await call(unshare, file.id, owner, { apiKeyScopes: ["read"] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ required: "write" });
  });

  test("losing the race to a concurrent un-share writes nothing and 404s", async () => {
    const file = await makeFile(owner.id);
    await call(share, file.id, owner);
    raceHook = async () => {
      // Someone else's request gets there first.
      await unshareKBFile(file.id, owner.id);
    };
    const res = await call(unshare, file.id, owner);
    expect(res.status).toBe(404);
    // The winner's result stands; the loser did not write over it.
    const row = await getKBFile(file.id);
    expect(row!.userId).toBe(owner.id);
    expect(row!.sharedBy).toBeNull();
  });
});

// ── Membership is read live, not at upload time ──────────────────────────────

describe("the project-membership term tracks the membership table", () => {
  test("a member who is removed from the project loses the ability to share", async () => {
    const transient = (await createUser({
      email: "transient@test.local", name: "Transient", passwordHash: "x", role: "member",
    })) as User;
    await upsertProjectMember(projectId, transient.id, "member");

    const a = await makeFile(transient.id);
    expect((await call(share, a.id, transient)).status).toBe(200);

    await removeProjectMember(projectId, transient.id);
    const b = await makeFile(transient.id);
    expect((await call(share, b.id, transient)).status).toBe(403);
  });
});

// ── ADVERTISED === ENFORCED ──────────────────────────────────────────────────

/** The list route's own answer for one row, as the UI receives it. */
async function advertisedFor(user: User, id: string) {
  const res = (await (kbList as unknown as (e: unknown) => Promise<Response>)(
    createMockEvent({
      url: `http://localhost/api/knowledge-base?projectId=${projectId}`,
      user: user as never,
    }),
  )) as Response;
  expect(res.status).toBe(200);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return rows.find((r) => r.id === id);
}

describe("INVARIANT: the buttons the list route offers are exactly the actions the share route allows", () => {
  test("every (caller × file) pair agrees", async () => {
    // Both sides are EXECUTED — the left by the real `GET /api/knowledge-base`,
    // the right by the real share/un-share handler, against one PGlite. Neither
    // is replicated, so a rule that moved in one place and not the other shows
    // up here rather than as a button that 403s in front of a user.
    const ownedFile = await makeFile(owner.id);
    const sharedFile = await makeFile(owner.id);
    await call(share, sharedFile.id, owner);
    const legacyFile = await makeFile(null);

    const callers = [
      { label: "the owner", user: owner },
      { label: "another member", user: other },
      { label: "an admin", user: admin },
      { label: "a non-member", user: outsider },
    ];
    const files = [
      { label: "an owned file", id: ownedFile.id },
      { label: "a file the owner shared", id: sharedFile.id },
      { label: "a legacy ownerless row", id: legacyFile.id },
    ];

    for (const c of callers) {
      for (const f of files) {
        const row = (await getKBFile(f.id))!;
        const advertised = await advertisedFor(c.user, f.id);
        // A row the caller may not even SEE offers nothing, and the share route
        // must refuse it — that pair is checked below like any other.
        const canShare = advertised?.canShare === true;
        const canUnshare = advertised?.canUnshare === true;

        const shareAllowed = (await call(share, f.id, c.user)).ok;
        // Undo anything this probe performed, so the loop keeps examining the
        // state it declared rather than the state it caused.
        if (shareAllowed) await unshareKBFile(f.id, c.user.id);

        const unshareAllowed = (await call(unshare, f.id, c.user)).ok;
        if (unshareAllowed) await shareKBFile(f.id, row.sharedBy!);

        expect({
          caller: c.label, file: f.label, canShare, shareAllowed, canUnshare, unshareAllowed,
        }).toEqual({
          caller: c.label, file: f.label,
          canShare: shareAllowed, shareAllowed,
          canUnshare: unshareAllowed, unshareAllowed,
        });
      }
    }
  });

  test("the list marks a shared file as shared, and attributes it only to the person who shared it", async () => {
    const file = await makeFile(owner.id);
    expect(await advertisedFor(owner, file.id)).toMatchObject({ shared: false, sharedByYou: false });

    await call(share, file.id, owner);
    expect(await advertisedFor(owner, file.id)).toMatchObject({ shared: true, sharedByYou: true });
    // Visible to another member (that IS the sharing), but not attributed to them.
    expect(await advertisedFor(other, file.id)).toMatchObject({ shared: true, sharedByYou: false });
  });

  test("a non-member sees the shared file but is offered no Share button on their own upload", async () => {
    // The membership term, as the UI sees it: an outsider's own file in this
    // project carries `canShare: false`, so no dead button is ever drawn.
    const ownFile = await makeFile(outsider.id);
    expect(await advertisedFor(outsider, ownFile.id)).toMatchObject({
      shared: false, canShare: false, canUnshare: false,
    });
  });
});
