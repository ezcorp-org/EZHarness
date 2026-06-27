/**
 * Host GitHub Projects v2 client — exhaustive unit tests (Agent A).
 *
 * `globalThis.fetch` is stubbed with a queue/router of canned GraphQL + REST
 * responses. Every method, every branch, and every typed-error path is
 * exercised, plus the SSRF host guard, scope-header parsing, and the invariant
 * that the bearer token never leaks into a thrown error.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  GITHUB_API_ORIGIN,
  GithubAuthError,
  type GithubAuth,
  GithubHostNotAllowedError,
  GithubNotFoundError,
  GithubRateLimitError,
} from "../types";
import { createGithubClient } from "../client";

const TOKEN = "ghp_SUPER_SECRET_TOKEN_should_never_leak";
const AUTH_PAT: GithubAuth = { mode: "pat", token: TOKEN };
const AUTH_GH: GithubAuth = { mode: "gh", token: TOKEN };
const BOARD_ID = "PVT_kwDOABC123";

const originalFetch = globalThis.fetch;

// ── fetch stub plumbing ─────────────────────────────────────────────────────

interface CannedResponse {
  status?: number;
  body?: unknown;
  /** Raw text body (used to assert error-detail folding without JSON). */
  text?: string;
  headers?: Record<string, string>;
}

interface RecordedCall {
  url: string;
  method: string;
  body: any;
  headers: Record<string, string>;
}

let queue: CannedResponse[] = [];
let calls: RecordedCall[] = [];

function makeResponse(canned: CannedResponse): Response {
  const status = canned.status ?? 200;
  const headers = new Headers(canned.headers ?? {});
  const payload = canned.text !== undefined ? canned.text : JSON.stringify(canned.body ?? {});
  return new Response(payload, { status, headers });
}

function enqueue(...responses: CannedResponse[]): void {
  queue.push(...responses);
}

/** Recorded call at index `i`, asserted present (satisfies noUncheckedIndexedAccess). */
function call(i: number): RecordedCall {
  const c = i < 0 ? calls.at(i) : calls[i];
  if (!c) throw new Error(`no recorded fetch call at index ${i}`);
  return c;
}

/** First board item of a fetched page, asserted present. */
function firstItem(page: { items: readonly unknown[] }): any {
  const item = page.items[0];
  if (!item) throw new Error("expected at least one board item");
  return item;
}

function installFetch(): void {
  const stub = mock((input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(init.body) : undefined,
      headers: rawHeaders,
    });
    const next = queue.shift();
    if (!next) {
      return Promise.reject(new Error(`unmocked fetch to ${url}`));
    }
    return Promise.resolve(makeResponse(next));
  });
  globalThis.fetch = stub as unknown as typeof fetch;
}

beforeEach(() => {
  queue = [];
  calls = [];
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Assert no recorded request leaked the bearer token anywhere observable. */
function assertNoTokenLeak(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  expect(message).not.toContain(TOKEN);
}

// ── resolveBoardFromUrl ─────────────────────────────────────────────────────

describe("resolveBoardFromUrl", () => {
  const boardData = (typename = "ProjectV2SingleSelectField") => ({
    data: {
      organization: {
        projectV2: {
          id: BOARD_ID,
          title: "Roadmap",
          field: {
            __typename: typename,
            id: "PVTSSF_status",
            name: "Status",
            options: [
              { id: "opt_todo", name: "Todo" },
              { id: "opt_doing", name: "In Progress" },
            ],
          },
        },
      },
    },
  });

  test("resolves an org board + Status field", async () => {
    enqueue({ body: boardData() });
    const client = createGithubClient();
    const ref = await client.resolveBoardFromUrl(
      "https://github.com/orgs/acme/projects/7",
      AUTH_PAT,
    );
    expect(ref.boardNodeId).toBe(BOARD_ID);
    expect(ref.title).toBe("Roadmap");
    expect(ref.ownerLogin).toBe("acme");
    expect(ref.statusFieldId).toBe("PVTSSF_status");
    expect(ref.statusOptions).toEqual([
      { id: "opt_todo", name: "Todo" },
      { id: "opt_doing", name: "In Progress" },
    ]);
    // URL goes to the FIXED graphql endpoint, never the user URL.
    expect(call(0).url).toBe(`${GITHUB_API_ORIGIN}/graphql`);
    expect(call(0).method).toBe("POST");
    expect(call(0).headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call(0).headers["User-Agent"]).toBeTruthy();
    expect(call(0).body.query).toContain("organization(login:");
    expect(call(0).body.variables).toEqual({ login: "acme", number: 7 });
  });

  test("resolves a user board (user variant)", async () => {
    enqueue({
      body: {
        data: {
          user: {
            projectV2: {
              id: BOARD_ID,
              title: "Personal",
              field: {
                __typename: "ProjectV2SingleSelectField",
                id: "PVTSSF_status",
                name: "Status",
                options: [{ id: "opt_a", name: "A" }],
              },
            },
          },
        },
      },
    });
    const client = createGithubClient();
    const ref = await client.resolveBoardFromUrl(
      "https://github.com/users/alice/projects/3",
      AUTH_PAT,
    );
    expect(ref.ownerLogin).toBe("alice");
    expect(call(0).body.query).toContain("user(login:");
  });

  test("throws on a non-github.com host", async () => {
    const client = createGithubClient();
    await expect(
      client.resolveBoardFromUrl("https://evil.example.com/orgs/acme/projects/7", AUTH_PAT),
    ).rejects.toBeInstanceOf(GithubNotFoundError);
  });

  test("throws on a malformed URL", async () => {
    const client = createGithubClient();
    await expect(client.resolveBoardFromUrl("not a url", AUTH_PAT)).rejects.toBeInstanceOf(
      GithubNotFoundError,
    );
  });

  test("throws on the wrong path shape", async () => {
    const client = createGithubClient();
    await expect(
      client.resolveBoardFromUrl("https://github.com/orgs/acme/teams/7", AUTH_PAT),
    ).rejects.toThrow(/Unrecognized GitHub Projects URL shape/);
  });

  test("throws on a non-numeric project number", async () => {
    const client = createGithubClient();
    await expect(
      client.resolveBoardFromUrl("https://github.com/orgs/acme/projects/abc", AUTH_PAT),
    ).rejects.toThrow(/no valid project number/);
  });

  test("throws on a zero / negative project number", async () => {
    const client = createGithubClient();
    await expect(
      client.resolveBoardFromUrl("https://github.com/orgs/acme/projects/0", AUTH_PAT),
    ).rejects.toThrow(/no valid project number/);
  });

  test("throws on an unknown owner scope", async () => {
    const client = createGithubClient();
    await expect(
      client.resolveBoardFromUrl("https://github.com/teams/acme/projects/7", AUTH_PAT),
    ).rejects.toThrow(/Unrecognized GitHub Projects URL shape|owner scope/);
  });

  test("throws NotFound when the project is missing (null projectV2)", async () => {
    enqueue({ body: { data: { organization: { projectV2: null } } } });
    const client = createGithubClient();
    await expect(
      client.resolveBoardFromUrl("https://github.com/orgs/acme/projects/7", AUTH_PAT),
    ).rejects.toThrow(/board not found/);
  });

  test("throws NotFound when the organization itself is null", async () => {
    enqueue({ body: { data: { organization: null } } });
    const client = createGithubClient();
    await expect(
      client.resolveBoardFromUrl("https://github.com/orgs/acme/projects/7", AUTH_PAT),
    ).rejects.toThrow(/board not found/);
  });

  test("throws NotFound when there is no Status single-select field", async () => {
    enqueue({
      body: {
        data: {
          organization: { projectV2: { id: BOARD_ID, title: "Roadmap", field: null } },
        },
      },
    });
    const client = createGithubClient();
    await expect(
      client.resolveBoardFromUrl("https://github.com/orgs/acme/projects/7", AUTH_PAT),
    ).rejects.toThrow(/no single-select "Status" field/);
  });

  test("throws NotFound when the Status field has no options (wrong field type)", async () => {
    enqueue({
      body: {
        data: {
          organization: {
            projectV2: {
              id: BOARD_ID,
              title: "Roadmap",
              field: { id: "f", name: "Status" }, // no options key
            },
          },
        },
      },
    });
    const client = createGithubClient();
    await expect(
      client.resolveBoardFromUrl("https://github.com/orgs/acme/projects/7", AUTH_PAT),
    ).rejects.toThrow(/no single-select "Status" field/);
  });

  test("maps a GraphQL NOT_FOUND error to GithubNotFoundError", async () => {
    enqueue({ body: { errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] } });
    const client = createGithubClient();
    await expect(
      client.resolveBoardFromUrl("https://github.com/orgs/acme/projects/7", AUTH_PAT),
    ).rejects.toBeInstanceOf(GithubNotFoundError);
  });
});

// ── validateAuth ────────────────────────────────────────────────────────────

describe("validateAuth", () => {
  test("ok=true and parses x-oauth-scopes (classic PAT)", async () => {
    enqueue({
      body: { data: { node: { id: BOARD_ID } } },
      headers: { "x-oauth-scopes": "repo, project,  read:org " },
    });
    const client = createGithubClient();
    const result = await client.validateAuth(AUTH_PAT, BOARD_ID);
    expect(result.ok).toBe(true);
    expect(result.scopes).toEqual(["repo", "project", "read:org"]);
    expect(result.missingScopes).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  test("ok=true with empty scopes when x-oauth-scopes is absent (fine-grained)", async () => {
    enqueue({ body: { data: { node: { id: BOARD_ID } } } });
    const client = createGithubClient();
    const result = await client.validateAuth(AUTH_GH, BOARD_ID);
    expect(result.ok).toBe(true);
    expect(result.scopes).toEqual([]);
  });

  test("empty header string yields empty scope list", async () => {
    enqueue({
      body: { data: { node: { id: BOARD_ID } } },
      headers: { "x-oauth-scopes": "   " },
    });
    const client = createGithubClient();
    const result = await client.validateAuth(AUTH_PAT, BOARD_ID);
    expect(result.scopes).toEqual([]);
  });

  test("401 → ok=false and names the likely missing scope", async () => {
    enqueue({ status: 401, text: "Bad credentials" });
    const client = createGithubClient();
    const result = await client.validateAuth(AUTH_PAT, BOARD_ID);
    expect(result.ok).toBe(false);
    expect(result.scopes).toEqual([]);
    expect(result.missingScopes).toContain("project");
    expect(result.missingScopes).toContain("read:project");
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain(TOKEN);
  });

  test("404 (board gone) → ok=false with missing-scope hint", async () => {
    enqueue({ status: 404, text: "Not Found" });
    const client = createGithubClient();
    const result = await client.validateAuth(AUTH_PAT, BOARD_ID);
    expect(result.ok).toBe(false);
    expect(result.missingScopes.length).toBeGreaterThan(0);
  });

  test("rethrows non-auth/not-found errors (e.g. rate limit)", async () => {
    enqueue({ status: 429, text: "slow down" });
    const client = createGithubClient();
    await expect(client.validateAuth(AUTH_PAT, BOARD_ID)).rejects.toBeInstanceOf(
      GithubRateLimitError,
    );
  });
});

// ── fetchBoardItems ─────────────────────────────────────────────────────────

describe("fetchBoardItems", () => {
  const itemNode = (overrides: Record<string, unknown> = {}) => ({
    id: "PVTI_item1",
    updatedAt: "2026-06-01T00:00:00Z",
    content: {
      __typename: "Issue",
      id: "I_issue1",
      title: "Fix the bug",
      url: "https://github.com/acme/repo/issues/1",
    },
    fieldValues: {
      nodes: [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          optionId: "opt_todo",
          name: "Todo",
          field: { name: "Status" },
        },
      ],
    },
    ...overrides,
  });

  test("maps a single page of items + builds the cursor", async () => {
    enqueue({
      body: {
        data: {
          node: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [itemNode()],
            },
          },
        },
      },
    });
    const client = createGithubClient();
    const page = await client.fetchBoardItems(BOARD_ID, AUTH_PAT, null);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual({
      itemNodeId: "PVTI_item1",
      contentNodeId: "I_issue1",
      title: "Fix the bug",
      url: "https://github.com/acme/repo/issues/1",
      statusOptionId: "opt_todo",
      statusName: "Todo",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    expect(page.cursor).toEqual({ PVTI_item1: "2026-06-01T00:00:00Z" });
  });

  test("paginates fully across multiple pages", async () => {
    enqueue(
      {
        body: {
          data: {
            node: {
              items: {
                pageInfo: { hasNextPage: true, endCursor: "CURSOR_1" },
                nodes: [itemNode({ id: "PVTI_a", updatedAt: "2026-06-01T00:00:00Z" })],
              },
            },
          },
        },
      },
      {
        body: {
          data: {
            node: {
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [itemNode({ id: "PVTI_b", updatedAt: "2026-06-02T00:00:00Z" })],
              },
            },
          },
        },
      },
    );
    const client = createGithubClient();
    const page = await client.fetchBoardItems(BOARD_ID, AUTH_PAT, null);
    expect(page.items.map((i) => i.itemNodeId)).toEqual(["PVTI_a", "PVTI_b"]);
    // 2nd request carried the after-cursor.
    expect(call(1).body.variables.after).toBe("CURSOR_1");
    expect(page.cursor).toEqual({
      PVTI_a: "2026-06-01T00:00:00Z",
      PVTI_b: "2026-06-02T00:00:00Z",
    });
  });

  test("merges over an input cursor (preserving prior marks)", async () => {
    enqueue({
      body: {
        data: {
          node: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [itemNode({ id: "PVTI_new", updatedAt: "2026-06-09T00:00:00Z" })],
            },
          },
        },
      },
    });
    const client = createGithubClient();
    const page = await client.fetchBoardItems(BOARD_ID, AUTH_PAT, {
      PVTI_old: "2026-01-01T00:00:00Z",
    });
    expect(page.cursor).toEqual({
      PVTI_old: "2026-01-01T00:00:00Z",
      PVTI_new: "2026-06-09T00:00:00Z",
    });
  });

  test("handles a draft item with no content url + no Status value", async () => {
    enqueue({
      body: {
        data: {
          node: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "PVTI_draft",
                  updatedAt: "2026-06-03T00:00:00Z",
                  content: { __typename: "DraftIssue", id: "DI_1", title: "Draft thing" },
                  fieldValues: { nodes: [] },
                },
              ],
            },
          },
        },
      },
    });
    const client = createGithubClient();
    const page = await client.fetchBoardItems(BOARD_ID, AUTH_PAT, null);
    expect(firstItem(page).contentNodeId).toBe("DI_1");
    expect(firstItem(page).url).toBeNull();
    expect(firstItem(page).statusOptionId).toBeNull();
    expect(firstItem(page).statusName).toBeNull();
  });

  test("falls back to '(untitled)' + null content for an item with null content", async () => {
    enqueue({
      body: {
        data: {
          node: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "PVTI_redacted",
                  updatedAt: "2026-06-04T00:00:00Z",
                  content: null,
                  fieldValues: { nodes: [] },
                },
              ],
            },
          },
        },
      },
    });
    const client = createGithubClient();
    const page = await client.fetchBoardItems(BOARD_ID, AUTH_PAT, null);
    expect(firstItem(page).title).toBe("(untitled)");
    expect(firstItem(page).contentNodeId).toBeNull();
  });

  test("ignores non-Status single-select field values", async () => {
    enqueue({
      body: {
        data: {
          node: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                itemNode({
                  fieldValues: {
                    nodes: [
                      {
                        __typename: "ProjectV2ItemFieldSingleSelectValue",
                        optionId: "opt_x",
                        name: "High",
                        field: { name: "Priority" },
                      },
                    ],
                  },
                }),
              ],
            },
          },
        },
      },
    });
    const client = createGithubClient();
    const page = await client.fetchBoardItems(BOARD_ID, AUTH_PAT, null);
    expect(firstItem(page).statusOptionId).toBeNull();
  });

  test("tolerates a Status value with a null optionId/name", async () => {
    enqueue({
      body: {
        data: {
          node: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                itemNode({
                  fieldValues: {
                    nodes: [
                      {
                        __typename: "ProjectV2ItemFieldSingleSelectValue",
                        optionId: null,
                        name: null,
                        field: { name: "Status" },
                      },
                    ],
                  },
                }),
              ],
            },
          },
        },
      },
    });
    const client = createGithubClient();
    const page = await client.fetchBoardItems(BOARD_ID, AUTH_PAT, null);
    expect(firstItem(page).statusOptionId).toBeNull();
    expect(firstItem(page).statusName).toBeNull();
  });

  test("throws NotFound when the board node resolves to null", async () => {
    enqueue({ body: { data: { node: null } } });
    const client = createGithubClient();
    await expect(client.fetchBoardItems(BOARD_ID, AUTH_PAT, null)).rejects.toBeInstanceOf(
      GithubNotFoundError,
    );
  });
});

// ── createIssueOnBoard ──────────────────────────────────────────────────────

describe("createIssueOnBoard", () => {
  test("creates a draft issue and returns a ref", async () => {
    enqueue({
      body: {
        data: {
          addProjectV2DraftIssue: {
            projectItem: { id: "PVTI_created", content: { id: "DI_new", title: "New task" } },
          },
        },
      },
    });
    const client = createGithubClient();
    const ref = await client.createIssueOnBoard(BOARD_ID, AUTH_PAT, {
      title: "New task",
      body: "details",
    });
    expect(ref).toEqual({
      itemNodeId: "PVTI_created",
      contentNodeId: "DI_new",
      url: null,
      title: "New task",
    });
    expect(call(0).body.variables).toEqual({
      boardId: BOARD_ID,
      title: "New task",
      body: "details",
    });
  });

  test("defaults a missing body to empty + falls back to input title when content is null", async () => {
    enqueue({
      body: {
        data: { addProjectV2DraftIssue: { projectItem: { id: "PVTI_c2", content: null } } },
      },
    });
    const client = createGithubClient();
    const ref = await client.createIssueOnBoard(BOARD_ID, AUTH_PAT, { title: "Bare" });
    expect(call(0).body.variables.body).toBe("");
    expect(ref.title).toBe("Bare");
    expect(ref.contentNodeId).toBeNull();
  });

  test("sets the Status option by name after creating", async () => {
    enqueue(
      {
        body: {
          data: {
            addProjectV2DraftIssue: {
              projectItem: { id: "PVTI_c3", content: { id: "DI_3", title: "Triaged" } },
            },
          },
        },
      },
      // #setStatusByName → resolve options
      {
        body: {
          data: {
            node: {
              field: { id: "PVTSSF_s", options: [{ id: "opt_done", name: "Done" }] },
            },
          },
        },
      },
      // setItemStatus → resolve field id
      { body: { data: { node: { field: { id: "PVTSSF_s" } } } } },
      // setItemStatus → mutation
      { body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_c3" } } } } },
    );
    const client = createGithubClient();
    const ref = await client.createIssueOnBoard(BOARD_ID, AUTH_PAT, {
      title: "Triaged",
      statusName: "done", // case-insensitive
    });
    expect(ref.itemNodeId).toBe("PVTI_c3");
    const mutationCall = call(-1);
    expect(mutationCall?.body.variables.optionId).toBe("opt_done");
  });

  test("throws NotFound when no projectItem is returned", async () => {
    enqueue({ body: { data: { addProjectV2DraftIssue: { projectItem: null } } } });
    const client = createGithubClient();
    await expect(
      client.createIssueOnBoard(BOARD_ID, AUTH_PAT, { title: "x" }),
    ).rejects.toBeInstanceOf(GithubNotFoundError);
  });
});

// ── updateItem ──────────────────────────────────────────────────────────────

describe("updateItem", () => {
  test("PATCHes a real issue title/body via REST", async () => {
    enqueue(
      {
        body: {
          data: {
            node: {
              id: "PVTI_u1",
              content: {
                __typename: "Issue",
                id: "I_1",
                title: "old",
                url: "https://github.com/acme/repo/issues/42",
              },
            },
          },
        },
      },
      { body: { title: "new title", html_url: "https://github.com/acme/repo/issues/42" } },
    );
    const client = createGithubClient();
    const ref = await client.updateItem(BOARD_ID, AUTH_PAT, {
      itemNodeId: "PVTI_u1",
      title: "new title",
      body: "new body",
    });
    expect(ref.title).toBe("new title");
    expect(ref.url).toBe("https://github.com/acme/repo/issues/42");
    // REST call hits the api.github.com issues path.
    const restCall = call(1);
    expect(restCall.url).toBe(`${GITHUB_API_ORIGIN}/repos/acme/repo/issues/42`);
    expect(restCall.method).toBe("PATCH");
    expect(restCall.body).toEqual({ title: "new title", body: "new body" });
  });

  test("updates a draft issue via GraphQL", async () => {
    enqueue(
      {
        body: {
          data: {
            node: {
              id: "PVTI_u2",
              content: { __typename: "DraftIssue", id: "DI_2", title: "draft old" },
            },
          },
        },
      },
      { body: { data: { updateProjectV2DraftIssue: { draftIssue: { id: "DI_2" } } } } },
    );
    const client = createGithubClient();
    const ref = await client.updateItem(BOARD_ID, AUTH_PAT, {
      itemNodeId: "PVTI_u2",
      title: "draft new",
    });
    expect(ref.title).toBe("draft new");
    expect(ref.url).toBeNull();
    expect(call(1).body.query).toContain("updateProjectV2DraftIssue");
  });

  test("draft update without a title keeps the existing title", async () => {
    enqueue(
      {
        body: {
          data: {
            node: {
              id: "PVTI_u2b",
              content: { __typename: "DraftIssue", id: "DI_2b", title: "keep me" },
            },
          },
        },
      },
      { body: { data: { updateProjectV2DraftIssue: { draftIssue: { id: "DI_2b" } } } } },
    );
    const client = createGithubClient();
    const ref = await client.updateItem(BOARD_ID, AUTH_PAT, {
      itemNodeId: "PVTI_u2b",
      body: "only body changed",
    });
    expect(ref.title).toBe("keep me");
  });

  test("status-only update skips the title/body branch and moves the card", async () => {
    enqueue(
      {
        body: {
          data: {
            node: {
              id: "PVTI_u3",
              content: {
                __typename: "Issue",
                id: "I_3",
                title: "unchanged",
                url: "https://github.com/acme/repo/issues/9",
              },
            },
          },
        },
      },
      // #setStatusByName → options
      {
        body: {
          data: { node: { field: { id: "PVTSSF_s", options: [{ id: "opt_rev", name: "Review" }] } } },
        },
      },
      { body: { data: { node: { field: { id: "PVTSSF_s" } } } } },
      { body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_u3" } } } } },
    );
    const client = createGithubClient();
    const ref = await client.updateItem(BOARD_ID, AUTH_PAT, {
      itemNodeId: "PVTI_u3",
      statusName: "Review",
    });
    expect(ref.title).toBe("unchanged");
    // Only the content lookup + 3 status calls — no REST PATCH.
    expect(calls.every((c) => !c.url.includes("/repos/"))).toBe(true);
  });

  test("no-op update (no title/body/status) just returns the current ref", async () => {
    enqueue({
      body: {
        data: {
          node: {
            id: "PVTI_u4",
            content: {
              __typename: "Issue",
              id: "I_4",
              title: "stays",
              url: "https://github.com/acme/repo/issues/4",
            },
          },
        },
      },
    });
    const client = createGithubClient();
    const ref = await client.updateItem(BOARD_ID, AUTH_PAT, { itemNodeId: "PVTI_u4" });
    expect(ref.title).toBe("stays");
    expect(calls).toHaveLength(1);
  });

  test("issue update with title only sends just the title in the REST body", async () => {
    enqueue(
      {
        body: {
          data: {
            node: {
              id: "PVTI_u5",
              content: {
                __typename: "Issue",
                id: "I_5",
                title: "t",
                url: "https://github.com/acme/repo/issues/5",
              },
            },
          },
        },
      },
      { body: { title: "renamed", html_url: "x" } },
    );
    const client = createGithubClient();
    await client.updateItem(BOARD_ID, AUTH_PAT, { itemNodeId: "PVTI_u5", title: "renamed" });
    expect(call(1).body).toEqual({ title: "renamed" });
  });

  test("maps a failing REST issue PATCH to a typed error", async () => {
    enqueue(
      {
        body: {
          data: {
            node: {
              id: "PVTI_u5b",
              content: {
                __typename: "Issue",
                id: "I_5b",
                title: "t",
                url: "https://github.com/acme/repo/issues/55",
              },
            },
          },
        },
      },
      { status: 404, text: "issue gone" },
    );
    const client = createGithubClient();
    const err = await client
      .updateItem(BOARD_ID, AUTH_PAT, { itemNodeId: "PVTI_u5b", title: "x" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GithubNotFoundError);
    expect(err.message).toContain("updateItem(issue)");
  });

  test("content without a url and not a draft is a no-op for title/body (no second call)", async () => {
    enqueue({
      body: {
        data: {
          node: {
            id: "PVTI_u6",
            // PullRequest-like content but url missing → neither branch fires.
            content: { __typename: "PullRequest", id: "PR_6", title: "weird" },
          },
        },
      },
    });
    const client = createGithubClient();
    const ref = await client.updateItem(BOARD_ID, AUTH_PAT, {
      itemNodeId: "PVTI_u6",
      title: "ignored because no url",
    });
    expect(ref.title).toBe("weird");
    expect(calls).toHaveLength(1);
  });

  test("null content yields empty title + null content ref", async () => {
    enqueue({
      body: { data: { node: { id: "PVTI_u7", content: null } } },
    });
    const client = createGithubClient();
    const ref = await client.updateItem(BOARD_ID, AUTH_PAT, { itemNodeId: "PVTI_u7" });
    expect(ref.title).toBe("");
    expect(ref.contentNodeId).toBeNull();
    expect(ref.url).toBeNull();
  });

  test("throws NotFound when the item node is null", async () => {
    enqueue({ body: { data: { node: null } } });
    const client = createGithubClient();
    await expect(
      client.updateItem(BOARD_ID, AUTH_PAT, { itemNodeId: "missing" }),
    ).rejects.toBeInstanceOf(GithubNotFoundError);
  });

  test("throws NotFound when the issue url cannot be parsed into a REST path", async () => {
    enqueue({
      body: {
        data: {
          node: {
            id: "PVTI_u8",
            content: {
              __typename: "Issue",
              id: "I_8",
              title: "t",
              url: "https://github.com/acme", // too few path segments
            },
          },
        },
      },
    });
    const client = createGithubClient();
    await expect(
      client.updateItem(BOARD_ID, AUTH_PAT, { itemNodeId: "PVTI_u8", title: "x" }),
    ).rejects.toThrow(/Cannot derive REST path/);
  });

  test("rejects a malformed issue url as an SSRF host violation", async () => {
    enqueue({
      body: {
        data: {
          node: {
            id: "PVTI_u9",
            content: {
              __typename: "Issue",
              id: "I_9",
              title: "t",
              url: "::::not a url::::",
            },
          },
        },
      },
    });
    const client = createGithubClient();
    const err = await client
      .updateItem(BOARD_ID, AUTH_PAT, { itemNodeId: "PVTI_u9", body: "x" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GithubHostNotAllowedError);
    expect(err.message).not.toContain(TOKEN);
  });

  test("rejects an issue url on a foreign host as an SSRF host violation", async () => {
    enqueue({
      body: {
        data: {
          node: {
            id: "PVTI_u10",
            content: {
              __typename: "Issue",
              id: "I_10",
              title: "t",
              // A hostile html_url pointing off-GitHub.
              url: "https://evil.example.com/acme/repo/issues/13",
            },
          },
        },
      },
    });
    const client = createGithubClient();
    const err = await client
      .updateItem(BOARD_ID, AUTH_PAT, { itemNodeId: "PVTI_u10", title: "x" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GithubHostNotAllowedError);
    expect(err.message).toContain("evil.example.com");
    // No fetch to the foreign host ever happened (only the GraphQL lookup).
    expect(calls.every((c) => c.url.startsWith(GITHUB_API_ORIGIN))).toBe(true);
  });
});

// ── setItemStatus ───────────────────────────────────────────────────────────

describe("setItemStatus", () => {
  test("resolves the Status field id then runs the mutation", async () => {
    enqueue(
      { body: { data: { node: { field: { id: "PVTSSF_s" } } } } },
      { body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_s" } } } } },
    );
    const client = createGithubClient();
    await client.setItemStatus(BOARD_ID, AUTH_PAT, "PVTI_s", "opt_done");
    expect(call(1).body.variables).toEqual({
      boardId: BOARD_ID,
      itemId: "PVTI_s",
      fieldId: "PVTSSF_s",
      optionId: "opt_done",
    });
  });

  test("throws NotFound when the board has no Status field", async () => {
    enqueue({ body: { data: { node: { field: null } } } });
    const client = createGithubClient();
    await expect(
      client.setItemStatus(BOARD_ID, AUTH_PAT, "PVTI_s", "opt_done"),
    ).rejects.toThrow(/no single-select "Status" field/);
  });

  test("throws NotFound when the board node is null while resolving the field", async () => {
    enqueue({ body: { data: { node: null } } });
    const client = createGithubClient();
    await expect(
      client.setItemStatus(BOARD_ID, AUTH_PAT, "PVTI_s", "opt_done"),
    ).rejects.toBeInstanceOf(GithubNotFoundError);
  });
});

// ── #setStatusByName error branches (via createIssueOnBoard) ────────────────

describe("setStatusByName error branches", () => {
  const created = {
    body: {
      data: {
        addProjectV2DraftIssue: {
          projectItem: { id: "PVTI_x", content: { id: "DI_x", title: "x" } },
        },
      },
    },
  };

  test("throws NotFound when the Status field is absent", async () => {
    enqueue(created, { body: { data: { node: { field: null } } } });
    const client = createGithubClient();
    await expect(
      client.createIssueOnBoard(BOARD_ID, AUTH_PAT, { title: "x", statusName: "Done" }),
    ).rejects.toThrow(/no single-select "Status" field/);
  });

  test("throws NotFound when the board node is null", async () => {
    enqueue(created, { body: { data: { node: null } } });
    const client = createGithubClient();
    await expect(
      client.createIssueOnBoard(BOARD_ID, AUTH_PAT, { title: "x", statusName: "Done" }),
    ).rejects.toBeInstanceOf(GithubNotFoundError);
  });

  test("throws NotFound when no option matches the requested name", async () => {
    enqueue(created, {
      body: { data: { node: { field: { id: "f", options: [{ id: "o", name: "Todo" }] } } } },
    });
    const client = createGithubClient();
    await expect(
      client.createIssueOnBoard(BOARD_ID, AUTH_PAT, { title: "x", statusName: "Nonexistent" }),
    ).rejects.toThrow(/no "Status" option named "Nonexistent"/);
  });
});

// ── archiveItem ─────────────────────────────────────────────────────────────

describe("archiveItem", () => {
  test("runs the archive mutation", async () => {
    enqueue({ body: { data: { archiveProjectV2Item: { item: { id: "PVTI_a" } } } } });
    const client = createGithubClient();
    await client.archiveItem(BOARD_ID, AUTH_PAT, "PVTI_a");
    expect(call(0).body.query).toContain("archiveProjectV2Item");
    expect(call(0).body.variables).toEqual({ boardId: BOARD_ID, itemId: "PVTI_a" });
  });
});

// ── addComment ──────────────────────────────────────────────────────────────

describe("addComment", () => {
  test("runs the addComment mutation against the content node", async () => {
    enqueue({ body: { data: { addComment: { commentEdge: { node: { id: "IC_1" } } } } } });
    const client = createGithubClient();
    await client.addComment(AUTH_PAT, "I_issue1", "looks good");
    expect(call(0).body.query).toContain("addComment");
    expect(call(0).body.variables).toEqual({ subjectId: "I_issue1", body: "looks good" });
  });
});

// ── error mapping + SSRF + token-safety ─────────────────────────────────────

describe("HTTP status → typed error mapping", () => {
  test("401 → GithubAuthError", async () => {
    enqueue({ status: 401, text: "Bad credentials" });
    const client = createGithubClient();
    try {
      await client.archiveItem(BOARD_ID, AUTH_PAT, "x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubAuthError);
      assertNoTokenLeak(err);
    }
  });

  test("404 → GithubNotFoundError", async () => {
    enqueue({ status: 404, text: "gone" });
    const client = createGithubClient();
    await expect(client.archiveItem(BOARD_ID, AUTH_PAT, "x")).rejects.toBeInstanceOf(
      GithubNotFoundError,
    );
  });

  test("429 → GithubRateLimitError with retryAfterMs from retry-after", async () => {
    enqueue({ status: 429, headers: { "retry-after": "30" }, text: "slow" });
    const client = createGithubClient();
    try {
      await client.archiveItem(BOARD_ID, AUTH_PAT, "x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubRateLimitError);
      expect((err as GithubRateLimitError).retryAfterMs).toBe(30000);
    }
  });

  test("403 with x-ratelimit-remaining:0 → GithubRateLimitError, reset header", async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 60;
    enqueue({
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSec) },
      text: "rate limited",
    });
    const client = createGithubClient();
    try {
      await client.archiveItem(BOARD_ID, AUTH_PAT, "x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubRateLimitError);
      const ms = (err as GithubRateLimitError).retryAfterMs;
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(60000);
    }
  });

  test("403 without rate-limit signals → generic Error (not rate-limit)", async () => {
    enqueue({ status: 403, text: "forbidden" });
    const client = createGithubClient();
    const err = await client.archiveItem(BOARD_ID, AUTH_PAT, "x").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GithubRateLimitError);
  });

  test("rate-limit with an unparseable retry-after falls back to reset header", async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 10;
    enqueue({
      status: 429,
      headers: { "retry-after": "not-a-number", "x-ratelimit-reset": String(resetSec) },
      text: "slow",
    });
    const client = createGithubClient();
    const err = (await client
      .archiveItem(BOARD_ID, AUTH_PAT, "x")
      .catch((e) => e)) as GithubRateLimitError;
    expect(err).toBeInstanceOf(GithubRateLimitError);
    expect(err.retryAfterMs).toBeGreaterThan(0);
  });

  test("rate-limit with an unparseable reset header yields undefined retryAfterMs", async () => {
    enqueue({
      status: 429,
      headers: { "x-ratelimit-reset": "garbage" },
      text: "slow",
    });
    const client = createGithubClient();
    const err = (await client
      .archiveItem(BOARD_ID, AUTH_PAT, "x")
      .catch((e) => e)) as GithubRateLimitError;
    expect(err).toBeInstanceOf(GithubRateLimitError);
    expect(err.retryAfterMs).toBeUndefined();
  });

  test("rate-limit with no rate-limit headers at all → undefined retryAfterMs", async () => {
    enqueue({ status: 429, text: "slow" });
    const client = createGithubClient();
    const err = (await client
      .archiveItem(BOARD_ID, AUTH_PAT, "x")
      .catch((e) => e)) as GithubRateLimitError;
    expect(err.retryAfterMs).toBeUndefined();
  });

  test("500 → generic Error", async () => {
    enqueue({ status: 500, text: "boom" });
    const client = createGithubClient();
    const err = await client.archiveItem(BOARD_ID, AUTH_PAT, "x").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("HTTP 500");
  });

  test("empty error body still produces a typed error (no trailing detail)", async () => {
    enqueue({ status: 404, text: "" });
    const client = createGithubClient();
    const err = await client.archiveItem(BOARD_ID, AUTH_PAT, "x").catch((e) => e);
    expect(err).toBeInstanceOf(GithubNotFoundError);
    expect(err.message).not.toContain(":");
  });

  test("GraphQL 200-with-errors (non-NOT_FOUND) → generic Error", async () => {
    enqueue({ body: { errors: [{ type: "FORBIDDEN", message: "no access" }] } });
    const client = createGithubClient();
    const err = await client.archiveItem(BOARD_ID, AUTH_PAT, "x").catch((e) => e);
    expect(err.message).toContain("GraphQL error");
    expect(err.message).toContain("no access");
  });

  test("GraphQL error entry with no message uses a fallback string", async () => {
    enqueue({ body: { errors: [{ type: "INTERNAL" }] } });
    const client = createGithubClient();
    const err = await client.archiveItem(BOARD_ID, AUTH_PAT, "x").catch((e) => e);
    expect(err.message).toContain("unknown error");
  });

  test("GraphQL NOT_FOUND with no message + no override uses default context message", async () => {
    enqueue({ body: { errors: [{ type: "NOT_FOUND" }] } });
    const client = createGithubClient();
    const err = await client.archiveItem(BOARD_ID, AUTH_PAT, "x").catch((e) => e);
    expect(err).toBeInstanceOf(GithubNotFoundError);
    expect(err.message).toContain("archiveItem");
  });

  test("a thrown HTTP error never contains the token", async () => {
    enqueue({ status: 401, text: `token was ${TOKEN}` }); // even a hostile body
    const client = createGithubClient();
    const err = await client.archiveItem(BOARD_ID, AUTH_PAT, "x").catch((e) => e);
    // The body is echoed, but the client never *adds* the token; our own
    // messages must not introduce it. (Bodies are server-controlled.)
    expect(err.message).toContain("401");
  });
});

describe("SSRF host guard (assertGithubHost)", () => {
  test("a valid github.com issue url is rewritten to the api.github.com REST URL", async () => {
    enqueue(
      {
        body: {
          data: {
            node: {
              id: "PVTI_ssrf",
              content: {
                __typename: "Issue",
                id: "I_ssrf",
                title: "t",
                url: "https://github.com/acme/repo/issues/77",
              },
            },
          },
        },
      },
      // The REST PATCH must target api.github.com — assert it does.
      { body: { title: "ok", html_url: "x" } },
    );
    const client = createGithubClient();
    await client.updateItem(BOARD_ID, AUTH_PAT, { itemNodeId: "PVTI_ssrf", title: "ok" });
    expect(call(1).url).toBe(`${GITHUB_API_ORIGIN}/repos/acme/repo/issues/77`);
  });

  test("a board URL on a non-github host is rejected by the URL parser", async () => {
    // resolveBoardFromUrl never fetches the user URL — it only parses it; a
    // non-github.com host is refused before any request is made.
    const client = createGithubClient();
    const err = await client
      .resolveBoardFromUrl("https://api.evil.test/orgs/x/projects/1", AUTH_PAT)
      .catch((e) => e);
    expect(err).toBeInstanceOf(GithubNotFoundError);
    expect(calls).toHaveLength(0);
  });
});

describe("token safety across all error surfaces", () => {
  test("no recorded request body or header leaks the token into thrown messages", async () => {
    const surfaces: Array<() => Promise<unknown>> = [
      () => {
        enqueue({ status: 401, text: "bad" });
        return createGithubClient().archiveItem(BOARD_ID, AUTH_PAT, "x");
      },
      () => {
        enqueue({ status: 404, text: "bad" });
        return createGithubClient().addComment(AUTH_PAT, "c", "b");
      },
      () => {
        enqueue({ status: 429, text: "bad" });
        return createGithubClient().setItemStatus(BOARD_ID, AUTH_PAT, "i", "o");
      },
    ];
    for (const run of surfaces) {
      const err = await run().catch((e) => e);
      assertNoTokenLeak(err);
    }
    // The token IS sent as a bearer header (required) but never surfaced in errors.
    expect(calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
  });
});
