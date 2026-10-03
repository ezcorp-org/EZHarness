import { afterAll, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "../../../__tests__/helpers/test-pglite";
import { createUser } from "../../../db/queries/users";
import { githubUserConnections, sessions } from "../../../db/schema";

class EgressBlockedError extends Error {
  readonly code = "EGRESS_BLOCKED";
  constructor(readonly reason: string) { super(`blocked: ${reason}`); }
}

let failBeforeSend = false;
let failAfterSend = false;
let refreshRequests = 0;
mock.module("../../../search/egress", () => ({
  EgressBlockedError,
  guardedFetch: async (url: string, init: RequestInit) => {
    if (url.endsWith("/login/oauth/access_token")) {
      const body = new URLSearchParams(String(init.body));
      if (body.get("grant_type") === "refresh_token") {
        if (failBeforeSend) throw new EgressBlockedError("no-address");
        refreshRequests++;
        if (failAfterSend) throw new Error("response lost after dispatch");
      }
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    if (url.endsWith("/user")) return Response.json({ id: 71, login: "owner" });
    if (url.includes("/user/installations?")) return Response.json({ total_count: 1, installations: [{ id: 50, app_id: 123, permissions: { contents: "write", pull_requests: "write" } }] });
    if (url.includes("/user/installations/50/repositories?")) return Response.json({ total_count: 1, repositories: [{ id: 42, full_name: "owner/repo" }] });
    if (url.endsWith("/repos/owner/repo")) return Response.json({ id: 42, permissions: { pull: true, push: true } });
    throw new Error(`Unexpected request ${url}`);
  },
}));

mockDbConnection();
const savedEnv = Object.fromEntries(["EZ_GITHUB_INSTANCE_ID", "EZ_GITHUB_APP_ID", "EZ_GITHUB_APP_SLUG", "EZ_GITHUB_APP_CLIENT_ID", "EZ_GITHUB_APP_CLIENT_SECRET", "EZ_GITHUB_APP_CALLBACK_URL", "EZ_GITHUB_AUTH_MODE"].map((key) => [key, process.env[key]]));
afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await closeTestDb();
});

test("a DNS failure before refresh dispatch leaves the valid connection retryable", async () => {
  await setupTestDb();
  process.env.EZ_GITHUB_INSTANCE_ID = "instance-test";
  process.env.EZ_GITHUB_APP_ID = "123";
  process.env.EZ_GITHUB_APP_SLUG = "ezharness-test";
  process.env.EZ_GITHUB_APP_CLIENT_ID = "client";
  process.env.EZ_GITHUB_APP_CLIENT_SECRET = "secret";
  process.env.EZ_GITHUB_APP_CALLBACK_URL = "https://app.example/api/github/callback";
  process.env.EZ_GITHUB_AUTH_MODE = "oauth";
  const user = await createUser({ email: "presend@github-user.test", name: "presend", passwordHash: "hash" });
  await getTestDb().insert(sessions).values({ id: "presend-session", userId: user.id, tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000) });
  const { startAuthorization, completeAuthorization, checkRepository, getConnectionStatus } = await import("../broker");
  const { authorizeUrl } = await startAuthorization({ userId: user.id, sessionId: "presend-session" });
  await completeAuthorization({ userId: user.id, sessionId: "presend-session", state: new URL(authorizeUrl).searchParams.get("state")!, code: "code" });
  await getTestDb().update(githubUserConnections).set({ accessExpiresAt: new Date(0) }).where(eq(githubUserConnections.userId, user.id));
  failBeforeSend = true;
  await expect(checkRepository({ userId: user.id, repositoryId: 42 })).rejects.toMatchObject({ code: "PROVIDER_NOT_SENT" });
  expect(refreshRequests).toBe(0);
  expect((await getConnectionStatus({ userId: user.id })).status).toBe("connected");
  failBeforeSend = false;
  expect((await checkRepository({ userId: user.id, repositoryId: 42 })).status).toBe("ready");
  expect(refreshRequests).toBe(1);
  await getTestDb().update(githubUserConnections).set({ accessExpiresAt: new Date(0) }).where(eq(githubUserConnections.userId, user.id));
  failAfterSend = true;
  await expect(checkRepository({ userId: user.id, repositoryId: 42 })).rejects.toMatchObject({ code: "PROVIDER_NETWORK" });
  expect(refreshRequests).toBe(2);
  expect((await getConnectionStatus({ userId: user.id })).status).toBe("reconnect_required");
});
