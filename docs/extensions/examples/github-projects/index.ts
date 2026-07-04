#!/usr/bin/env bun
// ── github-projects — connect a board, plan/execute its tickets ──────
//
// Subprocess surface:
//   - 6 THIN tools (list/create/update/move/archive/comment) — each emits a
//     reverse-RPC `ezcorp/github-projects.<verb>` intent carrying ONLY its
//     own params (never a board id). The host handler derives projectId from
//     the conversation, resolves the board + host-only token, and calls the
//     GitHub client.
//   - definePage("dashboard") — pulls `ezcorp/github-projects.dashboard-data`
//     (the VIEWING USER's proposals + per-board health) and builds the Hub
//     tree: Active Work, History, and Connection Health sections with
//     Approve / Dismiss / Re-run / Pause / Resume / Reconnect actions.
//   - Live refresh — re-render on the daemon's `github-projects:proposal-update`
//     and on `task:assignment_update` / `run:complete` (a proposal's run moved).
//
// All page content is DATA; the host renders native Svelte from the tree.
// This module touches no DOM and does no GitHub I/O — it is fully sandboxed.

import {
  PageBuilder,
  createToolDispatcher,
  definePage,
  getChannel,
  pushPage,
  registerEventHandler,
  toolError,
  toolResult,
  type HubPageTree,
  type PageActionEvent,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import {
  GITHUB_PROJECTS_RPC_PREFIX,
  GITHUB_PROJECTS_EVENT,
  GITHUB_ACTIVE_STATUSES,
  GITHUB_TERMINAL_STATUSES,
  type GithubProposalStatus,
} from "../../../../src/integrations/github-projects/types";

export const PAGE_ID = "dashboard";

// ── Page-action events the Hub buttons dispatch ──────────────────────
// Each MUST be `${manifest.name}:<suffix>` (the Hub dispatcher strips the
// `github-projects:` prefix and drops anything else) AND declared in
// `permissions.eventSubscriptions`.
export const APPROVE_EVENT = "github-projects:approve";
export const DISMISS_EVENT = "github-projects:dismiss";
export const RERUN_EVENT = "github-projects:rerun";
export const PAUSE_EVENT = "github-projects:pause";
export const RESUME_EVENT = "github-projects:resume";
export const POLL_NOW_EVENT = "github-projects:poll-now";
export const REFRESH_EVENT = "github-projects:refresh";

// ── Reverse-RPC method names (host handler verbs) ────────────────────
// Ticket verbs are the FROZEN contract verbs; the control verbs below are
// this extension's private host-page API (handled by the same handler).
const m = (verb: string): string => `${GITHUB_PROJECTS_RPC_PREFIX}${verb}`;
export const RPC = {
  list: m("list"),
  create: m("create"),
  update: m("update"),
  move: m("move"),
  archive: m("archive"),
  comment: m("comment"),
  dashboardData: m("dashboard-data"),
  approve: m("approve"),
  dismiss: m("dismiss"),
  rerun: m("rerun"),
  pause: m("pause"),
  resume: m("resume"),
  pollNow: m("poll-now"),
} as const;

// ── Reverse-RPC seam (injectable for tests) ──────────────────────────
// The subprocess never calls a GitHub host directly — every verb is a
// reverse-RPC into the host handler. The seam lets the unit test observe the
// requests + drive responses without a live channel.
export type RpcFn = (method: string, params: Record<string, unknown>) => Promise<unknown>;
let rpcImpl: RpcFn = (method, params) => getChannel().request(method, params);
/** @internal test-only — substitute the reverse-RPC transport. */
export function _setRpcForTests(fn: RpcFn | null): void {
  rpcImpl = fn ?? ((method, params) => getChannel().request(method, params));
}

let pushPageImpl: typeof pushPage = pushPage;
/** @internal test-only — observe pushPage calls. */
export function _setPushPageForTests(fn: typeof pushPage | null): void {
  pushPageImpl = fn ?? pushPage;
}

// ── Dashboard-data wire shape (host → page) ──────────────────────────
// The handler returns ONLY data scoped to the viewing user. Mirrors the
// DB row fields the page renders; kept narrow so the page tree stays small.

export interface ProposalView {
  id: string;
  title: string;
  status: GithubProposalStatus;
  action: string; // "plan" | "execute"
  statusName: string;
  ticketUrl: string | null;
  /** The EZCorp project the board is connected to — needed to build the chat
   *  href (`/project/<projectId>/chat/<conversationId>`). */
  projectId: string;
  conversationId: string | null;
  boardTitle: string;
  proposedAt: string; // ISO
}

export interface BoardHealthView {
  linkId: string;
  boardTitle: string;
  boardUrl: string;
  enabled: boolean;
  lastPolledAt: string | null; // ISO
  lastError: string | null;
}

export interface DashboardData {
  proposals: ProposalView[];
  boards: BoardHealthView[];
}

// ── Tools (THIN reverse-RPC intents) ─────────────────────────────────

function reqString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Shared: run a ticket verb's reverse-RPC + map the response to a toolResult. */
async function ticketCall(
  method: string,
  params: Record<string, unknown>,
): Promise<ReturnType<ToolHandler>> {
  try {
    const res = await rpcImpl(method, params);
    return toolResult(JSON.stringify(res ?? {}));
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export const listTickets: ToolHandler = async (args) => {
  const { status, limit } = (args ?? {}) as { status?: unknown; limit?: unknown };
  const params: Record<string, unknown> = {};
  if (reqString(status)) params.status = reqString(status);
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    params.limit = Math.floor(limit);
  }
  return ticketCall(RPC.list, params);
};

export const createTicket: ToolHandler = async (args) => {
  const { title, body, statusName } = (args ?? {}) as {
    title?: unknown;
    body?: unknown;
    statusName?: unknown;
  };
  const t = reqString(title);
  if (!t) return toolError("'title' is required and must be a non-empty string");
  const params: Record<string, unknown> = { title: t };
  if (reqString(body)) params.body = reqString(body);
  if (reqString(statusName)) params.statusName = reqString(statusName);
  return ticketCall(RPC.create, params);
};

export const updateTicket: ToolHandler = async (args) => {
  const { itemNodeId, title, body } = (args ?? {}) as {
    itemNodeId?: unknown;
    title?: unknown;
    body?: unknown;
  };
  const id = reqString(itemNodeId);
  if (!id) return toolError("'itemNodeId' is required and must be a non-empty string");
  const params: Record<string, unknown> = { itemNodeId: id };
  if (reqString(title)) params.title = reqString(title);
  if (reqString(body)) params.body = reqString(body);
  return ticketCall(RPC.update, params);
};

export const moveTicket: ToolHandler = async (args) => {
  const { itemNodeId, statusName } = (args ?? {}) as {
    itemNodeId?: unknown;
    statusName?: unknown;
  };
  const id = reqString(itemNodeId);
  if (!id) return toolError("'itemNodeId' is required and must be a non-empty string");
  const status = reqString(statusName);
  if (!status) return toolError("'statusName' is required and must be a non-empty string");
  return ticketCall(RPC.move, { itemNodeId: id, statusName: status });
};

export const archiveTicket: ToolHandler = async (args) => {
  const { itemNodeId } = (args ?? {}) as { itemNodeId?: unknown };
  const id = reqString(itemNodeId);
  if (!id) return toolError("'itemNodeId' is required and must be a non-empty string");
  return ticketCall(RPC.archive, { itemNodeId: id });
};

export const addComment: ToolHandler = async (args) => {
  const { itemNodeId, body } = (args ?? {}) as { itemNodeId?: unknown; body?: unknown };
  const id = reqString(itemNodeId);
  if (!id) return toolError("'itemNodeId' is required and must be a non-empty string");
  const text = reqString(body);
  if (!text) return toolError("'body' is required and must be a non-empty string");
  return ticketCall(RPC.comment, { itemNodeId: id, body: text });
};

export const tools: Record<string, ToolHandler> = {
  list_tickets: listTickets,
  create_ticket: createTicket,
  update_ticket: updateTicket,
  move_ticket: moveTicket,
  archive_ticket: archiveTicket,
  add_comment: addComment,
};

// ── Dashboard rendering (pure) ───────────────────────────────────────

const ACTIVE_SET = new Set<GithubProposalStatus>(GITHUB_ACTIVE_STATUSES);
const TERMINAL_SET = new Set<GithubProposalStatus>(GITHUB_TERMINAL_STATUSES);

const STATUS_BADGE: Record<GithubProposalStatus, string> = {
  pending: "● pending",
  approved: "◉ approved",
  spawned: "▷ spawned",
  running: "▶ running",
  done: "✓ done",
  failed: "✗ failed",
  dismissed: "⊘ dismissed",
  cancelled: "⊘ cancelled",
};

/** Format an ISO timestamp to "YYYY-MM-DD HH:MM" (or "—" when absent). */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.slice(0, 16).replace("T", " ");
}

/**
 * Build the in-app chat href for a proposal's spawned conversation, or null
 * when it has no conversation yet. MUST match the SvelteKit chat route shape
 * `/project/[id]/chat/[convId]` — a bare `/chat/<id>` 404s.
 */
export function chatHref(p: ProposalView): string | null {
  return p.conversationId ? `/project/${p.projectId}/chat/${p.conversationId}` : null;
}

/** Build the dashboard tree from the viewing user's data. Pure + exported so
 *  the unit test asserts the tree (sections, badges, action events) directly. */
export function buildDashboard(data: DashboardData): HubPageTree {
  const proposals = data.proposals ?? [];
  const boards = data.boards ?? [];
  const active = proposals.filter((p) => ACTIVE_SET.has(p.status));
  const history = proposals.filter((p) => TERMINAL_SET.has(p.status));
  const pendingCount = proposals.filter((p) => p.status === "pending").length;

  const page = new PageBuilder("GitHub Projects")
    .markdownBlock(
      "Board-triggered proposals for the projects you've connected. Approve " +
        "or dismiss pending work, and manage each board's connection. " +
        "Refreshes live as the poller detects board changes.",
    )
    .stats([
      { label: "Connected boards", value: String(boards.length) },
      { label: "Active proposals", value: String(active.length) },
      { label: "Pending approval", value: String(pendingCount) },
      { label: "History", value: String(history.length) },
    ])
    .button("Refresh", { event: REFRESH_EVENT }, "secondary");

  if (boards.length === 0) {
    page.emptyState(
      "No boards connected",
      "Connect a GitHub Projects board to a project (in the app's project " +
        "settings), then board-triggered proposals appear here.",
    );
    return page.build();
  }

  // ── Active Work ────────────────────────────────────────────────────
  page.heading(2, "Active work");
  if (active.length === 0) {
    page.emptyState("Nothing in flight", "Approved + running proposals show here.");
  } else {
    page.table(
      ["Ticket", "Board", "Status", "Action", "Proposed"],
      active.map((p) => {
        const cells = [
          p.title || p.id.slice(0, 8),
          p.boardTitle || "—",
          STATUS_BADGE[p.status],
          p.action,
          fmtTime(p.proposedAt),
        ];
        // Pending → Approve action on the row (confirm-gated). Spawned/running
        // proposals link to their conversation instead.
        if (p.status === "pending") {
          return {
            cells,
            action: {
              event: APPROVE_EVENT,
              payload: { proposalId: p.id },
              confirm: `Approve "${p.title || p.id.slice(0, 8)}"? This spawns an agent run.`,
            },
          };
        }
        const href = chatHref(p);
        return href ? { cells, href } : { cells };
      }),
    );
    // Per-pending-proposal Dismiss buttons (a second action surface so a user
    // can decline without approving — row actions only carry one action).
    for (const p of active.filter((x) => x.status === "pending")) {
      page.button(
        `Dismiss "${p.title || p.id.slice(0, 8)}"`,
        {
          event: DISMISS_EVENT,
          payload: { proposalId: p.id },
          confirm: `Dismiss "${p.title || p.id.slice(0, 8)}"? It will not run.`,
        },
        "danger",
      );
    }
  }

  // ── History ────────────────────────────────────────────────────────
  page.heading(2, "History");
  if (history.length === 0) {
    page.emptyState("No history yet", "Completed + dismissed proposals show here.");
  } else {
    page.table(
      ["Ticket", "Board", "Status", "Action", "Proposed"],
      history.map((p) => {
        const cells = [
          p.title || p.id.slice(0, 8),
          p.boardTitle || "—",
          STATUS_BADGE[p.status],
          p.action,
          fmtTime(p.proposedAt),
        ];
        const href = chatHref(p);
        return href ? { cells, href } : { cells };
      }),
    );
    // Per-terminal-proposal Re-run buttons (History rows link to their
    // conversation, and a row carries only one action — so Re-run is a second
    // surface, mirroring the pending rows' Dismiss buttons). Re-running queues
    // a FRESH pending proposal through the normal approval gate.
    for (const p of history) {
      page.button(
        `Re-run "${p.title || p.id.slice(0, 8)}"`,
        {
          event: RERUN_EVENT,
          payload: { proposalId: p.id },
          confirm: `Re-run "${p.title || p.id.slice(0, 8)}"? This queues a fresh proposal for approval.`,
        },
        "secondary",
      );
    }
  }

  // ── Connection Health ──────────────────────────────────────────────
  page.heading(2, "Connection health");
  for (const b of boards) {
    page.section(b.boardTitle || b.boardUrl, (s) => {
      s.table(
        ["State", "Last poll", "Last error"],
        [
          {
            cells: [
              b.enabled ? "▶ polling" : "⏸ paused",
              fmtTime(b.lastPolledAt),
              b.lastError ? b.lastError.slice(0, 80) : "—",
            ],
          },
        ],
      );
      // Pause / Resume toggle.
      if (b.enabled) {
        // Poll now — a manual, idempotent re-poll (no confirm; polling is safe).
        s.button("Poll now", { event: POLL_NOW_EVENT, payload: { linkId: b.linkId } }, "primary");
        s.button(
          "Pause polling",
          {
            event: PAUSE_EVENT,
            payload: { linkId: b.linkId },
            confirm: `Pause polling for "${b.boardTitle || b.boardUrl}"?`,
          },
          "secondary",
        );
      } else {
        s.button(
          "Resume polling",
          { event: RESUME_EVENT, payload: { linkId: b.linkId } },
          "primary",
        );
      }
      // A last error surfaces a Reconnect hint (the connect flow lives in the
      // app; this links the user there).
      if (b.lastError) {
        s.link("Reconnect this board", `/projects`);
      }
    });
  }

  return page.build();
}

// ── Live data + render ───────────────────────────────────────────────

/** Fetch the viewing user's dashboard data via the host handler. Fail-soft to
 *  an empty shape so a transient reverse-RPC blip renders an empty page rather
 *  than throwing into the host render-pull. */
export async function fetchDashboardData(): Promise<DashboardData> {
  try {
    const res = (await rpcImpl(RPC.dashboardData, {})) as Partial<DashboardData> | null;
    return {
      proposals: Array.isArray(res?.proposals) ? res!.proposals : [],
      boards: Array.isArray(res?.boards) ? res!.boards : [],
    };
  } catch {
    return { proposals: [], boards: [] };
  }
}

export async function renderDashboard(): Promise<HubPageTree> {
  return buildDashboard(await fetchDashboardData());
}

/** Re-pull the viewing user's data + push a fresh tree. */
async function pushDashboard(): Promise<void> {
  pushPageImpl(PAGE_ID, buildDashboard(await fetchDashboardData()));
}

// ── Page-action handlers ─────────────────────────────────────────────
// Each calls the matching control verb (host enforces ownership), then pushes
// a fresh tree. A reverse-RPC error is swallowed (best-effort) — the host
// already audited it and the next pull re-pulls authoritative state.

async function controlThenRefresh(
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  try {
    await rpcImpl(method, params);
  } catch {
    /* host audited the failure; refresh shows the unchanged state */
  }
  await pushDashboard();
}

export async function handleApprove(event: PageActionEvent): Promise<void> {
  const proposalId = reqString(event.payload?.proposalId);
  if (proposalId) await controlThenRefresh(RPC.approve, { proposalId });
}

export async function handleDismiss(event: PageActionEvent): Promise<void> {
  const proposalId = reqString(event.payload?.proposalId);
  if (proposalId) await controlThenRefresh(RPC.dismiss, { proposalId });
}

export async function handleRerun(event: PageActionEvent): Promise<void> {
  const proposalId = reqString(event.payload?.proposalId);
  if (proposalId) await controlThenRefresh(RPC.rerun, { proposalId });
}

export async function handlePause(event: PageActionEvent): Promise<void> {
  const linkId = reqString(event.payload?.linkId);
  if (linkId) await controlThenRefresh(RPC.pause, { linkId });
}

export async function handleResume(event: PageActionEvent): Promise<void> {
  const linkId = reqString(event.payload?.linkId);
  if (linkId) await controlThenRefresh(RPC.resume, { linkId });
}

export async function handlePollNow(event: PageActionEvent): Promise<void> {
  const linkId = reqString(event.payload?.linkId);
  if (linkId) await controlThenRefresh(RPC.pollNow, { linkId });
}

/** "Refresh" button + daemon proposal-update / run-lifecycle events all just
 *  re-pull + push the dashboard. */
export async function handleRefresh(): Promise<void> {
  await pushDashboard();
}

// ── Wiring ───────────────────────────────────────────────────────────

/** Register the page (+ its action handlers), the tools, and the live-refresh
 *  event handlers. Exported (no stdin side effects) so tests drive it against
 *  a stubbed channel. */
export function register(): void {
  definePage({
    id: PAGE_ID,
    render: renderDashboard,
    actions: {
      [APPROVE_EVENT]: handleApprove,
      [DISMISS_EVENT]: handleDismiss,
      [RERUN_EVENT]: handleRerun,
      [PAUSE_EVENT]: handlePause,
      [RESUME_EVENT]: handleResume,
      [POLL_NOW_EVENT]: handlePollNow,
      [REFRESH_EVENT]: handleRefresh,
    },
  });
  createToolDispatcher(tools);
  // Live refresh on run-lifecycle events that imply a proposal's run moved.
  // These are TYPED SubscribableEvents, so they go through the type-safe
  // wrapper.
  registerEventHandler("task:assignment_update", handleRefresh);
  registerEventHandler("run:complete", handleRefresh);
  // The daemon's proposal-update event (`github-projects:proposal-update`) is a
  // CUSTOM (namespaced, non-typed) event — it isn't a member of the SDK's
  // typed `SubscribableEventMap`, so it's registered on the channel directly,
  // the same `ezcorp/event/<name>` wire format `definePage` uses for
  // page-action events and `registerEventHandler` uses for typed ones.
  getChannel().onRequest(`ezcorp/event/${GITHUB_PROJECTS_EVENT}`, async () => {
    await handleRefresh();
    return undefined;
  });
}

export function start(): void {
  register();
  getChannel().start();
}

// Production wiring — gated on import.meta.main so test imports don't open stdin.
if (import.meta.main) start();
