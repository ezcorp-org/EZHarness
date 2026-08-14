/**
 * Wire-authorization — the SINGLE fail-closed decision point for
 * *"may this USER attach this EXTENSION to a conversation?"*.
 *
 * Distinct from the two neighbouring gates, and deliberately narrower than
 * either:
 *
 *   - The PDP (`src/extensions/permission-engine.ts`) governs what an
 *     extension MAY DO once it is running. It never asks who attached it.
 *   - `src/auth/extension-rbac.ts` governs the USER→extension axis
 *     (`use` / `configure` / `secrets` / `approve-runs` / `manage`). This
 *     module is a thin, single-purpose consumer of that resolver — it adds
 *     no new storage and no second notion of "allowed".
 *
 * ## Why the wire step needs a gate of its own
 *
 * Attaching an extension to a conversation is what makes its tools callable
 * by an LLM turn. Before this module the only checks on that step were
 * "do you own the conversation?" and "does your API key carry the
 * `extensions` scope" — nothing at all about the extension ROW. That is
 * fine for ordinary extensions (sandboxed code, every capability separately
 * PDP-gated), and it is NOT fine for an MCP extension:
 *
 *   - An MCP row is a stored CONNECTION to a third-party server plus the
 *     credential that authenticates to it. The credential lives in
 *     `extension_secrets` and is rehydrated host-side at connect time
 *     (`rehydrateMcpServerSecrets`), so it is never visible to the caller —
 *     but every tool call made through the wired extension SPENDS it.
 *   - Installing one is admin-only on BOTH axes (`requireAdmin` for the
 *     role plus `requireScope("admin")` for the key), precisely because it
 *     is instance state carrying auth material.
 *   - So wiring must not be weaker than installing. Otherwise any
 *     authenticated member could attach an admin-installed MCP server to
 *     their own chat and drive the admin's credential.
 *
 * ## The policy (fail-closed)
 *
 *   1. A BUNDLED row is always wire-able. First-party code, registered in
 *      `BUNDLED_EXTENSIONS`, capped by `bundled-ceiling.ts` and pinned by
 *      `manifest.lock.json` — code review is its approval gate, and it
 *      carries no admin-supplied credential.
 *   2. A NON-MCP extension is wire-able by anyone who cleared the caller's
 *      surface gate (conversation ownership + scope). Unchanged behaviour —
 *      this module deliberately does not narrow it. Narrowing every
 *      extension to the `use` scope would deny EVERY member EVERY extension
 *      on day one, because `extension_rbac_grants` is deny-by-default and
 *      no shipped instance has seeded grants.
 *   3. An MCP extension is wire-able by, and only by:
 *        a. an instance ADMIN — resolved through the `RBAC_ALL_SCOPES`
 *           sentinel with no DB hit;
 *        b. the row's own `creatorUserId` — the admin who installed it.
 *           A NULL creator (every row predating the install-time stamp)
 *           is therefore ADMIN-ONLY, which is the same reading the
 *           `creatorUserId` schema comment already fixes for `modifiable`:
 *           *"pre-existing rows are NULL and are therefore never
 *           user-modifiable (admins can still act)"*;
 *        c. a member holding the {@link MCP_WIRE_SCOPE} (`mcp-wire`) grant
 *           at the conversation's (project, extension) coordinates.
 *   4. Anything that prevents a decision — no acting user, an inactive or
 *      deleted user, a throwing grants lookup — DENIES. Same posture as the
 *      PDP's `override-lookup-failed` deny.
 *
 * Rung (c) reuses the `extension_rbac_grants` STORAGE but not its existing
 * vocabulary: the verb is the dedicated `mcp-wire`, never `use` — see
 * {@link MCP_WIRE_SCOPE} for why conflating them would have retro-authorized
 * every pre-existing grant, wildcard rows included. It cannot widen anything
 * by accident: the table is deny-by-default, and `canManageGrant` lets only
 * an admin (or a delegated `manage` holder, who can never mint `manage`
 * itself) write a row. Without the rung, the only way to let one member drive
 * one MCP server is to make them an instance admin, which is strictly worse.
 * Every grant write is itself audited (`RBAC_GRANTED` / `RBAC_REVOKED`).
 *
 * ## This gate is asked at THREE seams, not one
 *
 * "Wired into a conversation" is not the only way an MCP tool reaches a
 * dispatch. All three of these ask this same function:
 *
 *   1. `POST /api/conversations/[id]/extensions` — the typed wire route.
 *   2. `![ext:…]` / `![agent:…]` mention wiring.
 *   3. `POST /api/tool-invoke` — direct dispatch, which never consulted
 *      `conversation_extensions` at all, and `getToolsForAgent` at the
 *      stream-chat 2b branch, which attaches an agent config's `extensions[]`
 *      straight from the registry.
 *
 * Seam 3 is why gating only the wire step was cosmetic: discovery is free
 * (`GET /api/extensions` is read+auth), so a member could name the tool
 * directly and never wire anything.
 *
 * ## What callers must do on a denial
 *
 * A denial is never reported as a distinct outcome. Both call sites fold it
 * into the shape they already use for a name that does not exist:
 *
 *   - `POST /api/conversations/[id]/extensions` returns its existing
 *     `404 {error, unknown}` with the denied name in `unknown`, so a member
 *     cannot probe which MCP servers an admin has installed.
 *   - `![ext:…]` / `![agent:…]` mention wiring skips it silently, which is
 *     the binding mention-grammar contract for an unknown target
 *     (`docs/features/composer/mention-grammar.md`).
 *
 * Ref: `docs/features/extensions/permissions-and-grants.md` § "Wiring an
 * extension into a conversation".
 */
import { hasExtensionScope, type RbacUser } from "./extension-rbac";
import { getUserById } from "../db/queries/users";
import { getExtension } from "../db/queries/extensions";
import { logger } from "../logger";

const log = logger.child("auth.extension-wire-authz");

/**
 * The RBAC verb an MCP extension's wire step demands.
 *
 * NOT `use`. `use` means "may act with this extension" and is asked on
 * advisory rungs (github-projects poll-now / dashboard-data, the SDK's
 * `ctx.rbac.check`). Attaching an MCP extension is a different right — it
 * spends an admin-installed credential the holder never sees — and reusing
 * `use` for it would have retro-authorized every existing `use` grant. The
 * blast radius would not have been one grant either: `grantCovers` is
 * NULL-covers-all, so a single `(projectId: null, extensionId: null,
 * scopes: ["use"])` row satisfies the rung for EVERY MCP server on the
 * instance. A separate verb makes an operator say this, in these words,
 * on purpose.
 */
export const MCP_WIRE_SCOPE = "mcp-wire";

/**
 * The minimal extension-row shape the gate reads. Structurally satisfied by
 * a full `extensions` row; kept minimal so a caller holding a projection
 * (or a test fixture) can pass one without inventing columns.
 */
export type WirableExtension = {
  id: string;
  name: string;
  manifest?: unknown;
  source?: string | null;
  /** First-party code from `BUNDLED_EXTENSIONS`. Absent reads as false. */
  isBundled?: boolean | null;
  /** The user who installed the row. NULL on every row predating the
   *  install-time stamp — read as "no creator", never as "anyone". */
  creatorUserId?: string | null;
};

/**
 * The acting principal plus the PROJECT coordinate the decision is made at.
 *
 * `user: null` means the caller has no acting human — a background fire, a
 * system reconciler, or a lookup that failed. It is NOT "any user": it
 * denies every MCP candidate.
 *
 * A SPAWNED run is not that case. Sub-conversations inherit their ancestor's
 * owner at creation (`start-assignment.ts` stamps
 * `resolveConversationOwnerUserId(parent)`; `POST /api/conversations` stamps
 * `user.id` even with a `parentConversationId`), so a child resolves the same
 * principal as its parent and gets exactly the parent's reach — it inherits,
 * never acquires. Only a LEGACY pre-Wave-0 sub-conversation row carries a
 * null owner, and `migrate()` reassigns ownerless conversations to the first
 * admin at boot.
 *
 * `projectId` MUST be derived server-side (from the conversation row), never
 * taken from the wire — the same rule the tool-executor's
 * `resolveExtensionScopeGrant` follows. A `null` project checks at the
 * "all projects" coordinate, which only NULL-project grant rows cover.
 */
export type WireActor = {
  user: RbacUser | null;
  projectId: string | null;
};

/**
 * True when the row is an MCP-kind extension.
 *
 * Two independent host-written signals, either of which is sufficient:
 * `manifest.kind === "mcp"` (synthesized by `installMcpExtension`) and a
 * `source` of `mcp:<transport>` (written by both install and update). Both
 * are set by the same host code path, so agreeing on either is belt-and-
 * braces against a row whose manifest column is malformed or truncated —
 * the case where guessing wrong would silently drop the gate.
 */
export function isMcpExtension(ext: WirableExtension): boolean {
  if (typeof ext.source === "string" && ext.source.startsWith("mcp:")) return true;
  const manifest = ext.manifest;
  if (!manifest || typeof manifest !== "object") return false;
  return (manifest as { kind?: unknown }).kind === "mcp";
}

/**
 * Resolve a {@link WireActor} from a bare user id — for call sites (the
 * mention path) that carry the conversation's owner id but not their role.
 *
 * A `null` id short-circuits with no DB hit. An unknown id, an inactive
 * user, or a throwing read all resolve to `user: null`, which denies every
 * MCP candidate downstream.
 */
export async function loadWireActor(
  userId: string | null | undefined,
  projectId: string | null,
): Promise<WireActor> {
  if (!userId) return { user: null, projectId };
  try {
    const user = await getUserById(userId);
    if (!user) {
      log.warn("wire-authz: acting user not found — denying MCP wiring (fail-closed)", { userId });
      return { user: null, projectId };
    }
    if (user.status !== "active") {
      log.warn("wire-authz: acting user is not active — denying MCP wiring (fail-closed)", { userId });
      return { user: null, projectId };
    }
    return { user: { id: user.id, role: user.role }, projectId };
  } catch (err) {
    log.warn("wire-authz: user lookup failed — denying MCP wiring (fail-closed)", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { user: null, projectId };
  }
}

/**
 * The decision. See the module header for the policy; every failure mode
 * returns `false`.
 */
export async function canWireExtension(
  ext: WirableExtension,
  actor: WireActor,
): Promise<boolean> {
  // Rule 1 — bundled first-party code.
  if (ext.isBundled === true) return true;
  // Rule 2 — ordinary extensions keep today's behaviour.
  if (!isMcpExtension(ext)) return true;
  // Rule 4 — no resolvable principal, no decision, no wire.
  if (!actor.user) return false;
  // Rule 3a — instance admin.
  if (actor.user.role === "admin") return true;
  // Rule 3b — the admin who installed this row. A NULL creator matches
  // nobody: the comparison is against `actor.user.id`, which is a non-empty
  // string, so a legacy row stays admin-only without a special case.
  if (ext.creatorUserId && ext.creatorUserId === actor.user.id) return true;
  try {
    // Rule 3c. `extension_rbac_grants.extension_id` stores the manifest NAME
    // (the stable slug), never the row UUID — see the schema comment on the
    // column. Passing `ext.id` here would silently match nothing.
    return await hasExtensionScope(actor.user, {
      projectId: actor.projectId,
      extensionId: ext.name,
      scope: MCP_WIRE_SCOPE,
    });
  } catch (err) {
    log.warn("wire-authz: grant lookup failed — denying (fail-closed)", {
      extension: ext.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** The outcome of gating a batch: the rows that may be wired, and the NAMES
 *  of the ones that may not (names, because that is what both call sites
 *  report back — the route echoes them, the mention path drops them). */
export type WirePartition<T extends WirableExtension> = {
  allowed: T[];
  deniedNames: string[];
};

/**
 * Split a candidate set by {@link canWireExtension}, preserving input order.
 *
 * Sequential rather than concurrent on purpose: the batch is bounded (the
 * route's schema caps `names` at 20) and the common case — zero MCP
 * candidates — costs zero queries, because rule 1 short-circuits before the
 * resolver is consulted.
 */
export async function partitionWirableExtensions<T extends WirableExtension>(
  candidates: readonly T[],
  actor: WireActor,
): Promise<WirePartition<T>> {
  const allowed: T[] = [];
  const deniedNames: string[] = [];
  for (const ext of candidates) {
    if (await canWireExtension(ext, actor)) allowed.push(ext);
    else deniedNames.push(ext.name);
  }
  return { allowed, deniedNames };
}

/**
 * The id-addressed form, for write-time validation of an author-supplied
 * extension list (`agent_configs.extensions`, sec: F3).
 *
 * Returns the ids the actor may NOT attach — an id that resolves to no row
 * is included, so a typo and a refusal read the same to the author. Order
 * follows the input; duplicates collapse.
 *
 * This is the FAIL-FAST half of the F3 fix. The runtime half (the
 * `allowExtension` hook on `registry.getToolsForAgent`) is the one that
 * actually protects the credential — it re-decides every turn, so a config
 * that was legal when written but whose grant was since revoked stops
 * working immediately. Validating at write time exists so the author gets a
 * clear 400 instead of an agent that silently has fewer tools than it says.
 */
export async function findUnauthorizedExtensionIds(
  extensionIds: readonly string[],
  actor: WireActor,
): Promise<string[]> {
  const denied: string[] = [];
  for (const id of [...new Set(extensionIds)]) {
    let row: Awaited<ReturnType<typeof getExtension>> = null;
    try {
      row = await getExtension(id);
    } catch (err) {
      log.warn("wire-authz: extension lookup failed — denying (fail-closed)", {
        extensionId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!row || !(await canWireExtension(row, actor))) denied.push(id);
  }
  return denied;
}
