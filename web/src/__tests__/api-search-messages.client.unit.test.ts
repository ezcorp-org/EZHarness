/**
 * Client-contract tests for `searchMessages` in $lib/api (Phase 67 Plan 03).
 *
 * Asserts the typed client:
 *  - forwards `scope` in the query string (PAL-01 cross-project palette path),
 *  - omits `scope` when not given (Phase 65 default-project behaviour unchanged),
 *  - still forwards projectId / q / mode / limit / offset, and
 *  - surfaces the NEW `projectId` / `projectName` fields on each typed hit.
 *
 * Mirrors the fetch-spy harness used across the web api client tests
 * (globalThis.fetch swap) — no server, no PGlite.
 */
import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import { searchMessages, type SearchMessagesResponse, type MessageSearchHit } from "$lib/api";

let originalFetch: typeof globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Parse the (relative, BASE="") fetched URL with a base so URL() doesn't throw. */
function parseUrl(raw: string): URL {
  return new URL(raw, "http://localhost");
}

/** Capture the URL the client fetches and reply with `body`. */
function spyFetch(body: SearchMessagesResponse): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    urls.push(typeof url === "string" ? url : url.toString());
    return jsonResponse(body);
  }) as unknown as typeof globalThis.fetch;
  return { urls };
}

const emptyEnvelope: SearchMessagesResponse = {
  hits: [],
  degraded: false,
  requestedMode: "hybrid",
  servedMode: "hybrid",
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("searchMessages client — scope forwarding", () => {
  test("forwards scope=all in the query string", async () => {
    const { urls } = spyFetch(emptyEnvelope);
    await searchMessages("p1", "hello world", { scope: "all" });
    expect(urls).toHaveLength(1);
    const u = parseUrl(urls[0]!);
    expect(u.pathname).toBe("/api/search/messages");
    expect(u.searchParams.get("scope")).toBe("all");
    expect(u.searchParams.get("projectId")).toBe("p1");
    expect(u.searchParams.get("q")).toBe("hello world");
  });

  test("forwards scope=project when explicitly given", async () => {
    const { urls } = spyFetch(emptyEnvelope);
    await searchMessages("p1", "hello world", { scope: "project" });
    expect(parseUrl(urls[0]!).searchParams.get("scope")).toBe("project");
  });

  test("omits scope param when not provided (Phase 65 default behaviour)", async () => {
    const { urls } = spyFetch(emptyEnvelope);
    await searchMessages("p1", "hello world");
    expect(parseUrl(urls[0]!).searchParams.has("scope")).toBe(false);
  });

  test("still forwards mode / limit / offset alongside scope", async () => {
    const { urls } = spyFetch(emptyEnvelope);
    await searchMessages("p1", "hello world", {
      mode: "keyword",
      limit: 5,
      offset: 10,
      scope: "all",
    });
    const u = parseUrl(urls[0]!);
    expect(u.searchParams.get("mode")).toBe("keyword");
    expect(u.searchParams.get("limit")).toBe("5");
    expect(u.searchParams.get("offset")).toBe("10");
    expect(u.searchParams.get("scope")).toBe("all");
  });
});

describe("searchMessages client — projectId/projectName on the typed hit", () => {
  test("surfaces projectId + projectName from the response envelope", async () => {
    const hit: MessageSearchHit = {
      conversationId: "c1",
      conversationTitle: "First",
      messageId: "m1",
      role: "user",
      createdAt: new Date().toISOString(),
      snippet: "<mark>hello</mark>",
      matchType: "both",
      rankLexical: 1,
      rankSemantic: 1,
      score: 0.5,
      projectId: "p-77",
      projectName: "Cross Project",
    };
    spyFetch({ ...emptyEnvelope, hits: [hit] });
    const res = await searchMessages("p1", "hello world", { scope: "all" });
    expect(res.hits).toHaveLength(1);
    // the new fields are present + typed on the returned hit.
    expect(res.hits[0]!.projectId).toBe("p-77");
    expect(res.hits[0]!.projectName).toBe("Cross Project");
  });
});
