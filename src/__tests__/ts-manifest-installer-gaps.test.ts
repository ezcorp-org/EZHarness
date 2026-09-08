/** Private GitHub credentials stay scoped to the requested source and never persist in the workspace. */
import { afterAll, beforeEach, expect, test } from "bun:test";
import {
  githubFetchFixture,
  installSourceFetch,
  resetInstallerV4SourceFixture,
  restoreInstallerV4SourceFixture,
  sourceActor,
  stagingCalls,
} from "./helpers/installer-v4-source-fixtures";

const { configureGitHubSourceCredentials, importExtensionSource } = await import("../extensions/source-import");

afterAll(() => restoreInstallerV4SourceFixture());
beforeEach(() => {
  resetInstallerV4SourceFixture();
  configureGitHubSourceCredentials(async () => null);
});

test("GitHub source credentials are scoped to the repository and never stored with the immutable workspace", async () => {
  const { calls, fetcher } = githubFetchFixture();
  const restoreFetch = installSourceFetch(fetcher);
  try {
    configureGitHubSourceCredentials(async (identity, repository) => {
      expect(identity).toEqual(sourceActor);
      expect(repository).toBe("owner/repo");
      return "fixture-scoped-token";
    });
    await importExtensionSource(sourceActor, { kind: "github", repository: "owner/repo", ref: "main" });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => new Headers(call.init?.headers).get("authorization") === "Bearer fixture-scoped-token")).toBe(true);
    expect(JSON.stringify(stagingCalls().workspace.mock.calls[0]![1].files)).not.toContain("fixture-scoped-token");
  } finally {
    restoreFetch();
  }
});

test("credentials do not reach private DNS answers or a redirect destination", async () => {
  const input = { kind: "github" as const, repository: "owner/repo" };
  const { collectGitHubSource } = await import("../extensions/source-import");
  for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "::1", "fd00::1"]) {
    const { calls, fetcher } = githubFetchFixture();
    await expect(collectGitHubSource(input, { token: "fixture-secret", fetch: fetcher, resolveHost: async () => [address] })).rejects.toMatchObject({ reason: "private-ip" });
    expect(calls).toHaveLength(0);
  }
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    return new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } });
  }) as typeof fetch;
  await expect(collectGitHubSource(input, { token: "fixture-secret", fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toMatchObject({ reason: "redirect-limit" });
  expect(calls).toEqual([{ url: "https://93.184.216.34/repos/owner/repo/commits/HEAD", authorization: "Bearer fixture-secret" }]);
});

test("a public GitHub source sends no authorization header when no scoped credential exists", async () => {
  const { calls, fetcher } = githubFetchFixture();
  const restoreFetch = installSourceFetch(fetcher);
  try {
    await importExtensionSource(sourceActor, { kind: "github", repository: "owner/public" });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => new Headers(call.init?.headers).get("authorization") === null)).toBe(true);
  } finally { restoreFetch(); }
});
