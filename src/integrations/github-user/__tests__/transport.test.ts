import { afterEach, expect, test } from "bun:test";
import { beginDeviceCode, exchangeCode, exchangeDeviceCode, githubApi, refreshDevicePair, refreshPair } from "../transport";
import { getGithubOAuthConfig } from "../config";

const originalFetch = globalThis.fetch;
const originalCallback = process.env.EZ_GITHUB_APP_CALLBACK_URL;
const originalPublic = process.env.EZCORP_PUBLIC_URL;
const originalMode = process.env.EZ_GITHUB_AUTH_MODE;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCallback === undefined) delete process.env.EZ_GITHUB_APP_CALLBACK_URL;
  else process.env.EZ_GITHUB_APP_CALLBACK_URL = originalCallback;
  if (originalPublic === undefined) delete process.env.EZCORP_PUBLIC_URL;
  else process.env.EZCORP_PUBLIC_URL = originalPublic;
  if (originalMode === undefined) delete process.env.EZ_GITHUB_AUTH_MODE;
  else process.env.EZ_GITHUB_AUTH_MODE = originalMode;
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
  process.env.EZ_GITHUB_AUTH_MODE = "oauth";
  process.env.EZ_GITHUB_INSTANCE_ID = "instance-test";
  process.env.EZ_GITHUB_APP_ID = "123";
  process.env.EZ_GITHUB_APP_SLUG = "ezharness-test";
  process.env.EZ_GITHUB_APP_CLIENT_ID = "client";
  process.env.EZ_GITHUB_APP_CLIENT_SECRET = "secret";
  process.env.EZ_GITHUB_APP_CALLBACK_URL = "https://app.example/api/github/wrong";
  expect(() => getGithubOAuthConfig()).toThrow("GitHub callback URL is invalid");
  process.env.EZ_GITHUB_APP_CALLBACK_URL = "https://app.example/api/github/callback";
  process.env.EZCORP_PUBLIC_URL = "https://other.example";
  expect(() => getGithubOAuthConfig()).toThrow("GitHub callback URL is invalid");
  process.env.EZCORP_PUBLIC_URL = "https://app.example";
  expect(getGithubOAuthConfig().callbackUrl).toBe("https://app.example/api/github/callback");
});

test("device transport sends only the public client ID and accepts only GitHub's fixed verification URL", async () => {
  respond((_url, init) => {
    expect(new URLSearchParams(String(init?.body)).toString()).toBe("client_id=client");
    return new Response(JSON.stringify({ device_code: "device-code-12345678901234567890", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }));
  });
  expect((await beginDeviceCode({ clientId: "client" })).verificationUri).toBe("https://github.com/login/device");
  respond(() => new Response(JSON.stringify({ device_code: "device-code-12345678901234567890", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device" })));
  expect(await beginDeviceCode({ clientId: "client" })).toMatchObject({ expiresIn: 900, interval: 5 });
  respond(() => new Response(JSON.stringify({ device_code: "device-code-12345678901234567890", user_code: "ABCD-EFGH", verification_uri: "https://evil.invalid/device", expires_in: 900, interval: 5 })));
  await expect(beginDeviceCode({ clientId: "client" })).rejects.toMatchObject({ code: "DEVICE_START_FAILED" });
});

test("device polling maps GitHub protocol states and never sends a client secret", async () => {
  for (const [payload, status] of [
    [{ error: "authorization_pending" }, "pending"], [{ error: "slow_down", interval: 10 }, "slow_down"],
    [{ error: "expired_token" }, "expired"], [{ error: "access_denied" }, "denied"],
  ] as const) {
    respond((_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.has("client_secret")).toBe(false);
      expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
      return new Response(JSON.stringify(payload));
    });
    expect((await exchangeDeviceCode({ clientId: "client" }, "device-code")).status).toBe(status);
  }
  respond(() => new Response(JSON.stringify({ error: "device_flow_disabled", error_description: "private-detail" })));
  await expect(exchangeDeviceCode({ clientId: "client" }, "device-code")).rejects.toMatchObject({ code: "DEVICE_EXCHANGE_FAILED" });
  respond((_url, init) => {
    expect(new URLSearchParams(String(init?.body)).has("client_secret")).toBe(false);
    return new Response(JSON.stringify({ access_token: "new", refresh_token: "next", expires_in: 28800, refresh_token_expires_in: 15897600 }));
  });
  expect((await refreshDevicePair({ clientId: "client" }, "old")).access_token).toBe("new");
});
