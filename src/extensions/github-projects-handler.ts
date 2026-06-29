/**
 * `ezcorp/github-projects.<verb>` reverse-RPC handler — bundled-only.
 *
 * The bundled `github-projects` extension's THIN ticket tools and its Hub
 * dashboard reverse-RPC into this handler. It is the ONLY place a board id, a
 * GitHub token, or a GitHub host ever appears for this feature — the sandboxed
 * subprocess sees none of them.
 *
 * Security invariants (see `src/integrations/github-projects/types.ts`):
 *   - BUNDLED-ONLY via `BUNDLED_GITHUB_PROJECTS_ALLOWLIST`, checked by the
 *     calling extension's NAME (host-resolved from the registry, never the
 *     wire). A user-installed look-alike that declares
 *     `custom.githubProjects` in its manifest is still refused.
 *   - projectId is derived SERVER-SIDE from the calling conversation. Params
 *     NEVER carry a board / project id (confused-deputy fix). A param named
 *     `projectId` / `boardId` / `linkId` on a TICKET verb is ignored.
 *   - The GitHub token is host-only: read from the scope-isolated secrets store
 *     (`getSecret`) for `pat`, or `gh auth token` for `gh`. Never logged, never
 *     returned.
 *   - Mutating ticket verbs (create/update/move/archive/comment) run through
 *     the PDP (`engine.authorize`) AND write an audit row — parity with the
 *     sibling spawn / append-message handlers' sensitive-op posture.
 *   - Control verbs (dashboard-data/approve/dismiss/pause/resume) are scoped to
 *     the VIEWING USER: dashboard-data returns only links the user created (and
 *     their proposals); approve/dismiss/pause/resume verify the user owns the
 *     proposal's / link's project before mutating. Never leak another user's
 *     boards or proposals.
 *
 * Verbs:
 *   Ticket (conversation-scoped):
 *     list({ status?, limit? })            → { items: [...] }
 *     create({ title, body?, statusName? }) → { ticket }
 *     update({ itemNodeId, title?, body? }) → { ticket }
 *     move({ itemNodeId, statusName })      → { ok: true }
 *     archive({ itemNodeId })               → { ok: true }
 *     comment({ itemNodeId, body })         → { ok: true }
 *   Control (viewing-user-scoped, Hub page):
 *     dashboard-data({})                    → { proposals, boards }
 *     approve({ proposalId })               → { ok, status }
 *     dismiss({ proposalId })               → { ok, status }
 *     pause({ linkId })                     → { ok, enabled: false }
 *     resume({ linkId })                    → { ok, enabled: true }
 */

import type { ExtensionPermissions, JsonRpcRequest, JsonRpcResponse } from "./types";
import { rpcError, rpcResult } from "./json-rpc";
import { extensionLogger } from "../logger";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection";
import { githubProjectsLinks } from "../db/schema";
import { getConversation } from "../db/queries/conversations";
import { insertAuditEntry } from "../db/queries/audit-log";
import { getSecret } from "./secrets-store";
import {
  GITHUB_ACTIVE_STATUSES,
  GITHUB_TERMINAL_STATUSES,
  type GithubAuth,
  type GithubBoardItem,
  type GithubProjectsRpcVerb,
} from "../integrations/github-projects/types";
import { createGithubClient } from "../integrations/github-projects/client";
import { getGithubProjectsDaemon } from "../integrations/github-projects/daemon";
import { boardTokenName } from "../integrations/github-projects/auth";
import { approveProposal, dismissProposal } from "../integrations/github-projects/spawn";
import {
  getLinkById,
  getProposalById,
  getProposalByConversationId,
  listLinksByProjectId,
  listProposalsByProject,
  setLinkEnabled,
} from "../db/queries/github-projects";
import type { GithubProjectsLink, GithubProjectsProposal } from "../db/schema";

const log = extensionLogger("github-projects", "handler");

/**
 * Bundled extensions allowed to use `ezcorp/github-projects.*`.
 *
 * SOLE gate — checked by extension NAME (not id, not manifest, not granted
 * permissions) so a compromised / look-alike manifest cannot widen it. Adding
 * an entry here is a security-relevant decision reviewed at the same level as a
 * `BUNDLED_CEILING` change.
 */
export const BUNDLED_GITHUB_PROJECTS_ALLOWLIST: ReadonlySet<string> = new Set([
  "github-projects",
]);

/** Audit action prefix for this feature (picked up by `action LIKE 'ext:%'`). */
const AUDIT_TICKET_MUTATE = "ext:github-projects:ticket-mutate";
const AUDIT_CONTROL = "ext:github-projects:control";

export interface GithubProjectsContext {
  /** Calling extension NAME (host-resolved from the registry). The allowlist
   *  gate is checked against this — never the wire. */
  extensionName: string;
  extensionId: string;
  /** Acting user (resolved reverse-RPC provenance). `null` = ownerless
   *  background fire → control verbs reject; ticket verbs also reject (no
   *  conversation scope). */
  userId: string | null;
  /** Calling conversation id (resolved provenance). Ticket verbs derive
   *  projectId from THIS — never from params. */
  conversationId: string | null;
  grantedPermissions: ExtensionPermissions;
}

// ── Injectable seams (so the unit test drives without DB / network / gh) ──
//
// Production wires the real implementations; tests override them. Kept module-
// private with explicit setters mirroring the sibling extensions' pattern.

type GhTokenResolver = () => Promise<string>;

/** A spawned process shape `runGhAuthToken` consumes (a subset of Bun.Subprocess). */
interface GhProc {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}
type SpawnFn = (cmd: string[]) => GhProc;

/**
 * Run `gh auth token` (which prints the active gh CLI token to stdout) and
 * return the trimmed token. Host-only. The spawn is injected so the body is
 * unit-testable without a real `gh` binary. Exported for the test.
 */
export async function runGhAuthToken(spawn: SpawnFn): Promise<string> {
  const proc = spawn(["gh", "auth", "token"]);
  const out = (await new Response(proc.stdout).text()).trim();
  const code = await proc.exited;
  if (code !== 0 || !out) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new Error(`gh auth token failed (exit ${code}): ${err || "no token"}`);
  }
  return out;
}

const defaultGhTokenResolver: GhTokenResolver = () =>
  runGhAuthToken(
    (cmd) => Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }) as unknown as GhProc,
  );
let ghTokenResolverImpl: GhTokenResolver = defaultGhTokenResolver;
/** @internal test-only — substitute the `gh auth token` resolver. */
export function _setGhTokenResolverForTests(fn: GhTokenResolver | null): void {
  ghTokenResolverImpl = fn ?? defaultGhTokenResolver;
}

// ── Auth resolution (host-only) ──────────────────────────────────────

/**
 * Resolve the bearer credential for a link. `pat` reads the board's per-board
 * override token (`apiToken:<linkId>`) from the scope-isolated secrets store
 * first, falling back to the SHARED project token (`apiToken`); `gh` shells out
 * to `gh auth token`. Never logs the token. Throws a clear error when neither
 * token is available (the store returns null for a missing OR undecryptable
 * secret).
 */
export async function resolveAuth(link: GithubProjectsLink): Promise<GithubAuth> {
  if (link.authMode === "gh") {
    const token = await ghTokenResolverImpl();
    return { mode: "gh", token };
  }
  // pat (default): per-board override wins, else the shared project token.
  const override = await getSecret("github-projects", link.projectId, boardTokenName(link.id));
  const token = override ?? (await getSecret("github-projects", link.projectId, "apiToken"));
  if (!token) {
    throw new Error(
      "GitHub token not configured for this project — reconnect the board with a PAT.",
    );
  }
  return { mode: "pat", token };
}

// ── projectId / link derivation (server-side) ────────────────────────

/** Resolve the calling conversation's projectId, or null when unbound. */
async function deriveProjectId(conversationId: string | null): Promise<string | null> {
  if (!conversationId || conversationId === "unknown") return null;
  const conv = await getConversation(conversationId);
  return conv?.projectId ?? null;
}

/** Find the board item a ticket verb targets by its node id. The host
 *  re-fetches the board (no cursor) so the client gets a fresh item view —
 *  this also confirms the itemNodeId actually belongs to THIS board (a forged
 *  node id from another board simply isn't found). */
async function findBoardItem(
  client: ReturnType<typeof createGithubClient>,
  link: GithubProjectsLink,
  auth: GithubAuth,
  itemNodeId: string,
): Promise<GithubBoardItem | null> {
  const page = await client.fetchBoardItems(link.boardNodeId, auth, null);
  return page.items.find((i) => i.itemNodeId === itemNodeId) ?? null;
}

// ── Top-level handler ────────────────────────────────────────────────

export async function handleGithubProjectsRpc(
  verb: GithubProjectsRpcVerb | string,
  req: JsonRpcRequest,
  ctx: GithubProjectsContext,
): Promise<JsonRpcResponse> {
  // 1) Bundled-only allowlist — checked BY NAME. A compromised manifest can't
  //    widen this. -32603 (internal/unknown capability) so the subprocess sees
  //    a non-recoverable response, matching the drafts handler.
  if (!BUNDLED_GITHUB_PROJECTS_ALLOWLIST.has(ctx.extensionName)) {
    log.warn("ezcorp/github-projects rejected: extension not in bundled allowlist", {
      extensionName: ctx.extensionName,
    });
    return rpcError(req.id, -32603, "ezcorp/github-projects is bundled-only");
  }

  const params = (req.params ?? {}) as Record<string, unknown>;

  switch (verb) {
    // ── Ticket verbs (conversation-scoped) ──
    case "list":
      return handleList(req, params, ctx);
    case "create":
    case "update":
    case "move":
    case "archive":
    case "comment":
      return handleTicketMutation(verb, req, params, ctx);
    // ── Control verbs (viewing-user-scoped, Hub page) ──
    case "dashboard-data":
      return handleDashboardData(req, ctx);
    case "approve":
      return handleApprove(req, params, ctx);
    case "dismiss":
      return handleDismiss(req, params, ctx);
    case "pause":
      return handleSetEnabled(req, params, ctx, false);
    case "resume":
      return handleSetEnabled(req, params, ctx, true);
    case "poll-now":
      return handlePollNow(req, params, ctx);
    default:
      return rpcError(req.id, -32601, `Unknown github-projects verb: ${String(verb)}`);
  }
}

// ── Ticket-verb shared setup ─────────────────────────────────────────

/**
 * Resolve the conversation's project + connected board + auth + client for a
 * ticket verb. Returns a typed error response (to return verbatim) when the
 * conversation is unbound or no board is connected.
 */
async function resolveTicketContext(
  req: JsonRpcRequest,
  ctx: GithubProjectsContext,
):
  | Promise<
      | {
          ok: true;
          projectId: string;
          link: GithubProjectsLink;
          auth: GithubAuth;
          client: ReturnType<typeof createGithubClient>;
        }
      | { ok: false; errorResponse: JsonRpcResponse }
    > {
  const projectId = await deriveProjectId(ctx.conversationId);
  if (!projectId) {
    return {
      ok: false,
      errorResponse: rpcError(
        req.id,
        -32602,
        "No project scope for this conversation — cannot resolve a board.",
      ),
    };
  }
  // A project may link MANY boards, so resolve WHICH board this conversation's
  // ticket verbs target (confused-deputy-safe — never from params):
  //   1) the proposal that SPAWNED this conversation pins its linkId (the
  //      auto-spawn / approved-run path → the right board, always),
  //   2) else, when the project has exactly ONE board, use it (a human chat that
  //      was never spawned from a card),
  //   3) else it's ambiguous (multiple boards, no spawning proposal) → refuse.
  const resolved = await resolveConversationBoard(ctx.conversationId, projectId);
  if (!resolved.ok) {
    return { ok: false, errorResponse: rpcError(req.id, -32602, resolved.message) };
  }
  const link = resolved.link;
  let auth: GithubAuth;
  try {
    auth = await resolveAuth(link);
  } catch (err) {
    return {
      ok: false,
      errorResponse: rpcError(req.id, -32603, err instanceof Error ? err.message : String(err)),
    };
  }
  return { ok: true, projectId, link, auth, client: createGithubClient() };
}

/**
 * Resolve WHICH board a conversation's ticket verbs act on (multi-board). The
 * spawning proposal is the source of truth (it pins `linkId`); when there is no
 * spawning proposal we fall back to the project's sole board, and refuse when
 * the project has zero boards or several boards with nothing to disambiguate.
 * Returns a small typed result the caller maps to an RPC error.
 */
async function resolveConversationBoard(
  conversationId: string | null,
  projectId: string,
): Promise<{ ok: true; link: GithubProjectsLink } | { ok: false; message: string }> {
  // 1) The proposal that spawned this conversation pins the exact board.
  if (conversationId && conversationId !== "unknown") {
    const proposal = await getProposalByConversationId(conversationId);
    if (proposal) {
      const link = await getLinkById(proposal.linkId);
      if (link && link.projectId === projectId) return { ok: true, link };
    }
  }
  // 2) Fallback for a human chat never spawned from a card: exactly one board.
  const links = await listLinksByProjectId(projectId);
  if (links.length === 1) return { ok: true, link: links[0]! };
  if (links.length === 0) {
    return {
      ok: false,
      message: "No GitHub Projects board is connected to this project. Connect a board first.",
    };
  }
  // 3) Multiple boards and no spawning proposal — genuinely ambiguous.
  return {
    ok: false,
    message:
      "This project has multiple GitHub boards connected; ticket tools can't tell which one to use from this conversation.",
  };
}

async function handleList(
  req: JsonRpcRequest,
  params: Record<string, unknown>,
  ctx: GithubProjectsContext,
): Promise<JsonRpcResponse> {
  const resolved = await resolveTicketContext(req, ctx);
  if (!resolved.ok) return resolved.errorResponse;
  const { link, auth, client } = resolved;

  const statusFilter = typeof params.status === "string" ? params.status.trim() : "";
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
      ? Math.floor(params.limit)
      : 50;

  let items: GithubBoardItem[];
  try {
    const page = await client.fetchBoardItems(link.boardNodeId, auth, null);
    items = page.items;
  } catch (err) {
    return rpcError(req.id, -32603, `list failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (statusFilter) {
    items = items.filter((i) => (i.statusName ?? "").toLowerCase() === statusFilter.toLowerCase());
  }
  // Newest-updated first (the cursor source field), then cap.
  items = [...items]
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, limit);

  return rpcResult(req.id, {
    items: items.map((i) => ({
      itemNodeId: i.itemNodeId,
      title: i.title,
      url: i.url,
      statusName: i.statusName,
      updatedAt: i.updatedAt,
    })),
  });
}

/**
 * Shared create/update/move/archive/comment dispatch. PDP-gated + audited.
 * `itemNodeId` (for the non-create verbs) is resolved against THIS board, so a
 * node id from another board is "not found" — a ticket verb can never reach a
 * card the conversation's board doesn't own.
 */
async function handleTicketMutation(
  verb: "create" | "update" | "move" | "archive" | "comment",
  req: JsonRpcRequest,
  params: Record<string, unknown>,
  ctx: GithubProjectsContext,
): Promise<JsonRpcResponse> {
  const resolved = await resolveTicketContext(req, ctx);
  if (!resolved.ok) return resolved.errorResponse;
  const { projectId, link, auth, client } = resolved;

  // No engine.authorize call here: `custom.githubProjects` is NOT a typed
  // `CapabilityKind`, so it can't be expressed as a PDP cap (parity with the
  // sibling bundled-only `ezcorp/drafts` handler, which also gates on its
  // allowlist + manifest `custom.*` marker rather than the engine). The
  // tool-executor's own PDP gate already authorized the tool CALL against the
  // manifest before this reverse-RPC fired; the bundled-only allowlist above
  // is this handler's gate, and every mutation writes an audit row below.

  try {
    let result: Record<string, unknown>;
    switch (verb) {
      case "create": {
        const title = typeof params.title === "string" ? params.title.trim() : "";
        if (!title) return rpcError(req.id, -32602, "'title' is required");
        const ref = await client.createIssueOnBoard(link.boardNodeId, auth, {
          title,
          ...(typeof params.body === "string" ? { body: params.body } : {}),
          ...(typeof params.statusName === "string" ? { statusName: params.statusName } : {}),
        });
        result = { ticket: ref };
        break;
      }
      case "update": {
        const itemNodeId = typeof params.itemNodeId === "string" ? params.itemNodeId.trim() : "";
        if (!itemNodeId) return rpcError(req.id, -32602, "'itemNodeId' is required");
        const ref = await client.updateItem(link.boardNodeId, auth, {
          itemNodeId,
          ...(typeof params.title === "string" ? { title: params.title } : {}),
          ...(typeof params.body === "string" ? { body: params.body } : {}),
        });
        result = { ticket: ref };
        break;
      }
      case "move": {
        const itemNodeId = typeof params.itemNodeId === "string" ? params.itemNodeId.trim() : "";
        const statusName = typeof params.statusName === "string" ? params.statusName.trim() : "";
        if (!itemNodeId) return rpcError(req.id, -32602, "'itemNodeId' is required");
        if (!statusName) return rpcError(req.id, -32602, "'statusName' is required");
        const optionId = await resolveStatusOptionId(client, link, auth, statusName);
        if (!optionId) {
          return rpcError(
            req.id,
            -32602,
            `No Status column named "${statusName}" on this board.`,
          );
        }
        await client.setItemStatus(link.boardNodeId, auth, itemNodeId, optionId);
        result = { ok: true };
        break;
      }
      case "archive": {
        const itemNodeId = typeof params.itemNodeId === "string" ? params.itemNodeId.trim() : "";
        if (!itemNodeId) return rpcError(req.id, -32602, "'itemNodeId' is required");
        await client.archiveItem(link.boardNodeId, auth, itemNodeId);
        result = { ok: true };
        break;
      }
      case "comment": {
        const itemNodeId = typeof params.itemNodeId === "string" ? params.itemNodeId.trim() : "";
        const body = typeof params.body === "string" ? params.body.trim() : "";
        if (!itemNodeId) return rpcError(req.id, -32602, "'itemNodeId' is required");
        if (!body) return rpcError(req.id, -32602, "'body' is required");
        const item = await findBoardItem(client, link, auth, itemNodeId);
        if (!item) {
          return rpcError(req.id, -32602, "Ticket not found on this board.");
        }
        if (!item.contentNodeId) {
          return rpcError(
            req.id,
            -32602,
            "This card is a board draft with no underlying issue — cannot comment yet.",
          );
        }
        await client.addComment(auth, item.contentNodeId, body);
        result = { ok: true };
        break;
      }
    }
    await writeAudit(AUDIT_TICKET_MUTATE, ctx, { verb, projectId, linkId: link.id });
    return rpcResult(req.id, result!);
  } catch (err) {
    return rpcError(
      req.id,
      -32603,
      `github-projects.${verb} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve a free-text Status-column NAME → its option id for `move`.
 *
 * The link row persists `statusFieldId` + the triggering `columnActionMap` but
 * NOT the full name→id option list, so we re-resolve the board ref through the
 * client (`resolveBoardFromUrl` returns `statusOptions`) and match by name
 * (case-insensitive). Returns null when no column matches.
 */
async function resolveStatusOptionId(
  client: ReturnType<typeof createGithubClient>,
  link: GithubProjectsLink,
  auth: GithubAuth,
  statusName: string,
): Promise<string | null> {
  const ref = await client.resolveBoardFromUrl(link.boardUrl, auth);
  const want = statusName.toLowerCase();
  const opt = ref.statusOptions.find((o) => o.name.toLowerCase() === want);
  return opt?.id ?? null;
}

// ── Control verbs (viewing-user-scoped) ──────────────────────────────

/** A link "owned" by the user for control purposes = they created it. */
function userOwnsLink(link: GithubProjectsLink, userId: string): boolean {
  return link.createdByUserId === userId;
}

/**
 * dashboard-data — return the viewing user's proposals + per-board health,
 * scoped to the links THEY created. Never leaks another user's boards.
 */
async function handleDashboardData(
  req: JsonRpcRequest,
  ctx: GithubProjectsContext,
): Promise<JsonRpcResponse> {
  if (!ctx.userId) {
    return rpcError(req.id, -32602, "No viewing user for dashboard-data.");
  }
  const userId = ctx.userId;
  // Find every project the user has connected a board to. There's no
  // user→projects index, so we read all proposals' links lazily via the
  // user's links. We resolve the set of links the user created by scanning
  // proposals — but the cleaner source is the links themselves keyed by
  // createdByUserId. Use the dedicated query.
  const links = await listLinksCreatedByUser(userId);
  const boards = links.map((l) => ({
    linkId: l.id,
    boardTitle: l.boardTitle,
    boardUrl: l.boardUrl,
    enabled: l.enabled,
    lastPolledAt: l.lastPolledAt ? l.lastPolledAt.toISOString() : null,
    lastError: l.lastError ?? null,
  }));

  const allStatuses = [...GITHUB_ACTIVE_STATUSES, ...GITHUB_TERMINAL_STATUSES];
  const proposalsNested = await Promise.all(
    links.map((l) =>
      listProposalsByProject(l.projectId, { statuses: allStatuses, limit: 100 }).then(
        (rows) => rows.map((p) => projectionForProposal(p, l)),
      ),
    ),
  );
  const proposals = proposalsNested.flat();

  return rpcResult(req.id, { proposals, boards });
}

function projectionForProposal(p: GithubProjectsProposal, link: GithubProjectsLink) {
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    action: p.action,
    statusName: p.statusName,
    ticketUrl: p.ticketUrl ?? null,
    // projectId backs the chat href the dashboard builds
    // (`/project/<projectId>/chat/<conversationId>`).
    projectId: link.projectId,
    conversationId: p.conversationId ?? null,
    boardTitle: link.boardTitle,
    proposedAt: p.proposedAt.toISOString(),
  };
}

/**
 * approve — verify the user owns the proposal's project's link, then spawn via
 * the spawn bridge. Opaque -32603 on miss / not-owned so a cross-user probe
 * can't tell a real proposal from one it doesn't own.
 */
async function handleApprove(
  req: JsonRpcRequest,
  params: Record<string, unknown>,
  ctx: GithubProjectsContext,
): Promise<JsonRpcResponse> {
  const guard = await guardProposalOwnership(req, params, ctx);
  if (!guard.ok) return guard.errorResponse;
  try {
    const updated = await approveProposal(guard.proposal.id, {
      kind: "user",
      userId: guard.userId,
    });
    await writeAudit(AUDIT_CONTROL, ctx, { verb: "approve", proposalId: guard.proposal.id });
    return rpcResult(req.id, { ok: true, status: updated.status });
  } catch (err) {
    return rpcError(req.id, -32603, `approve failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleDismiss(
  req: JsonRpcRequest,
  params: Record<string, unknown>,
  ctx: GithubProjectsContext,
): Promise<JsonRpcResponse> {
  const guard = await guardProposalOwnership(req, params, ctx);
  if (!guard.ok) return guard.errorResponse;
  try {
    const updated = await dismissProposal(guard.proposal.id, guard.userId);
    await writeAudit(AUDIT_CONTROL, ctx, { verb: "dismiss", proposalId: guard.proposal.id });
    return rpcResult(req.id, { ok: true, status: updated.status });
  } catch (err) {
    return rpcError(req.id, -32603, `dismiss failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleSetEnabled(
  req: JsonRpcRequest,
  params: Record<string, unknown>,
  ctx: GithubProjectsContext,
  enabled: boolean,
): Promise<JsonRpcResponse> {
  if (!ctx.userId) return rpcError(req.id, -32602, "No viewing user.");
  const linkId = typeof params.linkId === "string" ? params.linkId.trim() : "";
  if (!linkId) return rpcError(req.id, -32602, "'linkId' is required");
  const link = await getLinkById(linkId);
  // Opaque -32603 on miss OR not-owned (don't leak link existence cross-user).
  if (!link || !userOwnsLink(link, ctx.userId)) {
    return rpcError(req.id, -32603, "Board not found");
  }
  try {
    await setLinkEnabled(linkId, enabled);
    await writeAudit(AUDIT_CONTROL, ctx, { verb: enabled ? "resume" : "pause", linkId });
    return rpcResult(req.id, { ok: true, enabled });
  } catch (err) {
    return rpcError(req.id, -32603, `${enabled ? "resume" : "pause"} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * poll-now — force an IMMEDIATE poll of the SPECIFIC board, bypassing the
 * daemon's due-check + back-off, so the Hub's "Poll now" button reflects board
 * changes without waiting for the next 60s tick. Ownership-gated like
 * pause/resume: opaque -32603 on miss / not-owned so a cross-user probe can't
 * tell a real board from one it doesn't own. Polls the resolved link directly
 * (multi-board: the project may have many); `{ polled, reason? }` flows back to
 * the caller (e.g. `paused` when the user must resume first).
 */
async function handlePollNow(
  req: JsonRpcRequest,
  params: Record<string, unknown>,
  ctx: GithubProjectsContext,
): Promise<JsonRpcResponse> {
  if (!ctx.userId) return rpcError(req.id, -32602, "No viewing user.");
  const linkId = typeof params.linkId === "string" ? params.linkId.trim() : "";
  if (!linkId) return rpcError(req.id, -32602, "'linkId' is required");
  const link = await getLinkById(linkId);
  // Opaque -32603 on miss OR not-owned (don't leak link existence cross-user).
  if (!link || !userOwnsLink(link, ctx.userId)) {
    return rpcError(req.id, -32603, "Board not found");
  }
  try {
    const result = await getGithubProjectsDaemon().pollLinkNow(link);
    await writeAudit(AUDIT_CONTROL, ctx, { verb: "poll-now", linkId });
    return rpcResult(req.id, { ok: true, ...result });
  } catch (err) {
    return rpcError(req.id, -32603, `poll-now failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Shared ownership guard for approve/dismiss: resolve the proposal, then the
 * proposal's link, then confirm the user created that link. Opaque on every
 * failure mode so the proposal id's existence is not observable cross-user.
 */
async function guardProposalOwnership(
  req: JsonRpcRequest,
  params: Record<string, unknown>,
  ctx: GithubProjectsContext,
): Promise<
  | { ok: true; proposal: GithubProjectsProposal; userId: string }
  | { ok: false; errorResponse: JsonRpcResponse }
> {
  if (!ctx.userId) {
    return { ok: false, errorResponse: rpcError(req.id, -32602, "No viewing user.") };
  }
  const proposalId = typeof params.proposalId === "string" ? params.proposalId.trim() : "";
  if (!proposalId) {
    return { ok: false, errorResponse: rpcError(req.id, -32602, "'proposalId' is required") };
  }
  const proposal = await getProposalById(proposalId);
  const link = proposal ? await getLinkById(proposal.linkId) : null;
  if (!proposal || !link || !userOwnsLink(link, ctx.userId)) {
    return { ok: false, errorResponse: rpcError(req.id, -32603, "Proposal not found") };
  }
  return { ok: true, proposal, userId: ctx.userId };
}

// ── Links-by-user query (injectable seam) ────────────────────────────
//
// The Phase-0 query layer has no `listLinksCreatedByUser`; we read it via a
// small injectable seam so the handler stays decoupled from the (frozen) query
// file and the unit test can drive it directly.
type LinksByUser = (userId: string) => Promise<GithubProjectsLink[]>;
let linksByUserImpl: LinksByUser = defaultLinksByUser;
/** @internal test-only — substitute the links-by-user source. */
export function _setLinksByUserForTests(fn: LinksByUser | null): void {
  linksByUserImpl = fn ?? defaultLinksByUser;
}
async function listLinksCreatedByUser(userId: string): Promise<GithubProjectsLink[]> {
  return linksByUserImpl(userId);
}
async function defaultLinksByUser(userId: string): Promise<GithubProjectsLink[]> {
  return (await getDb()
    .select()
    .from(githubProjectsLinks)
    .where(eq(githubProjectsLinks.createdByUserId, userId))) as GithubProjectsLink[];
}

// ── Audit ────────────────────────────────────────────────────────────

async function writeAudit(
  action: string,
  ctx: GithubProjectsContext,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await insertAuditEntry(ctx.userId, action, ctx.extensionId, {
      actor: "system",
      ...metadata,
    });
  } catch {
    // Audit failure must never break the response path.
  }
}
