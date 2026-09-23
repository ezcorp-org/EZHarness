import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../../../__tests__/helpers/test-pglite";
import { createUser } from "../../../db/queries/users";
import { githubUserConnections, githubUserDeviceAttempts, sessions } from "../../../db/schema";
import { up as migrateDeviceAttempts } from "../../../db/migrations/add-github-user-device-attempts";
import { cancelDeviceAuthorization, checkRepository, disconnect, getConnectionStatus, pollDeviceAuthorization, startDeviceAuthorization } from "../broker";
import { getGithubUserConfig } from "../config";

mockDbConnection();
const savedFetch = globalThis.fetch;
const savedEnv = Object.fromEntries(["EZ_GITHUB_INSTANCE_ID", "EZ_GITHUB_APP_ID", "EZ_GITHUB_APP_SLUG", "EZ_GITHUB_APP_CLIENT_ID", "EZ_GITHUB_APP_CLIENT_SECRET", "EZ_GITHUB_APP_CALLBACK_URL", "EZ_GITHUB_AUTH_MODE"].map(key => [key, process.env[key]]));
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const token = { access_token: "device-access", refresh_token: "device-refresh", expires_in: 28800, refresh_token_expires_in: 15897600 };
const code = { device_code: "device-code-12345678901234567890", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 };
let pollResult: unknown;
let polls = 0;
let refreshes = 0;
let accountId = 71;
let pollGate: Promise<void> | undefined;
let enteredPoll: (() => void) | undefined;

function github(): void {
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.endsWith("/login/device/code")) {
      expect(new URLSearchParams(String(init?.body)).get("client_secret")).toBeNull();
      return reply(code);
    }
    if (url.endsWith("/login/oauth/access_token")) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.has("client_secret")).toBe(false);
      if (body.get("grant_type") === "refresh_token") { refreshes++; return reply({ ...token, access_token: "refreshed-access" }); }
      expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
      polls++;
      enteredPoll?.();
      if (pollGate) await pollGate;
      return reply(pollResult);
    }
    if (url.endsWith("/user")) return reply({ id: accountId, login: "owner" });
    if (url.includes("/user/installations?")) return reply({ total_count: 1, installations: [{ id: 50, app_id: 123, permissions: { contents: "write", pull_requests: "write" } }] });
    if (url.includes("/user/installations/50/repositories?")) return reply({ total_count: 1, repositories: [{ id: 42, full_name: "owner/repo", default_branch: "main", private: true }] });
    if (url.endsWith("/repos/owner/repo")) return reply({ id: 42, permissions: { pull: true, push: true } });
    throw new Error(`Unexpected request ${url}`);
  }, { preconnect: () => {} });
}

async function principal(label: string) {
  const user = await createUser({ email: `${label}@device.test`, name: label, passwordHash: "hash" });
  const sessionId = `session-${label}`;
  await getTestDb().insert(sessions).values({ id: sessionId, userId: user.id, tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000) });
  return { userId: user.id, sessionId };
}
async function due(attemptId: string): Promise<void> { await getTestDb().update(githubUserDeviceAttempts).set({ nextPollAt: new Date(0) }).where(eq(githubUserDeviceAttempts.attemptId, attemptId)); }
async function start(input: { userId: string; sessionId: string }, returnReviewId?: string) { return startDeviceAuthorization({ ...input, returnReviewId }); }

beforeEach(async () => {
  await setupTestDb();
  process.env.EZ_GITHUB_INSTANCE_ID = "instance-test";
  process.env.EZ_GITHUB_APP_ID = "123";
  process.env.EZ_GITHUB_APP_SLUG = "ezharness-test";
  process.env.EZ_GITHUB_APP_CLIENT_ID = "client";
  process.env.EZ_GITHUB_AUTH_MODE = "device";
  delete process.env.EZ_GITHUB_APP_CLIENT_SECRET;
  delete process.env.EZ_GITHUB_APP_CALLBACK_URL;
  pollResult = { error: "authorization_pending" };
  polls = 0; refreshes = 0; accountId = 71; pollGate = undefined; enteredPoll = undefined;
  github();
});
afterAll(async () => {
  globalThis.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await closeTestDb();
});

test("device flow starts without a secret and binds its code to a verified user session", async () => {
  const a = await principal("a"); const b = await principal("b");
  const attempt = await start(a, "review_1");
  expect(attempt).toMatchObject({ userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", intervalSeconds: 5 });
  expect(attempt.attemptId).toMatch(/^[0-9a-f-]{36}$/);
  const [stored] = await getTestDb().select().from(githubUserDeviceAttempts).where(eq(githubUserDeviceAttempts.attemptId, attempt.attemptId));
  expect(stored.deviceCiphertext).not.toContain(code.device_code);
  await expect(pollDeviceAuthorization({ ...b, attemptId: attempt.attemptId })).rejects.toMatchObject({ code: "DEVICE_ATTEMPT_UNAVAILABLE" });
  await expect(pollDeviceAuthorization({ userId: a.userId, sessionId: b.sessionId, attemptId: attempt.attemptId })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  expect((await pollDeviceAuthorization({ ...a, attemptId: attempt.attemptId })).status).toBe("pending");
  expect(polls).toBe(0);
  await due(attempt.attemptId);
  expect((await pollDeviceAuthorization({ ...a, attemptId: attempt.attemptId })).status).toBe("pending");
  expect(polls).toBe(1);
  await expect(cancelDeviceAuthorization({ ...b, attemptId: attempt.attemptId })).rejects.toMatchObject({ code: "DEVICE_ATTEMPT_UNAVAILABLE" });
  expect(await cancelDeviceAuthorization({ ...a, attemptId: attempt.attemptId })).toEqual({ status: "cancelled" });
  expect((await pollDeviceAuthorization({ ...a, attemptId: attempt.attemptId })).status).toBe("cancelled");
});

test("public App defaults and stable local instance ID need no secret or callback", async () => {
  delete process.env.EZ_GITHUB_APP_ID;
  delete process.env.EZ_GITHUB_APP_CLIENT_ID;
  delete process.env.EZ_GITHUB_APP_SLUG;
  delete process.env.EZ_GITHUB_INSTANCE_ID;
  const config = getGithubUserConfig();
  expect(config).toMatchObject({ mode: "device", appId: 5049328, clientId: "Iv23linp84AzzvCGxstF" });
  expect(config.appSlug).toBe("ezcorp-github-auth");
  expect(config.instanceId).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(getGithubUserConfig().instanceId).toBe(config.instanceId);
  await expect(startDeviceAuthorization({ userId: crypto.randomUUID(), sessionId: "missing" })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  expect(polls).toBe(0);
  process.env.EZ_GITHUB_AUTH_MODE = "oauth";
  expect(() => getGithubUserConfig()).toThrow("not configured");
});

test("device migration is idempotent and marks pre-device connection rows as OAuth", async () => {
  const a = await principal("migration");
  await getTestDb().execute(sql`INSERT INTO github_user_authorities (user_id) VALUES (${a.userId})`);
  await getTestDb().execute(sql`INSERT INTO github_user_connections (user_id,connection_id,github_account_id,github_login,app_id,access_ciphertext,refresh_ciphertext,access_expires_at,refresh_expires_at) VALUES (${a.userId},'legacy',71,'owner',123,'cipher','cipher',NOW(),NOW())`);
  await migrateDeviceAttempts(getTestDb());
  const [row] = await getTestDb().select().from(githubUserConnections).where(eq(githubUserConnections.userId, a.userId));
  expect(row.authFlow).toBe("oauth");
});

test("approved device connection stores provenance, return review, and refreshes without a secret", async () => {
  const a = await principal("refresh");
  const attempt = await start(a, "review_2");
  await due(attempt.attemptId);
  pollResult = token;
  expect(await pollDeviceAuthorization({ ...a, attemptId: attempt.attemptId })).toEqual({ status: "connected", returnReviewId: "review_2" });
  expect(await pollDeviceAuthorization({ ...a, attemptId: attempt.attemptId })).toEqual({ status: "connected", returnReviewId: "review_2" });
  const [row] = await getTestDb().select().from(githubUserConnections).where(eq(githubUserConnections.userId, a.userId));
  expect(row.authFlow).toBe("device");
  expect(row.accessCiphertext).not.toContain(token.access_token);
  expect((await getConnectionStatus({ userId: a.userId })).authMode).toBe("device");
  await getTestDb().update(githubUserConnections).set({ accessExpiresAt: new Date(0) }).where(eq(githubUserConnections.userId, a.userId));
  expect((await checkRepository({ userId: a.userId, repositoryId: 42 })).status).toBe("ready");
  expect(refreshes).toBe(1);
  expect(await disconnect({ userId: a.userId })).toEqual({ status: "disconnected" });
  expect((await getConnectionStatus({ userId: a.userId })).status).toBe("disconnected");
});

test("slow_down is durable and concurrent requests cannot double poll GitHub", async () => {
  const a = await principal("slow"); const attempt = await start(a);
  await due(attempt.attemptId);
  pollResult = { error: "slow_down", interval: 10 };
  expect((await pollDeviceAuthorization({ ...a, attemptId: attempt.attemptId })).status).toBe("slow_down");
  const [row] = await getTestDb().select().from(githubUserDeviceAttempts).where(eq(githubUserDeviceAttempts.attemptId, attempt.attemptId));
  expect(row.intervalSeconds).toBe(10);
  expect((await pollDeviceAuthorization({ ...a, attemptId: attempt.attemptId })).status).toBe("pending");
  expect(polls).toBe(1);
  await due(attempt.attemptId);
  let entered!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  enteredPoll = entered;
  const gate = Promise.withResolvers<void>();
  pollGate = gate.promise;
  const first = pollDeviceAuthorization({ ...a, attemptId: attempt.attemptId });
  await inside;
  const second = await pollDeviceAuthorization({ ...a, attemptId: attempt.attemptId });
  expect(second.status).toBe("pending");
  expect(polls).toBe(2);
  gate.resolve();
  await first;
});

test("cancel, disconnect, supersede, and revoked session fence a late provider success", async () => {
  for (const action of ["cancel", "disconnect", "supersede", "session"] as const) {
    const a = await principal(action);
    const attempt = await start(a);
    await due(attempt.attemptId);
    pollResult = token;
    let entered!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    enteredPoll = entered;
    const gate = Promise.withResolvers<void>();
    pollGate = gate.promise;
    const pending = pollDeviceAuthorization({ ...a, attemptId: attempt.attemptId });
    await inside;
    if (action === "cancel") await cancelDeviceAuthorization({ ...a, attemptId: attempt.attemptId });
    else if (action === "disconnect") await disconnect({ userId: a.userId });
    else if (action === "supersede") await start(a);
    else await getTestDb().delete(sessions).where(eq(sessions.id, a.sessionId));
    gate.resolve();
    expect((await pending).status).toBe("cancelled");
    expect((await getTestDb().select().from(githubUserConnections).where(eq(githubUserConnections.userId, a.userId))).length).toBe(0);
    pollGate = undefined; enteredPoll = undefined;
  }
});

test("provider denial and local expiry are terminal", async () => {
  const a = await principal("deny");
  const denied = await start(a);
  await due(denied.attemptId);
  pollResult = { error: "access_denied" };
  expect((await pollDeviceAuthorization({ ...a, attemptId: denied.attemptId })).status).toBe("denied");
  const expired = await start(a);
  await getTestDb().update(githubUserDeviceAttempts).set({ expiresAt: new Date(0) }).where(eq(githubUserDeviceAttempts.attemptId, expired.attemptId));
  expect((await pollDeviceAuthorization({ ...a, attemptId: expired.attemptId })).status).toBe("expired");
});

test("changed App binding cancels polling, and another GitHub account cannot replace the owner", async () => {
  const a = await principal("binding");
  const changed = await start(a);
  await due(changed.attemptId);
  await getTestDb().update(githubUserDeviceAttempts).set({ appId: 999 }).where(eq(githubUserDeviceAttempts.attemptId, changed.attemptId));
  expect((await pollDeviceAuthorization({ ...a, attemptId: changed.attemptId })).status).toBe("cancelled");
  expect(polls).toBe(0);
  const first = await start(a);
  await due(first.attemptId);
  pollResult = token;
  expect((await pollDeviceAuthorization({ ...a, attemptId: first.attemptId })).status).toBe("connected");
  const second = await start(a);
  await due(second.attemptId);
  accountId = 72;
  expect((await pollDeviceAuthorization({ ...a, attemptId: second.attemptId })).status).toBe("denied");
  const [row] = await getTestDb().select().from(githubUserConnections).where(eq(githubUserConnections.userId, a.userId));
  expect(row.githubAccountId).toBe(71);
});
