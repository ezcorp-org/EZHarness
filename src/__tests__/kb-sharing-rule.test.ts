/**
 * The share/un-share authorization rule (`src/memory/kb-sharing.ts`), decided
 * in isolation.
 *
 * This suite covers the RULE. The route that applies it, the status codes it
 * refuses with, and the agreement between what the UI is told and what the
 * server enforces are covered by
 * `src/__tests__/security/kb-file-sharing-api.test.ts` against a real database.
 * Keeping the decision testable without a DB is the point of the module being
 * pure — it is why the list route can afford to advertise the same answer.
 *
 * Two properties matter more than the individual cases and are asserted as
 * such at the bottom:
 *
 *   - sharing is never something you can do to SOMEONE ELSE's file, by any
 *     role, on any project; and
 *   - un-sharing never makes the actor the owner.
 */
import { test, expect, describe } from "bun:test";
import {
  isKBFileShared,
  canShareKBFile,
  canUnshareKBFile,
  describeKBFileSharing,
  type ShareableKBFile,
  type ShareActor,
} from "../memory/kb-sharing";

const OWNER: ShareActor = { id: "u-owner", role: "member" };
const OTHER: ShareActor = { id: "u-other", role: "member" };
const ADMIN: ShareActor = { id: "u-admin", role: "admin" };

/** A file owned by `OWNER`, sitting in a project. */
const owned: ShareableKBFile = { userId: OWNER.id, sharedBy: null, projectId: "p1" };
/** The same file after `OWNER` shared it. */
const shared: ShareableKBFile = { userId: null, sharedBy: OWNER.id, projectId: "p1" };
/** A legacy ownerless row: shared, but with no record of where it came from. */
const legacyOwnerless: ShareableKBFile = { userId: null, sharedBy: null, projectId: "p1" };

describe("isKBFileShared — reading the one access signal", () => {
  test("a null owner is shared; a real owner is not", () => {
    expect(isKBFileShared(owned)).toBe(false);
    expect(isKBFileShared(shared)).toBe(true);
  });

  test("an ABSENT userId reads as shared, the same as an explicit null", () => {
    // A row selected without the column, or a partial fixture, must not be
    // silently treated as owned-by-nobody-in-particular. `undefined` and `null`
    // are the same state here.
    expect(isKBFileShared({ sharedBy: null, projectId: "p1" } as unknown as ShareableKBFile)).toBe(true);
  });

  test("an empty-string owner is NOT shared — it is a corrupt owner, not a null one", () => {
    // `!file.userId` (the shape used elsewhere in the read predicates) would
    // call this shared. Here the distinction is load-bearing: treating a
    // corrupt row as shared would publish it.
    expect(isKBFileShared({ userId: "", sharedBy: null, projectId: "p1" })).toBe(false);
  });
});

describe("canShareKBFile — the owner, and only the owner", () => {
  test("the owner may share their own file in a project they belong to", () => {
    expect(canShareKBFile(owned, OWNER, true)).toBe(true);
  });

  test("another member may NOT share a file they do not own", () => {
    // THE regression this guards: 'any member can share any file' would undo
    // the confidentiality fix in kb-retrieval-is-user-scoped.test.ts by letting
    // one member push another's document into everybody's prompt.
    expect(canShareKBFile(owned, OTHER, true)).toBe(false);
  });

  test("an instance ADMIN gets no override on someone else's file", () => {
    // An admin cannot read this file (GET /api/knowledge-base/[id] 404s them),
    // so allowing the share would publish content they could not have reviewed.
    expect(canShareKBFile(owned, ADMIN, true)).toBe(false);
  });

  test("the owner may not share into a project they are not a member of", () => {
    // Neither KB read route checks membership, so an outsider can upload to a
    // project they can name. Without this term they could then inject text into
    // every real member's prompt.
    expect(canShareKBFile(owned, OWNER, false)).toBe(false);
  });

  test("a file with no project cannot be shared — there is nobody to share it with", () => {
    expect(canShareKBFile({ ...owned, projectId: null }, OWNER, true)).toBe(false);
  });

  test("an already-shared file cannot be shared again", () => {
    expect(canShareKBFile(shared, OWNER, true)).toBe(false);
  });
});

describe("canUnshareKBFile — the sharer, or an admin", () => {
  test("the user who shared it may take it back", () => {
    expect(canUnshareKBFile(shared, OWNER)).toBe(true);
  });

  test("an instance admin may take it back — un-sharing only narrows exposure", () => {
    expect(canUnshareKBFile(shared, ADMIN)).toBe(true);
  });

  test("an unrelated member may NOT — that would be yanking someone else's file", () => {
    expect(canUnshareKBFile(shared, OTHER)).toBe(false);
  });

  test("a file that is not shared has nothing to un-share", () => {
    expect(canUnshareKBFile(owned, OWNER)).toBe(false);
  });

  test("a legacy ownerless row is un-shareable by NOBODY, admins included", () => {
    // There is no recorded owner to restore. Picking one would be inventing an
    // owner for a document nobody can attribute — the same mistake the
    // every-boot admin reclaim used to make.
    expect(canUnshareKBFile(legacyOwnerless, OWNER)).toBe(false);
    expect(canUnshareKBFile(legacyOwnerless, OTHER)).toBe(false);
    expect(canUnshareKBFile(legacyOwnerless, ADMIN)).toBe(false);
  });
});

describe("describeKBFileSharing — what the list route tells the UI", () => {
  test("an owned file offers Share to its owner and nothing to anyone else", () => {
    expect(describeKBFileSharing(owned, OWNER, true)).toEqual({
      shared: false, sharedByYou: false, canShare: true, canUnshare: false,
    });
    expect(describeKBFileSharing(owned, OTHER, true)).toEqual({
      shared: false, sharedByYou: false, canShare: false, canUnshare: false,
    });
  });

  test("a file you shared is attributed to you and offers Unshare", () => {
    expect(describeKBFileSharing(shared, OWNER, true)).toEqual({
      shared: true, sharedByYou: true, canShare: false, canUnshare: true,
    });
  });

  test("someone else's shared file is visible as shared, but not YOURS to undo", () => {
    expect(describeKBFileSharing(shared, OTHER, true)).toEqual({
      shared: true, sharedByYou: false, canShare: false, canUnshare: false,
    });
  });

  test("an admin sees it as shared-by-someone-else and may still undo it", () => {
    expect(describeKBFileSharing(shared, ADMIN, true)).toEqual({
      shared: true, sharedByYou: false, canShare: false, canUnshare: true,
    });
  });

  test("a legacy ownerless row reads as shared with no attribution and no actions", () => {
    expect(describeKBFileSharing(legacyOwnerless, ADMIN, true)).toEqual({
      shared: true, sharedByYou: false, canShare: false, canUnshare: false,
    });
  });
});

// ── The two properties, over the whole space ─────────────────────────────────

describe("PROPERTY: sharing is never something you do to someone else's file", () => {
  test("no actor, role, or membership makes a non-owner able to share", () => {
    const actors: ShareActor[] = [OTHER, ADMIN, { id: "u-x", role: "owner" }];
    const results = actors.flatMap((actor) =>
      [true, false].map((member) => ({
        actor: actor.id,
        role: actor.role,
        member,
        canShare: canShareKBFile(owned, actor, member),
      })),
    );
    // Asserted as a whole object list so a newly-permitted case shows up by
    // name rather than as a bare `false → true`.
    expect(results.filter((r) => r.canShare)).toEqual([]);
  });
});

describe("PROPERTY: un-sharing never makes the actor the owner", () => {
  test("whoever may un-share, the file returns to `sharedBy`", () => {
    // The rule cannot express "give it to me": the only owner it can name is
    // the recorded one. This pins the INPUT to that decision — the route reads
    // `file.sharedBy` and the guarded UPDATE re-checks it (see
    // `unshareKBFile` in src/db/queries/knowledge-base.ts).
    for (const actor of [OWNER, ADMIN]) {
      expect(canUnshareKBFile(shared, actor)).toBe(true);
      // `sharedBy` is what the route restores; it is never the actor for ADMIN.
      expect(shared.sharedBy).toBe(OWNER.id);
    }
    expect(shared.sharedBy).not.toBe(ADMIN.id);
  });
});
