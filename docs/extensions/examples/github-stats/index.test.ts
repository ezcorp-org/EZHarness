import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ToolCallResult } from "@ezcorp/sdk";

import { _internals } from "./index";

const originalFetch = globalThis.fetch;
const originalHosts = process.env.EZCORP_PERMITTED_HOSTS;
const mockFetch = mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
  () => Promise.resolve(new Response("{}")),
);

function text(result: ToolCallResult): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected a text tool result");
  return first.text;
}

function json(result: ToolCallResult): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

beforeAll(() => {
  process.env.EZCORP_PERMITTED_HOSTS = "api.github.com";
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalHosts === undefined) delete process.env.EZCORP_PERMITTED_HOSTS;
  else process.env.EZCORP_PERMITTED_HOSTS = originalHosts;
});

beforeEach(() => {
  mockFetch.mockReset();
});

describe("github-stats public GitHub API handlers", () => {
  test("repo-stats returns selected public repository fields without a token", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      full_name: "octocat/hello-world",
      stargazers_count: 100,
      forks_count: 50,
      open_issues_count: 5,
      language: "TypeScript",
      description: "A test repo",
    }), { status: 200 }));

    const result = await _internals.repoStats({ owner: "octocat", repo: "hello-world" });

    expect(result.isError).toBe(false);
    expect(json(result)).toEqual({
      name: "octocat/hello-world",
      stars: 100,
      forks: 50,
      openIssues: 5,
      language: "TypeScript",
      description: "A test repo",
    });
    const [, init] = mockFetch.mock.calls[0] ?? [];
    expect(init?.headers).toEqual({ "User-Agent": "github-stats-ext" });
  });

  test("user-profile returns selected public user fields", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      login: "octocat",
      name: "The Octocat",
      bio: "GitHub mascot",
      public_repos: 8,
      followers: 1000,
      following: 5,
    }), { status: 200 }));

    const result = await _internals.userProfile({ username: "octocat" });

    expect(result.isError).toBe(false);
    expect(json(result)).toEqual({
      login: "octocat",
      name: "The Octocat",
      bio: "GitHub mascot",
      publicRepos: 8,
      followers: 1000,
      following: 5,
    });
  });

  test("repo-languages returns the public API language map", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ TypeScript: 50_000, JavaScript: 10_000 }), { status: 200 }));

    const result = await _internals.repoLanguages({ owner: "octocat", repo: "hello-world" });

    expect(result.isError).toBe(false);
    expect(json(result)).toEqual({ TypeScript: 50_000, JavaScript: 10_000 });
  });

  test.each([
    ["repo-stats", _internals.repoStats, { owner: "missing", repo: "repo" }, 404, "Repository missing/repo not found"],
    ["user-profile", _internals.userProfile, { username: "octocat" }, 403, "GitHub public API rate limit exceeded; try again later"],
    ["repo-languages", _internals.repoLanguages, { owner: "octocat", repo: "hello-world" }, 500, "GitHub API error: 500"],
  ])("%s maps public API status %i to a readable error", async (_name, handler, args, status, expected) => {
    mockFetch.mockResolvedValueOnce(new Response("{}", { status }));

    const result = await handler(args);

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(expected);
  });
});
