import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createRuntimeExtension, type DefinedExtension, type ExtensionContext } from "@ezcorp/sdk/v4";
import manifest from "./ezcorp.config";
import { start } from "./index";
import { __resetChannelForTests } from "@ezcorp/sdk/test";

const originalFetch = globalThis.fetch;
const mockFetch = mock(async (_url: string, _init?: RequestInit) => Response.json({}));
let extension: DefinedExtension;
let credential: string | null = null;
const context: ExtensionContext = { invocation: { invocationId: "test", workerId: "worker", releaseId: "release", principalId: "user", scopeId: "scope", token: "token", deadline: Date.now() + 60_000 }, signal: new AbortController().signal, call: async (method, input) => { expect(method).toBe("ezcorp/env.get"); expect(input).toEqual({ name: "GITHUB_TOKEN" }); return credential; } };
beforeEach(async () => { credential = null; mockFetch.mockReset(); globalThis.fetch = mockFetch as unknown as typeof fetch; extension = await createRuntimeExtension({ manifest, register: start }); });
afterEach(() => { globalThis.fetch = originalFetch; __resetChannelForTests(); });

const cases = [
  { name: "repo-stats", input: { owner: "octocat", repo: "hello" }, path: "/repos/octocat/hello", data: { full_name: "octocat/hello", stargazers_count: 100, forks_count: 2, open_issues_count: 3, language: "TypeScript", description: "Repo" }, expected: { name: "octocat/hello", stars: 100, forks: 2, openIssues: 3, language: "TypeScript", description: "Repo" }, missing: "Repository octocat/hello not found" },
  { name: "user-profile", input: { username: "octocat" }, path: "/users/octocat", data: { login: "octocat", name: "Octocat", bio: "Bio", public_repos: 8, followers: 10, following: 5 }, expected: { login: "octocat", name: "Octocat", bio: "Bio", publicRepos: 8, followers: 10, following: 5 }, missing: "User octocat not found" },
  { name: "repo-languages", input: { owner: "octocat", repo: "hello" }, path: "/repos/octocat/hello/languages", data: { TypeScript: 50000 }, expected: { TypeScript: 50000 }, missing: "Repository octocat/hello not found" },
];
for (const entry of cases) {
  test(`${entry.name} maps the actual GitHub response`, async () => {
    mockFetch.mockResolvedValueOnce(Response.json(entry.data));
    expect(await extension.invoke(entry.name, entry.input, context)).toEqual({ content: [{ type: "text", text: JSON.stringify(entry.expected) }], isError: false });
    expect(mockFetch.mock.calls[0]?.[0]).toBe(`https://api.github.com${entry.path}`);
    expect(mockFetch.mock.calls[0]?.[1]?.headers).toEqual({ "User-Agent": "github-stats-ext" });
  });
  for (const [status, message] of [[404, entry.missing], [403, "GitHub API rate limit exceeded"], [500, "GitHub API error: 500"]] as const) test(`${entry.name} reports HTTP ${status}`, async () => {
    mockFetch.mockResolvedValueOnce(Response.json({}, { status }));
    expect(await extension.invoke(entry.name, entry.input, context)).toMatchObject({ content: [{ type: "text", text: message }], isError: true });
  });
}
test("GitHub credentials come from the active invocation broker", async () => {
  credential = "opaque-credential-handle";
  mockFetch.mockResolvedValueOnce(Response.json({}));
  await extension.invoke("user-profile", { username: "test" }, context);
  expect(mockFetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer opaque-credential-handle" });
});
