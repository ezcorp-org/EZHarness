import { afterEach, expect, test } from "bun:test";
import { exchangeCode, githubApi, refreshPair } from "../transport";
import { getGithubUserConfig } from "../config";

const originalFetch = globalThis.fetch;
const originalCallback = process.env.EZ_GITHUB_APP_CALLBACK_URL;
const originalPublic = process.env.EZCORP_PUBLIC_URL;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCallback === undefined) delete process.env.EZ_GITHUB_APP_CALLBACK_URL;
  else process.env.EZ_GITHUB_APP_CALLBACK_URL = originalCallback;
  if (originalPublic === undefined) delete process.env.EZCORP_PUBLIC_URL;
  else process.env.EZCORP_PUBLIC_URL = originalPublic;
});

function respond(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => handler(String(input), init), { preconnect: () => {} });
}

test("GitHub transport rejects redirect and oversized streamed body without exposing bearer", async () => {
  respond(() => new Response(null, { status: 302, headers: { location: "https://evil.invalid/grab" } }));
  await expect(githubApi("private-bearer", "/user")).rejects.toThrow("GitHub is unavailable");
  const chunk = new Uint8Array(600_000);
  respond(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); controller.close(); } }), { status: 200 }));
  await expect(githubApi("private-bearer", "/user")).rejects.toThrow("GitHub is unavailable");
  await expect(githubApi("private-bearer", "//evil.invalid")).rejects.toThrow("Invalid GitHub API path");
});

test("token exchange and refresh reject malformed pairs and hide provider payload", async () => {
  const config = { clientId: "client", clientSecret: "secret", callbackUrl: "https://app.example/api/github/callback" };
  respond(() => new Response(JSON.stringify({ error: "secret-provider-detail" }), { status: 400 }));
  await expect(exchangeCode(config, "code", "verifier")).rejects.toThrow("GitHub connection needs authorization");
  respond(() => new Response(JSON.stringify({ access_token: "a", refresh_token: "b", expires_in: 0, refresh_token_expires_in: 100 }), { status: 200 }));
  await expect(refreshPair(config, "old")).rejects.toThrow("GitHub connection needs authorization");
  respond(() => new Response(JSON.stringify({ access_token: "a", refresh_token: "b", expires_in: 100, refresh_token_expires_in: 100 }), { status: 200 }));
  expect((await refreshPair(config, "old")).access_token).toBe("a");
});

test("callback configuration matches the exact route and public origin", () => {
  process.env.EZ_GITHUB_INSTANCE_ID = "instance-test";
  process.env.EZ_GITHUB_APP_ID = "123";
  process.env.EZ_GITHUB_APP_SLUG = "ezharness-test";
  process.env.EZ_GITHUB_APP_CLIENT_ID = "client";
  process.env.EZ_GITHUB_APP_CLIENT_SECRET = "secret";
  process.env.EZ_GITHUB_APP_CALLBACK_URL = "https://app.example/api/github/wrong";
  expect(() => getGithubUserConfig()).toThrow("GitHub callback URL is invalid");
  process.env.EZ_GITHUB_APP_CALLBACK_URL = "https://app.example/api/github/callback";
  process.env.EZCORP_PUBLIC_URL = "https://other.example";
  expect(() => getGithubUserConfig()).toThrow("GitHub callback URL is invalid");
  process.env.EZCORP_PUBLIC_URL = "https://app.example";
  expect(getGithubUserConfig().callbackUrl).toBe("https://app.example/api/github/callback");
});
