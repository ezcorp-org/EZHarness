import { test, expect, mock, beforeAll, beforeEach } from "bun:test";
import { fetchPermitted } from "@ezcorp/sdk/runtime";

function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

// Mock the global — fetchPermitted internally delegates to fetch once the
// hostname allowlist check passes.
const mockFetch = mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
  () => Promise.resolve(new Response("{}")),
);
globalThis.fetch = mockFetch as unknown as typeof fetch;

// Local helper that mirrors the shape of index.ts's githubFetch so we can
// assert behavior without spinning up the stdin-driven dispatcher.
async function githubFetch(path: string) {
  const headers: Record<string, string> = { "User-Agent": "github-stats-ext" };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetchPermitted(`https://api.github.com${path}`, { headers });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

beforeAll(() => {
  // fetchPermitted fails closed when EZCORP_PERMITTED_HOSTS is unset. In
  // tests we simulate the post-install granted state for api.github.com —
  // this matches what the host's buildAllowedEnv would inject once the
  // user grants the manifest-declared network permission.
  process.env.EZCORP_PERMITTED_HOSTS = "api.github.com";
});

beforeEach(() => {
  mockFetch.mockReset();
});

test("repo-stats returns repository data", async () => {
  const repoData = {
    full_name: "octocat/hello-world",
    stargazers_count: 100,
    forks_count: 50,
    open_issues_count: 5,
    language: "TypeScript",
    description: "A test repo",
  };
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(repoData), { status: 200 }));

  const result = await githubFetch("/repos/octocat/hello-world");
  expect(result.ok).toBe(true);
  expect((result.data as Record<string, unknown>).full_name).toBe("octocat/hello-world");
  expect((result.data as Record<string, unknown>).stargazers_count).toBe(100);
});

test("user-profile returns user data", async () => {
  const userData = {
    login: "octocat",
    name: "The Octocat",
    bio: "GitHub mascot",
    public_repos: 8,
    followers: 1000,
    following: 5,
  };
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(userData), { status: 200 }));

  const result = await githubFetch("/users/octocat");
  expect(result.ok).toBe(true);
  expect((result.data as Record<string, unknown>).login).toBe("octocat");
  expect((result.data as Record<string, unknown>).followers).toBe(1000);
});

test("repo-languages returns language breakdown", async () => {
  const languages = { TypeScript: 50000, JavaScript: 10000, CSS: 5000 };
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(languages), { status: 200 }));

  const result = await githubFetch("/repos/octocat/hello-world/languages");
  expect(result.ok).toBe(true);
  expect((result.data as Record<string, unknown>).TypeScript).toBe(50000);
});

test("handles 404 not found", async () => {
  mockFetch.mockResolvedValueOnce(new Response('{"message":"Not Found"}', { status: 404 }));

  const result = await githubFetch("/repos/nonexistent/repo");
  expect(result.ok).toBe(false);
  expect(result.status).toBe(404);
});

test("handles 403 rate limit", async () => {
  mockFetch.mockResolvedValueOnce(new Response('{"message":"rate limit"}', { status: 403 }));

  const result = await githubFetch("/repos/octocat/hello-world");
  expect(result.ok).toBe(false);
  expect(result.status).toBe(403);
});

test("includes auth header when GITHUB_TOKEN set", async () => {
  process.env.GITHUB_TOKEN = "test-token";
  mockFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));

  await githubFetch("/users/test");

  const callArgs = at(mockFetch.mock.calls, 0, "fetch call");
  const headers = (callArgs[1] as RequestInit).headers as Record<string, string>;
  expect(headers.Authorization).toBe("Bearer test-token");
  delete process.env.GITHUB_TOKEN;
});
