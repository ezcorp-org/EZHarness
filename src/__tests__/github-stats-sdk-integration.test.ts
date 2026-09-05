import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { buildFirstPartyRelease } from "./helpers/first-party-release";
import { closeTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";

mockDbConnection();
let release: Awaited<ReturnType<typeof buildFirstPartyRelease>>;
beforeAll(async () => { release = await buildFirstPartyRelease("github-stats"); }, 120_000);
beforeEach(setupTestDb);
afterAll(async () => { await release?.close(); await closeTestDb(); });

const cases = [
  { tool: "repo-stats", input: { owner: "octocat", repo: "hello-world" }, path: "/repos/octocat/hello-world", body: { full_name: "octocat/hello-world", stargazers_count: 42, forks_count: 7, open_issues_count: 1, language: "TypeScript", description: "integration-test repo" }, expected: { name: "octocat/hello-world", stars: 42 } },
  { tool: "user-profile", input: { username: "octocat" }, path: "/users/octocat", body: { login: "octocat", followers: 1000 }, expected: { login: "octocat", followers: 1000 } },
  { tool: "repo-languages", input: { owner: "octocat", repo: "hello-world" }, path: "/repos/octocat/hello-world/languages", body: { TypeScript: 12345, JavaScript: 678 }, expected: { TypeScript: 12345 } },
];

for (const fixture of cases) test(`${fixture.tool} crosses framed SDK and production broker with its exact URL`, async () => {
  const urls: string[] = [];
  const requested: unknown[] = [];
  const session = await release.session({ networkHosts: ["api.github.com"], async handler(request) { if (request.method === "ezcorp/network.fetch") requested.push(request.params?.url); }, fetchImpl: (async (url: string | URL | Request) => { urls.push(String(url)); return new Response(JSON.stringify(fixture.body), { status: 200 }); }) as typeof fetch });
  try {
    const result = await session.tool(fixture.tool, fixture.input);
    expect({ result, failures: session.failures }).toMatchObject({ result: { isError: false } });
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject(fixture.expected);
    expect(requested).toEqual([`https://api.github.com${fixture.path}`]);
    expect(urls).toEqual([`https://1.1.1.1${fixture.path}`]);
  } finally { await session.close(); }
}, 30_000);

test("credential handle becomes an Authorization header only at the host provider boundary", async () => {
  const observed: Headers[] = [];
  const session = await release.session({ networkHosts: ["api.github.com"], credential: "test-token", fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => { observed.push(new Headers(init?.headers)); return new Response(JSON.stringify({ login: "octocat" })); }) as typeof fetch });
  try {
    expect((await session.tool("user-profile", { username: "octocat" })).isError).toBe(false);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.get("Authorization")).toBe("Bearer test-token");
    expect(observed[0]?.get("User-Agent")).toBe("github-stats-ext");
  } finally { await session.close(); }
}, 30_000);

for (const hosts of [[], ["example.com"]]) test(`${hosts.length ? "unrelated" : "empty"} granted host set denies without a network effect`, async () => {
  let requests = 0;
  const session = await release.session({ networkHosts: hosts, fetchImpl: (async () => { requests++; return new Response("{}"); }) as typeof fetch });
  try {
    const result = await session.tool("repo-stats", { owner: "octocat", repo: "hello-world" });
    expect(result.isError).toBe(true);
    expect(session.failures).toContainEqual(expect.stringContaining("Network access was not approved"));
    expect(requests).toBe(0);
  } finally { await session.close(); }
}, 30_000);
