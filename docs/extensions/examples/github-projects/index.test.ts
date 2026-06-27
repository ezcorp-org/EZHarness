// Unit tests for the github-projects subprocess (index.ts).
//
// Drives the tools, the page render tree, and the page-action handlers against
// injectable seams (`_setRpcForTests` / `_setPushPageForTests`) — no live
// channel. Mirrors the ez-code / ping-loop test pattern: pure render asserted
// directly; tool dispatch + actions asserted via the reverse-RPC seam.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetChannelForTests,
  __resetPagesForTests,
  getChannel,
  type HostChannel,
} from "@ezcorp/sdk/runtime";
import { GITHUB_PROJECTS_EVENT } from "../../../../src/integrations/github-projects/types";
import {
  APPROVE_EVENT,
  DISMISS_EVENT,
  PAUSE_EVENT,
  RESUME_EVENT,
  REFRESH_EVENT,
  PAGE_ID,
  RPC,
  buildDashboard,
  fmtTime,
  fetchDashboardData,
  renderDashboard,
  handleApprove,
  handleDismiss,
  handlePause,
  handleResume,
  handleRefresh,
  register,
  start,
  tools,
  type DashboardData,
  type ProposalView,
  _setRpcForTests,
  _setPushPageForTests,
} from "./index";
import type { ToolCallResult } from "../../../../src/extensions/types";

// ── Reverse-RPC recorder ─────────────────────────────────────────────
interface RpcCall {
  method: string;
  params: Record<string, unknown>;
}
let rpcCalls: RpcCall[] = [];
let rpcResponse: unknown = {};
let rpcShouldThrow = false;
function installRpc(): void {
  _setRpcForTests(async (method, params) => {
    rpcCalls.push({ method, params });
    if (rpcShouldThrow) throw new Error("rpc boom");
    return rpcResponse;
  });
}

const pushes: Array<{ pageId: string; tree: unknown }> = [];

beforeEach(() => {
  rpcCalls = [];
  rpcResponse = {};
  rpcShouldThrow = false;
  pushes.length = 0;
  installRpc();
  _setPushPageForTests((pageId, tree) => {
    pushes.push({ pageId, tree });
  });
});

afterEach(() => {
  _setRpcForTests(null);
  _setPushPageForTests(null);
  __resetPagesForTests();
  __resetChannelForTests();
});

function text(res: ToolCallResult): string {
  return res.content.map((c) => c.text).join("");
}

// ── Tools ────────────────────────────────────────────────────────────

describe("tools", () => {
  test("list_tickets emits the list intent with normalized params", async () => {
    rpcResponse = { items: [{ itemNodeId: "a" }] };
    const res = await tools.list_tickets!({ status: " In Progress ", limit: 3.9 }, {} as never);
    expect(rpcCalls).toEqual([
      { method: RPC.list, params: { status: "In Progress", limit: 3 } },
    ]);
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("itemNodeId");
  });

  test("list_tickets omits empty/invalid params", async () => {
    await tools.list_tickets!({ status: "  ", limit: -1 }, {} as never);
    expect(rpcCalls[0]!.params).toEqual({});
  });

  test("create_ticket requires a title", async () => {
    const res = await tools.create_ticket!({}, {} as never);
    expect(res.isError).toBe(true);
    expect(rpcCalls.length).toBe(0);
  });

  test("create_ticket emits the create intent", async () => {
    await tools.create_ticket!({ title: "  T  ", body: "B", statusName: "Todo" }, {} as never);
    expect(rpcCalls[0]).toEqual({
      method: RPC.create,
      params: { title: "T", body: "B", statusName: "Todo" },
    });
  });

  test("update_ticket requires itemNodeId", async () => {
    expect((await tools.update_ticket!({}, {} as never)).isError).toBe(true);
    await tools.update_ticket!({ itemNodeId: "x", title: "t" }, {} as never);
    expect(rpcCalls[0]).toEqual({ method: RPC.update, params: { itemNodeId: "x", title: "t" } });
  });

  test("move_ticket requires itemNodeId + statusName", async () => {
    expect((await tools.move_ticket!({ itemNodeId: "x" }, {} as never)).isError).toBe(true);
    expect((await tools.move_ticket!({ statusName: "Done" }, {} as never)).isError).toBe(true);
    await tools.move_ticket!({ itemNodeId: "x", statusName: "Done" }, {} as never);
    expect(rpcCalls[0]).toEqual({
      method: RPC.move,
      params: { itemNodeId: "x", statusName: "Done" },
    });
  });

  test("archive_ticket requires itemNodeId", async () => {
    expect((await tools.archive_ticket!({}, {} as never)).isError).toBe(true);
    await tools.archive_ticket!({ itemNodeId: "x" }, {} as never);
    expect(rpcCalls[0]).toEqual({ method: RPC.archive, params: { itemNodeId: "x" } });
  });

  test("add_comment requires itemNodeId + body", async () => {
    expect((await tools.add_comment!({ itemNodeId: "x" }, {} as never)).isError).toBe(true);
    expect((await tools.add_comment!({ body: "b" }, {} as never)).isError).toBe(true);
    await tools.add_comment!({ itemNodeId: "x", body: "b" }, {} as never);
    expect(rpcCalls[0]).toEqual({ method: RPC.comment, params: { itemNodeId: "x", body: "b" } });
  });

  test("a reverse-RPC error maps to a toolError", async () => {
    rpcShouldThrow = true;
    const res = await tools.list_tickets!({}, {} as never);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("rpc boom");
  });

  test("a null rpc response yields an empty-object result", async () => {
    rpcResponse = null;
    const res = await tools.archive_ticket!({ itemNodeId: "x" }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe("{}");
  });
});

// ── fmtTime ──────────────────────────────────────────────────────────

describe("fmtTime", () => {
  test("formats an ISO timestamp + handles null", () => {
    expect(fmtTime("2026-06-24T08:15:30Z")).toBe("2026-06-24 08:15");
    expect(fmtTime(null)).toBe("—");
    expect(fmtTime(undefined)).toBe("—");
  });
});

// ── buildDashboard (pure render) ─────────────────────────────────────

function proposalView(over: Partial<ProposalView> = {}): ProposalView {
  return {
    id: "prop-1",
    title: "Ship it",
    status: "pending",
    action: "execute",
    statusName: "In Progress",
    ticketUrl: null,
    conversationId: null,
    boardTitle: "Roadmap",
    proposedAt: "2026-06-21T08:00:00Z",
    ...over,
  };
}

function findNode(nodes: unknown[], pred: (n: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  for (const n of nodes) {
    const node = n as Record<string, unknown>;
    if (pred(node)) return node;
    if (Array.isArray(node.nodes)) {
      const inner = findNode(node.nodes as unknown[], pred);
      if (inner) return inner;
    }
  }
  return undefined;
}

describe("buildDashboard", () => {
  test("empty state when no boards are connected", () => {
    const tree = buildDashboard({ proposals: [], boards: [] });
    expect(tree.title).toBe("GitHub Projects");
    const empty = findNode(tree.nodes, (n) => n.type === "empty-state");
    expect(empty?.title).toContain("No boards connected");
    // A Refresh button is always present.
    expect(findNode(tree.nodes, (n) => n.type === "button" && (n.action as { event?: string })?.event === REFRESH_EVENT)).toBeTruthy();
  });

  test("pending proposals get an Approve row action + a Dismiss button", () => {
    const data: DashboardData = {
      proposals: [proposalView({ id: "p-pending", status: "pending" })],
      boards: [
        { linkId: "l1", boardTitle: "Roadmap", boardUrl: "u", enabled: true, lastPolledAt: null, lastError: null },
      ],
    };
    const tree = buildDashboard(data);
    // Approve action on the active-work table row.
    const table = findNode(tree.nodes, (n) => n.type === "table" && Array.isArray(n.rows) && (n.rows as unknown[]).some((r) => (r as { action?: { event?: string } }).action?.event === APPROVE_EVENT));
    expect(table).toBeTruthy();
    const approveRow = (table!.rows as Array<{ action?: { event?: string; payload?: Record<string, unknown> } }>).find((r) => r.action?.event === APPROVE_EVENT);
    expect(approveRow!.action!.payload).toEqual({ proposalId: "p-pending" });
    // Dismiss button.
    const dismiss = findNode(tree.nodes, (n) => n.type === "button" && (n.action as { event?: string })?.event === DISMISS_EVENT);
    expect((dismiss!.action as { payload?: Record<string, unknown> }).payload).toEqual({ proposalId: "p-pending" });
  });

  test("running proposals link to their conversation; terminal go to History", () => {
    const data: DashboardData = {
      proposals: [
        proposalView({ id: "run", status: "running", conversationId: "conv-9" }),
        // A running proposal with NO conversation yet (just-spawned) → plain row.
        proposalView({ id: "spawned", status: "spawned", conversationId: null }),
        proposalView({ id: "done", status: "done", conversationId: "conv-7" }),
        // A terminal proposal with no conversation → plain History row.
        proposalView({ id: "failed", status: "failed", conversationId: null }),
      ],
      boards: [
        { linkId: "l1", boardTitle: "Roadmap", boardUrl: "u", enabled: true, lastPolledAt: "2026-06-24T00:00:00Z", lastError: null },
      ],
    };
    const tree = buildDashboard(data);
    const link = findNode(tree.nodes, (n) => n.type === "table" && (n.rows as Array<{ href?: string }>)?.some((r) => r.href === "/chat/conv-9"));
    expect(link).toBeTruthy();
    const hist = findNode(tree.nodes, (n) => n.type === "table" && (n.rows as Array<{ href?: string }>)?.some((r) => r.href === "/chat/conv-7"));
    expect(hist).toBeTruthy();
    // The spawned/failed rows with no conversationId render without an href.
    const activeTable = findNode(tree.nodes, (n) => n.type === "table" && (n.rows as Array<{ cells: string[] }>)?.some((r) => r.cells.includes("Ship it")));
    expect(activeTable).toBeTruthy();
  });

  test("connection health renders a Pause toggle + Reconnect on error", () => {
    const data: DashboardData = {
      proposals: [],
      boards: [
        { linkId: "l1", boardTitle: "Roadmap", boardUrl: "u", enabled: true, lastPolledAt: "2026-06-24T00:00:00Z", lastError: "401 unauthorized" },
      ],
    };
    const tree = buildDashboard(data);
    const pause = findNode(tree.nodes, (n) => n.type === "button" && (n.action as { event?: string })?.event === PAUSE_EVENT);
    expect((pause!.action as { payload?: Record<string, unknown> }).payload).toEqual({ linkId: "l1" });
    const reconnect = findNode(tree.nodes, (n) => n.type === "link" && typeof n.href === "string");
    expect(reconnect).toBeTruthy();
  });

  test("a paused board renders a Resume toggle", () => {
    const data: DashboardData = {
      proposals: [],
      boards: [
        { linkId: "l2", boardTitle: "Paused", boardUrl: "u", enabled: false, lastPolledAt: null, lastError: null },
      ],
    };
    const tree = buildDashboard(data);
    const resume = findNode(tree.nodes, (n) => n.type === "button" && (n.action as { event?: string })?.event === RESUME_EVENT);
    expect((resume!.action as { payload?: Record<string, unknown> }).payload).toEqual({ linkId: "l2" });
  });
});

// ── fetchDashboardData ───────────────────────────────────────────────

describe("fetchDashboardData", () => {
  test("normalizes the host response", async () => {
    rpcResponse = { proposals: [proposalView()], boards: [{ linkId: "l" }] };
    const data = await fetchDashboardData();
    expect(rpcCalls[0]!.method).toBe(RPC.dashboardData);
    expect(data.proposals.length).toBe(1);
    expect(data.boards.length).toBe(1);
  });

  test("fails soft to empty arrays on a reverse-RPC error", async () => {
    rpcShouldThrow = true;
    const data = await fetchDashboardData();
    expect(data).toEqual({ proposals: [], boards: [] });
  });

  test("tolerates a malformed response", async () => {
    rpcResponse = { proposals: "nope", boards: null };
    const data = await fetchDashboardData();
    expect(data).toEqual({ proposals: [], boards: [] });
  });
});

// ── renderDashboard ──────────────────────────────────────────────────

test("renderDashboard pulls data + builds the tree", async () => {
  rpcResponse = { proposals: [], boards: [] };
  const tree = await renderDashboard();
  expect(tree.title).toBe("GitHub Projects");
});

// ── Page-action handlers ─────────────────────────────────────────────

function actionEvent(payload: Record<string, unknown>) {
  return { source: "hub" as const, pageId: PAGE_ID, userId: "user-1", payload };
}

describe("page-action handlers", () => {
  test("approve calls the approve verb then pushes a refreshed page", async () => {
    rpcResponse = { proposals: [], boards: [] };
    await handleApprove(actionEvent({ proposalId: "p1" }));
    expect(rpcCalls.some((c) => c.method === RPC.approve && c.params.proposalId === "p1")).toBe(true);
    // dashboard-data re-pull + a push.
    expect(rpcCalls.some((c) => c.method === RPC.dashboardData)).toBe(true);
    expect(pushes.length).toBe(1);
    expect(pushes[0]!.pageId).toBe(PAGE_ID);
  });

  test("approve is a no-op without a proposalId", async () => {
    await handleApprove(actionEvent({}));
    expect(rpcCalls.length).toBe(0);
    expect(pushes.length).toBe(0);
  });

  test("dismiss calls the dismiss verb + pushes", async () => {
    rpcResponse = { proposals: [], boards: [] };
    await handleDismiss(actionEvent({ proposalId: "p2" }));
    expect(rpcCalls.some((c) => c.method === RPC.dismiss && c.params.proposalId === "p2")).toBe(true);
    expect(pushes.length).toBe(1);
  });

  test("pause + resume call their verbs + push", async () => {
    rpcResponse = { proposals: [], boards: [] };
    await handlePause(actionEvent({ linkId: "l1" }));
    expect(rpcCalls.some((c) => c.method === RPC.pause && c.params.linkId === "l1")).toBe(true);
    rpcCalls = [];
    pushes.length = 0;
    await handleResume(actionEvent({ linkId: "l1" }));
    expect(rpcCalls.some((c) => c.method === RPC.resume && c.params.linkId === "l1")).toBe(true);
    expect(pushes.length).toBe(1);
  });

  test("pause/resume are no-ops without a linkId", async () => {
    await handlePause(actionEvent({}));
    await handleResume(actionEvent({}));
    expect(rpcCalls.length).toBe(0);
    expect(pushes.length).toBe(0);
  });

  test("a control reverse-RPC error still pushes a refreshed page (fail-soft)", async () => {
    // The control call throws, but the subsequent dashboard-data pull succeeds.
    let firstCall = true;
    _setRpcForTests(async (method) => {
      if (firstCall) {
        firstCall = false;
        throw new Error("approve failed");
      }
      void method;
      return { proposals: [], boards: [] };
    });
    await handleApprove(actionEvent({ proposalId: "p1" }));
    expect(pushes.length).toBe(1);
  });

  test("handleRefresh re-pulls + pushes", async () => {
    rpcResponse = { proposals: [], boards: [] };
    await handleRefresh();
    expect(rpcCalls.some((c) => c.method === RPC.dashboardData)).toBe(true);
    expect(pushes.length).toBe(1);
  });
});

// ── register() + start() wiring ──────────────────────────────────────

describe("register / start", () => {
  test("register() wires the page, tools, and the proposal-update channel handler", async () => {
    // Capture every onRequest registration so we can invoke the custom
    // proposal-update handler register() installs directly on the channel.
    const ch = getChannel() as HostChannel;
    const handlers = new Map<string, (params: unknown) => unknown>();
    const originalOnRequest = ch.onRequest.bind(ch);
    ch.onRequest = (method: string, handler: (params: unknown) => unknown) => {
      handlers.set(method, handler);
      return originalOnRequest(method, handler);
    };
    try {
      rpcResponse = { proposals: [], boards: [] };
      expect(() => register()).not.toThrow();
      // The daemon proposal-update event handler was registered on the channel.
      const evtHandler = handlers.get(`ezcorp/event/${GITHUB_PROJECTS_EVENT}`);
      expect(evtHandler).toBeTruthy();
      // Invoking it re-pulls + pushes (covers the inner handleRefresh call).
      await evtHandler!(undefined);
      expect(pushes.length).toBe(1);
    } finally {
      ch.onRequest = originalOnRequest;
    }
  });

  test("start() registers and starts the channel", () => {
    const ch = getChannel() as HostChannel;
    let started = false;
    const originalStart = ch.start.bind(ch);
    ch.start = () => {
      started = true;
    };
    try {
      expect(() => start()).not.toThrow();
      expect(started).toBe(true);
    } finally {
      ch.start = originalStart;
    }
  });
});
