/**
 * Unit tests for progress.ts — pure builders + best-effort side-effects.
 *
 * 100% line coverage required (new file, per the feature contract).
 *
 * - Pure functions (builders, extractPrUrl, summarize) tested directly with no
 *   mocks needed.
 * - Side-effect functions (postTicketComment, moveCardOnDone) are tested with
 *   injected `deps` (fake client + fake auth resolver) so no network is needed.
 */
import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "../../../__tests__/helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Module stubs ────────────────────────────────────────────────────────────
// Mock the logger AND the upstream imports that progress.ts imports at module
// scope (client and auth) so the module can be loaded without side-effects.

const logStub = { info() {}, warn() {}, error() {}, debug() {} };

function installMocks(): void {
  mock.module("../../../logger", () => ({
    logger: { child: () => logStub },
    extensionLogger: () => logStub,
  }));
  // Provide stubs for the default client/auth used when no deps are injected.
  // Tests exercise the injected path, but these stubs keep the module loadable.
  mock.module("../client", () => ({
    createGithubClient: () => ({
      addComment: mock(() => Promise.resolve()),
      setItemStatus: mock(() => Promise.resolve()),
    }),
  }));
  mock.module("../auth", () => ({
    resolveLinkAuth: mock(() => Promise.resolve({ mode: "pat", token: "tok" })),
  }));
  // The secrets store is a transitive dep of auth — stub it too.
  mock.module("../../../extensions/secrets-store", () => ({
    getSecret: mock(() => Promise.resolve("tok")),
  }));
}

installMocks();

const {
  actionVerb,
  buildStartComment,
  buildDoneComment,
  buildFailedComment,
  extractPrUrl,
  summarize,
  postTicketComment,
  moveCardOnDone,
} = await import("../progress");

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeLink(over: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    projectId: "proj-1",
    boardNodeId: "PVT_board",
    boardUrl: "https://github.com/orgs/acme/projects/1",
    boardTitle: "Acme Board",
    ownerLogin: "acme",
    statusFieldId: "field-1",
    statusOptions: [],
    defaultModel: null,
    authMode: "pat" as const,
    columnActionMap: {},
    pollCursor: null,
    pollIntervalSec: 60,
    enabled: true,
    lastPolledAt: null,
    lastError: null,
    lastErrorAt: null,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function makeProposal(over: Record<string, unknown> = {}) {
  return {
    id: "prop-1",
    projectId: "proj-1",
    linkId: "link-1",
    itemNodeId: "item-node-1",
    contentNodeId: "content-node-1",
    statusOptionId: "opt-doing",
    statusName: "Doing",
    action: "plan" as const,
    title: "Fix the bug",
    ticketUrl: "https://github.com/acme/repo/issues/42",
    dedupeKey: "dk-1",
    status: "running" as const,
    conversationId: "conv-1",
    agentRunId: "run-1",
    proposedAt: new Date(),
    decidedAt: null,
    decidedByUserId: null,
    finishedAt: null,
    error: null,
    createdAt: new Date(),
    ...over,
  };
}

function makeFakeClient(opts: {
  addCommentImpl?: () => Promise<void>;
  setItemStatusImpl?: () => Promise<void>;
} = {}) {
  return {
    addComment: mock(opts.addCommentImpl ?? (() => Promise.resolve())),
    setItemStatus: mock(opts.setItemStatusImpl ?? (() => Promise.resolve())),
    // Satisfy the full GithubClient shape (unused by progress.ts but typed).
    resolveBoardFromUrl: mock(() => Promise.resolve({} as never)),
    validateAuth: mock(() => Promise.resolve({} as never)),
    fetchBoardItems: mock(() => Promise.resolve({} as never)),
    createIssueOnBoard: mock(() => Promise.resolve({} as never)),
    updateItem: mock(() => Promise.resolve({} as never)),
    archiveItem: mock(() => Promise.resolve()),
  };
}

function makeFakeAuth(token = "tok") {
  return mock(() => Promise.resolve({ mode: "pat" as const, token }));
}

beforeEach(() => {
  installMocks();
});

// ── actionVerb ───────────────────────────────────────────────────────────────

describe("actionVerb", () => {
  test("execute → implementing", () => {
    expect(actionVerb("execute")).toBe("implementing");
  });
  test("plan → planning", () => {
    expect(actionVerb("plan")).toBe("planning");
  });
});

// ── buildStartComment ────────────────────────────────────────────────────────

describe("buildStartComment", () => {
  test("plan proposal → 'planning' verb", () => {
    const c = buildStartComment(makeProposal({ action: "plan" }) as never);
    expect(c).toContain("planning");
    expect(c).toContain("EZCorp");
  });
  test("execute proposal → 'implementing' verb", () => {
    const c = buildStartComment(makeProposal({ action: "execute" }) as never);
    expect(c).toContain("implementing");
  });
});

// ── buildDoneComment ─────────────────────────────────────────────────────────

describe("buildDoneComment", () => {
  test("plan proposal → 'Plan ready' heading", () => {
    const c = buildDoneComment(makeProposal({ action: "plan" }) as never);
    expect(c).toContain("Plan ready");
    expect(c).not.toContain("Pull request:");
  });
  test("execute proposal → 'Work complete' heading", () => {
    const c = buildDoneComment(makeProposal({ action: "execute" }) as never);
    expect(c).toContain("Work complete");
  });
  test("includes summary when provided", () => {
    const c = buildDoneComment(makeProposal() as never, { summary: "Did the thing." });
    expect(c).toContain("Did the thing.");
  });
  test("includes PR url when provided", () => {
    const c = buildDoneComment(makeProposal() as never, {
      prUrl: "https://github.com/acme/repo/pull/99",
    });
    expect(c).toContain("Pull request:");
    expect(c).toContain("https://github.com/acme/repo/pull/99");
  });
  test("empty opts → no summary or PR line", () => {
    const c = buildDoneComment(makeProposal() as never, {});
    expect(c).not.toContain("Pull request:");
  });
});

// ── buildFailedComment ───────────────────────────────────────────────────────

describe("buildFailedComment", () => {
  test("no error → generic failed message", () => {
    const c = buildFailedComment(makeProposal() as never);
    expect(c).toContain("❌");
    expect(c).toContain("Run failed");
    expect(c).not.toContain(":"); // no extra colon when no error detail
  });
  test("error string included in the comment", () => {
    const c = buildFailedComment(makeProposal() as never, "network timeout");
    expect(c).toContain("network timeout");
  });
});

// ── extractPrUrl ─────────────────────────────────────────────────────────────

describe("extractPrUrl", () => {
  test("matches a GitHub PR url in plain text", () => {
    const text = "Done! See https://github.com/acme/repo/pull/42 for the PR.";
    expect(extractPrUrl(text)).toBe("https://github.com/acme/repo/pull/42");
  });
  test("returns null when no PR url present", () => {
    expect(extractPrUrl("No PR here.")).toBeNull();
  });
  test("returns null for null input", () => {
    expect(extractPrUrl(null)).toBeNull();
  });
  test("returns null for undefined input", () => {
    expect(extractPrUrl(undefined)).toBeNull();
  });
  test("picks the FIRST url when multiple are present", () => {
    const text =
      "First https://github.com/acme/repo/pull/1 and then https://github.com/acme/repo/pull/2";
    expect(extractPrUrl(text)).toBe("https://github.com/acme/repo/pull/1");
  });
  test("does not match issue URLs (only /pull/)", () => {
    expect(extractPrUrl("https://github.com/acme/repo/issues/42")).toBeNull();
  });
});

// ── summarize ────────────────────────────────────────────────────────────────

describe("summarize", () => {
  test("short text returned as-is (no truncation)", () => {
    expect(summarize("hello")).toBe("hello");
  });
  test("text over the cap is truncated with ellipsis", () => {
    const long = "a".repeat(601);
    const result = summarize(long, 600);
    expect(result.length).toBe(601); // 600 chars + ellipsis char
    expect(result.endsWith("…")).toBe(true);
  });
  test("text exactly at cap is NOT truncated", () => {
    const exactly = "b".repeat(600);
    const result = summarize(exactly, 600);
    expect(result).toBe(exactly);
    expect(result.endsWith("…")).toBe(false);
  });
  test("null → empty string", () => {
    expect(summarize(null)).toBe("");
  });
  test("undefined → empty string", () => {
    expect(summarize(undefined)).toBe("");
  });
  test("blank / whitespace-only → empty string", () => {
    expect(summarize("   ")).toBe("");
    expect(summarize("\n\t")).toBe("");
  });
  test("leading/trailing whitespace is trimmed", () => {
    expect(summarize("  hello  ")).toBe("hello");
  });
  test("custom max cap", () => {
    const result = summarize("abcdefgh", 4);
    expect(result).toBe("abcd…");
  });
});

// ── postTicketComment ────────────────────────────────────────────────────────

describe("postTicketComment", () => {
  test("posts when contentNodeId is set — returns true", async () => {
    const client = makeFakeClient();
    const auth = makeFakeAuth();
    const result = await postTicketComment(
      makeLink() as never,
      makeProposal({ contentNodeId: "CN-1" }) as never,
      "body text",
      { client, resolveAuth: auth },
    );
    expect(result).toBe(true);
    expect(client.addComment).toHaveBeenCalledTimes(1);
    const [, nodeId, body] = client.addComment.mock.calls[0]!;
    expect(nodeId).toBe("CN-1");
    expect(body).toBe("body text");
  });

  test("skips (returns false) when contentNodeId is null (draft card)", async () => {
    const client = makeFakeClient();
    const auth = makeFakeAuth();
    const result = await postTicketComment(
      makeLink() as never,
      makeProposal({ contentNodeId: null }) as never,
      "body",
      { client, resolveAuth: auth },
    );
    expect(result).toBe(false);
    expect(client.addComment).not.toHaveBeenCalled();
  });

  test("auth resolve throws → swallowed, returns false", async () => {
    const client = makeFakeClient();
    const failingAuth = mock(() => Promise.reject(new Error("no PAT")));
    const result = await postTicketComment(
      makeLink() as never,
      makeProposal({ contentNodeId: "CN-1" }) as never,
      "body",
      { client, resolveAuth: failingAuth },
    );
    expect(result).toBe(false);
    expect(client.addComment).not.toHaveBeenCalled();
  });

  test("addComment throws → swallowed, returns false", async () => {
    const client = makeFakeClient({
      addCommentImpl: () => Promise.reject(new Error("network error")),
    });
    const auth = makeFakeAuth();
    const result = await postTicketComment(
      makeLink() as never,
      makeProposal({ contentNodeId: "CN-1" }) as never,
      "body",
      { client, resolveAuth: auth },
    );
    expect(result).toBe(false);
  });
});

// ── moveCardOnDone ───────────────────────────────────────────────────────────

describe("moveCardOnDone", () => {
  test("moves when doneStatusOptionId is set — returns true", async () => {
    const client = makeFakeClient();
    const auth = makeFakeAuth();
    const column = { action: "plan" as const, autoSpawn: false, doneStatusOptionId: "opt-done" };
    const result = await moveCardOnDone(
      makeLink() as never,
      makeProposal() as never,
      column as never,
      { client, resolveAuth: auth },
    );
    expect(result).toBe(true);
    expect(client.setItemStatus).toHaveBeenCalledTimes(1);
    const [boardId, , itemId, optionId] = client.setItemStatus.mock.calls[0]!;
    expect(boardId).toBe("PVT_board");
    expect(itemId).toBe("item-node-1");
    expect(optionId).toBe("opt-done");
  });

  test("no-op (returns false) when column is undefined", async () => {
    const client = makeFakeClient();
    const auth = makeFakeAuth();
    const result = await moveCardOnDone(
      makeLink() as never,
      makeProposal() as never,
      undefined,
      { client, resolveAuth: auth },
    );
    expect(result).toBe(false);
    expect(client.setItemStatus).not.toHaveBeenCalled();
  });

  test("no-op (returns false) when column has no doneStatusOptionId", async () => {
    const client = makeFakeClient();
    const auth = makeFakeAuth();
    const column = { action: "plan" as const, autoSpawn: false }; // no doneStatusOptionId
    const result = await moveCardOnDone(
      makeLink() as never,
      makeProposal() as never,
      column as never,
      { client, resolveAuth: auth },
    );
    expect(result).toBe(false);
    expect(client.setItemStatus).not.toHaveBeenCalled();
  });

  test("setItemStatus throws → swallowed, returns false", async () => {
    const client = makeFakeClient({
      setItemStatusImpl: () => Promise.reject(new Error("api down")),
    });
    const auth = makeFakeAuth();
    const column = { action: "plan" as const, autoSpawn: false, doneStatusOptionId: "opt-done" };
    const result = await moveCardOnDone(
      makeLink() as never,
      makeProposal() as never,
      column as never,
      { client, resolveAuth: auth },
    );
    expect(result).toBe(false);
  });
});
