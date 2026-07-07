/**
 * GitHub Projects v2 client — REQUEST/RESPONSE CONTRACT test (audit gap HIGH-6).
 *
 * WHY THIS FILE EXISTS: the exhaustive `client.test.ts` builds a minimal,
 * per-branch canned body for each assertion, so a GitHub field rename that was
 * applied to BOTH the query and the hand-built stub could stay green. This file
 * pins the contract from both directions against ONE representative, recorded
 * fixture modeled on the shapes GitHub's GraphQL API actually returns for the
 * queries the client sends (a full board sweep: project + Status single-select
 * field + status options, and a page of items mixing Issue / PullRequest /
 * DraftIssue / redacted-null content, with realistic `fieldValues.nodes` that
 * include the empty `{}` entries GitHub returns for non-single-select values):
 *
 *   1. SEND side — the query string the client POSTs must reference the exact
 *      GitHub schema field selections (`projectV2`, `ProjectV2SingleSelectField`,
 *      `optionId`, `content { ... on Issue { id title url } }`, …). Renaming a
 *      selection here would make the REAL GitHub API reject the query; the
 *      assertions catch it before it ships.
 *   2. PARSE side — feeding the recorded response through the REAL parser
 *      (`createGithubClient()`) must yield the exact domain objects. Renaming a
 *      field the parser reads (e.g. `optionId` → `selectedOptionId`) would make
 *      it read `undefined` from the recorded fixture; the assertions catch it.
 *
 * fetch is stubbed (CI can't reach GitHub) — the VALUE here is the parser +
 * request contract, not live network.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GITHUB_API_ORIGIN, type GithubAuth } from "../types";
import { createGithubClient } from "../client";

const AUTH: GithubAuth = { mode: "pat", token: "ghp_contract_fixture_token" };
const originalFetch = globalThis.fetch;

interface CannedResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
interface RecordedCall {
  url: string;
  method: string;
  body: { query?: string; variables?: Record<string, unknown> } | undefined;
}

let queue: CannedResponse[] = [];
let calls: RecordedCall[] = [];

function installFetch(): void {
  const stub = mock((input: unknown, init?: { method?: string; body?: string }) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const next = queue.shift();
    if (!next) return Promise.reject(new Error(`unmocked fetch to ${url}`));
    const headers = new Headers(next.headers ?? {});
    return Promise.resolve(new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers }));
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

function call(i: number): RecordedCall {
  const c = calls[i];
  if (!c) throw new Error(`no recorded fetch call at index ${i}`);
  return c;
}

// ── Recorded fixtures (modeled on the real GitHub GraphQL envelope) ──────────

/** `organization.projectV2` with a Status single-select field, as GitHub
 *  returns it for RESOLVE_BOARD_QUERY. Node/option ids use GitHub's real
 *  shapes (PVT_/PVTSSF_ prefixes; 8-hex single-select option ids). */
const RESOLVE_BOARD_FIXTURE = {
  data: {
    organization: {
      projectV2: {
        id: "PVT_kwDOABCDEF4A0aBc",
        title: "Engineering Roadmap",
        field: {
          __typename: "ProjectV2SingleSelectField",
          id: "PVTSSF_lADOABCDEF4A0aBczg0aBc",
          name: "Status",
          options: [
            { id: "f75ad846", name: "Todo" },
            { id: "47fc9ee4", name: "In Progress" },
            { id: "98236657", name: "Done" },
          ],
        },
      },
    },
  },
};

/** One page of `node(id).items` as GitHub returns it for FETCH_ITEMS_QUERY.
 *  Deliberately heterogeneous:
 *    - an Issue with a Status value,
 *    - a PullRequest with a Status value,
 *    - a DraftIssue (no url) with NO Status value,
 *    - a redacted item (content: null),
 *  and every card's `fieldValues.nodes` carries the empty `{}` entries GitHub
 *  emits for field values that are NOT the inline-fragment single-select type,
 *  plus (on the Issue) a non-Status single-select ("Priority") that MUST be
 *  ignored by the parser. */
const FETCH_ITEMS_FIXTURE = {
  data: {
    node: {
      items: {
        pageInfo: { hasNextPage: false, endCursor: "Nw" },
        nodes: [
          {
            id: "PVTI_lADOABCDEF4A0aBczgFaaa1",
            updatedAt: "2026-06-15T09:30:00Z",
            content: {
              __typename: "Issue",
              id: "I_kwDOABCDEF5aBcD1",
              title: "Login fails on Safari",
              url: "https://github.com/acme/webapp/issues/42",
            },
            fieldValues: {
              nodes: [
                {},
                {
                  __typename: "ProjectV2ItemFieldSingleSelectValue",
                  optionId: "47fc9ee4",
                  name: "In Progress",
                  field: { name: "Status" },
                },
                {
                  __typename: "ProjectV2ItemFieldSingleSelectValue",
                  optionId: "aa11bb22",
                  name: "High",
                  field: { name: "Priority" },
                },
              ],
            },
          },
          {
            id: "PVTI_lADOABCDEF4A0aBczgFaaa2",
            updatedAt: "2026-06-16T14:00:00Z",
            content: {
              __typename: "PullRequest",
              id: "PR_kwDOABCDEF5aBcD2",
              title: "Fix Safari cookie handling",
              url: "https://github.com/acme/webapp/pull/57",
            },
            fieldValues: {
              nodes: [
                {
                  __typename: "ProjectV2ItemFieldSingleSelectValue",
                  optionId: "98236657",
                  name: "Done",
                  field: { name: "Status" },
                },
              ],
            },
          },
          {
            id: "PVTI_lADOABCDEF4A0aBczgFaaa3",
            updatedAt: "2026-06-10T08:00:00Z",
            content: { __typename: "DraftIssue", id: "DI_lADOABCDEF4A0aBc3", title: "Spike: auth rework" },
            fieldValues: { nodes: [{}] },
          },
          {
            id: "PVTI_lADOABCDEF4A0aBczgFaaa4",
            updatedAt: "2026-06-09T00:00:00Z",
            content: null,
            fieldValues: { nodes: [] },
          },
        ],
      },
    },
  },
};

// ── resolveBoardFromUrl: project + Status field + status options ─────────────

describe("resolveBoardFromUrl — board/project/status-options contract", () => {
  test("parses the recorded board response into a GithubBoardRef", async () => {
    queue.push({ body: RESOLVE_BOARD_FIXTURE });
    const ref = await createGithubClient().resolveBoardFromUrl(
      "https://github.com/orgs/acme/projects/7",
      AUTH,
    );
    expect(ref).toEqual({
      boardNodeId: "PVT_kwDOABCDEF4A0aBc",
      title: "Engineering Roadmap",
      ownerLogin: "acme",
      statusFieldId: "PVTSSF_lADOABCDEF4A0aBczg0aBc",
      statusOptions: [
        { id: "f75ad846", name: "Todo" },
        { id: "47fc9ee4", name: "In Progress" },
        { id: "98236657", name: "Done" },
      ],
    });
  });

  test("SEND contract: the query references the documented ProjectV2 selections", async () => {
    queue.push({ body: RESOLVE_BOARD_FIXTURE });
    await createGithubClient().resolveBoardFromUrl("https://github.com/orgs/acme/projects/7", AUTH);
    const sent = call(0).body?.query ?? "";
    // OWNER placeholder is substituted with the concrete owner type.
    expect(sent).toContain("organization(login:");
    expect(sent).toContain("projectV2(number: $number)");
    // The Status single-select field + its options — a rename here would make
    // GitHub reject the query at runtime.
    expect(sent).toContain('field(name: "Status")');
    expect(sent).toContain("... on ProjectV2SingleSelectField");
    expect(sent).toContain("options { id name }");
    expect(call(0).url).toBe(`${GITHUB_API_ORIGIN}/graphql`);
    expect(call(0).body?.variables).toEqual({ login: "acme", number: 7 });
  });
});

// ── fetchBoardItems: heterogeneous board items + Status extraction ───────────

describe("fetchBoardItems — board-items contract", () => {
  test("parses a recorded mixed page (Issue/PR/Draft/redacted) into GithubBoardItem[]", async () => {
    queue.push({ body: FETCH_ITEMS_FIXTURE });
    const page = await createGithubClient().fetchBoardItems("PVT_kwDOABCDEF4A0aBc", AUTH, null);

    expect(page.items).toEqual([
      {
        itemNodeId: "PVTI_lADOABCDEF4A0aBczgFaaa1",
        contentNodeId: "I_kwDOABCDEF5aBcD1",
        title: "Login fails on Safari",
        url: "https://github.com/acme/webapp/issues/42",
        statusOptionId: "47fc9ee4", // the Status value — NOT the Priority single-select
        statusName: "In Progress",
        updatedAt: "2026-06-15T09:30:00Z",
      },
      {
        itemNodeId: "PVTI_lADOABCDEF4A0aBczgFaaa2",
        contentNodeId: "PR_kwDOABCDEF5aBcD2",
        title: "Fix Safari cookie handling",
        url: "https://github.com/acme/webapp/pull/57",
        statusOptionId: "98236657",
        statusName: "Done",
        updatedAt: "2026-06-16T14:00:00Z",
      },
      {
        itemNodeId: "PVTI_lADOABCDEF4A0aBczgFaaa3",
        contentNodeId: "DI_lADOABCDEF4A0aBc3",
        title: "Spike: auth rework",
        url: null, // drafts have no url
        statusOptionId: null, // no Status value
        statusName: null,
        updatedAt: "2026-06-10T08:00:00Z",
      },
      {
        itemNodeId: "PVTI_lADOABCDEF4A0aBczgFaaa4",
        contentNodeId: null,
        title: "(untitled)", // redacted/null content fallback
        url: null,
        statusOptionId: null,
        statusName: null,
        updatedAt: "2026-06-09T00:00:00Z",
      },
    ]);
    // The cursor is the per-item updatedAt high-water map.
    expect(page.cursor).toEqual({
      PVTI_lADOABCDEF4A0aBczgFaaa1: "2026-06-15T09:30:00Z",
      PVTI_lADOABCDEF4A0aBczgFaaa2: "2026-06-16T14:00:00Z",
      PVTI_lADOABCDEF4A0aBczgFaaa3: "2026-06-10T08:00:00Z",
      PVTI_lADOABCDEF4A0aBczgFaaa4: "2026-06-09T00:00:00Z",
    });
  });

  test("SEND contract: the items query references the documented content + field-value selections", async () => {
    queue.push({ body: FETCH_ITEMS_FIXTURE });
    await createGithubClient().fetchBoardItems("PVT_kwDOABCDEF4A0aBc", AUTH, null);
    const sent = call(0).body?.query ?? "";
    expect(sent).toContain("items(first: 100, after: $after)");
    expect(sent).toContain("pageInfo { hasNextPage endCursor }");
    expect(sent).toContain("updatedAt");
    // Content polymorphism — each __typename the parser can read.
    expect(sent).toContain("__typename");
    expect(sent).toContain("... on Issue { id title url }");
    expect(sent).toContain("... on PullRequest { id title url }");
    expect(sent).toContain("... on DraftIssue { id title }");
    // The single-select field value — the Status source. optionId is the field
    // the parser reads; renaming it in the query would break status extraction.
    expect(sent).toContain("fieldValues(first: 20)");
    expect(sent).toContain("... on ProjectV2ItemFieldSingleSelectValue");
    expect(sent).toContain("optionId");
    expect(sent).toContain("field { ... on ProjectV2SingleSelectField { name } }");
    expect(call(0).body?.variables).toEqual({ boardId: "PVT_kwDOABCDEF4A0aBc", after: null });
  });
});
