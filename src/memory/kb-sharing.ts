/**
 * Who may share a knowledge-base file with the project, and who may take it
 * back — the whole rule, in one pure module.
 *
 * ── Why this is its own file ─────────────────────────────────────────────────
 *
 * The rule has TWO consumers and they must not disagree:
 *
 *   - `web/src/routes/api/knowledge-base/[id]/share/+server.ts` ENFORCES it;
 *   - `web/src/routes/api/knowledge-base/+server.ts` (list) ADVERTISES it, as
 *     the `canShare` / `canUnshare` booleans the UI renders its buttons from.
 *
 * A second, hand-copied version of the predicate in the list route is how you
 * get a Share button that 403s, or worse, a hidden button on an action the
 * server would have allowed. Both call the same functions here, so the
 * affordance and the gate are the same sentence.
 *
 * Nothing in this module touches the database or the request. Membership is
 * passed IN as a boolean, resolved once per request by `checkProjectRole`, so
 * the decision stays testable without a DB and the list route pays one lookup
 * for a whole page of files rather than one per row.
 *
 * ── The mechanism this is built on (do not re-litigate here) ─────────────────
 *
 * `user_id IS NULL` **is** "shared" — anchor `KB-SHARED-NULL-OWNER`, canonical
 * rationale in `web/src/routes/api/knowledge-base/+server.ts`. Sharing a file
 * means nulling its owner; that single predicate is honoured by the list, the
 * detail route, and retrieval (`searchKBChunks` / `hasKBChunks`, anchor
 * `KB-RETRIEVAL-FOLLOWS-API`) alike. This module ADDS NO NEW ACCESS SIGNAL: it
 * decides who may perform the transition, never who may read the result.
 *
 * `sharedBy` is provenance and nothing else. It is read here only to answer
 * "give it back to whom?", and it never appears in a visibility predicate.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * | verb      | who | why |
 * |-----------|-----|-----|
 * | share     | the file's CURRENT OWNER, who is also a member of its project | it is their document; disclosure is theirs to make |
 * | un-share  | the user who SHARED it, or an instance admin | de-escalation, and it returns the file to its original owner |
 *
 * Three exclusions are deliberate and each closes a specific hole:
 *
 *  1. **Other project members may not share your file.** Sharing changes whose
 *     chat turns a document is injected into. Letting a member publish a
 *     document they do not own would re-open the exact confidentiality defect
 *     that scoping retrieval to `user_id IS NULL OR user_id = <caller>` closed
 *     (`src/__tests__/security/kb-retrieval-is-user-scoped.test.ts`).
 *
 *  2. **Instance admins get NO share override.** This is the one that looks
 *     wrong and is not. An admin cannot READ another user's KB file — `GET
 *     /api/knowledge-base/[id]` 404s them and retrieval gives them nothing,
 *     both pinned by that same suite. An admin share would therefore publish,
 *     to every member of the project, a document the admin is not permitted to
 *     open and so cannot have reviewed. Admins keep the powers they had:
 *     DELETE (sec-H3) destroys, and destruction discloses nothing.
 *
 *  3. **A non-member owner may not share.** Neither KB read route checks
 *     project membership, so an outsider who can name a `projectId` can upload
 *     to it. If sharing did not check membership, that outsider could then
 *     inject arbitrary text into every real member's prompt — a
 *     prompt-injection path from outside the project. `project_members` (PR
 *     #89) is the membership model; `checkProjectRole(locals, projectId,
 *     "member")` is the gate, and its instance-admin bypass is harmless here
 *     because rule 1 has already required the caller to own the file.
 *
 * Un-share admits admins where share does not, and the asymmetry is the point:
 * un-sharing only ever NARROWS who can see a file, and it restores the file to
 * `sharedBy` — never to the actor. So an admin cannot use it to take anything;
 * they can only undo a disclosure. That is the escape hatch for "someone shared
 * confidential material and has since left".
 *
 * A shared row whose `sharedBy` is null (a legacy operator-written row, or one
 * whose sharer's account was deleted) is un-shareable by NOBODY, admins
 * included. There is no owner to restore, and picking one would be inventing an
 * owner for a stranger's document.
 */

/** The fields of a `knowledge_base_files` row this decision reads. */
export interface ShareableKBFile {
  /** `null` means SHARED. The one access signal; see `KB-SHARED-NULL-OWNER`. */
  userId: string | null;
  /** Provenance only — who to hand the file back to. Never a read predicate. */
  sharedBy: string | null;
  /** Nullable in the schema: a KB file need not belong to a project. */
  projectId: string | null;
}

/** The authenticated caller, as `requireAuth` returns them. */
export interface ShareActor {
  id: string;
  role: string;
}

/**
 * Is this file shared with the project?
 *
 * The single source of truth for reading the signal, so no consumer writes
 * `!file.userId` (which also fires on `""`) or `file.userId === undefined`
 * (which misses a real SQL NULL) by hand.
 */
export function isKBFileShared(file: ShareableKBFile): boolean {
  return file.userId === null || file.userId === undefined;
}

/**
 * May `actor` share this file with its project?
 *
 * `isProjectMember` is resolved by the caller from `checkProjectRole(locals,
 * file.projectId, "member")` — passed in rather than fetched so this stays
 * pure and so the list route can resolve it once for a whole page.
 */
export function canShareKBFile(
  file: ShareableKBFile,
  actor: ShareActor,
  isProjectMember: boolean,
): boolean {
  if (isKBFileShared(file)) return false; // already shared; nothing to do
  if (file.userId !== actor.id) return false; // owner only — no admin override
  if (!file.projectId) return false; // no project to share WITH
  return isProjectMember;
}

/**
 * May `actor` take this file back out of the project?
 *
 * Note there is no membership term. Un-sharing narrows exposure and hands the
 * file to `sharedBy`, so requiring the actor to still be a member would only
 * strand a file whose sharer was removed from the project — with no upside,
 * since the action cannot disclose anything.
 */
export function canUnshareKBFile(file: ShareableKBFile, actor: ShareActor): boolean {
  if (!isKBFileShared(file)) return false; // not shared; nothing to undo
  if (!file.sharedBy) return false; // nobody to give it back to — fail closed
  return file.sharedBy === actor.id || actor.role === "admin";
}

/** The sharing facts the list route appends to each row for the UI. */
export interface KBSharingView {
  /** Is it shared with the project right now? */
  shared: boolean;
  /** Was it `actor` who shared it? Drives the "Shared by you" attribution. */
  sharedByYou: boolean;
  /** Would `POST /api/knowledge-base/[id]/share` succeed for `actor`? */
  canShare: boolean;
  /** Would `DELETE /api/knowledge-base/[id]/share` succeed for `actor`? */
  canUnshare: boolean;
}

/**
 * The whole sharing state of one row, from the caller's point of view.
 *
 * The list route spreads this onto each file so the client renders buttons
 * from the server's own answer instead of re-deriving the rule (and so it
 * never needs another user's id to do it).
 */
export function describeKBFileSharing(
  file: ShareableKBFile,
  actor: ShareActor,
  isProjectMember: boolean,
): KBSharingView {
  const shared = isKBFileShared(file);
  return {
    shared,
    sharedByYou: shared && file.sharedBy === actor.id,
    canShare: canShareKBFile(file, actor, isProjectMember),
    canUnshare: canUnshareKBFile(file, actor),
  };
}
