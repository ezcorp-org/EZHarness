import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "../../../__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../../__tests__/helpers/mock-cleanup";
import { createUser } from "../../../db/queries/users";
import { githubUserAuthorities, githubUserConnections, githubUserEffectClaims, sessions } from "../../../db/schema";
import { decryptWithAad } from "../../../providers/encryption";
import { assertUserEffectCurrent, checkRepository, completeAuthorization, disconnect, getConnectionBinding, getConnectionStatus, listAccessibleRepositories, startAuthorization, withUserToken, withUserTokenReadOnly } from "../broker";

mockDbConnection();
const oldFetch = globalThis.fetch;
const oldEnv = {
  instanceId: process.env.EZ_GITHUB_INSTANCE_ID, appId: process.env.EZ_GITHUB_APP_ID, slug: process.env.EZ_GITHUB_APP_SLUG,
  clientId: process.env.EZ_GITHUB_APP_CLIENT_ID, secret: process.env.EZ_GITHUB_APP_CLIENT_SECRET,
  callback: process.env.EZ_GITHUB_APP_CALLBACK_URL,
  mode: process.env.EZ_GITHUB_AUTH_MODE,
};
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const userId = async (email: string) => (await createUser({ email, name: email, passwordHash: "hash" })).id;
const seedSession = async (id: string, ownerId: string) => { await getTestDb().insert(sessions).values({ id, userId: ownerId, tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000) }); };

function setGithubFetch(onExchange?: () => Promise<void>, options: { push?: boolean; appContents?: string; refreshFails?: boolean; repoId?: number; accountId?: number; installTotal?: number; repoTotal?: number; installPage?: number } = {}): void {
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.endsWith("/login/oauth/access_token")) {
      await onExchange?.();
      const params = new URLSearchParams(String(init?.body));
      if (params.get("grant_type") === "refresh_token") return options.refreshFails ? reply({ error: "bad_verification_code" }, 401) : reply({ access_token: "access-refreshed", refresh_token: "refresh-refreshed", expires_in: 28800, refresh_token_expires_in: 15897600 });
      return reply({ access_token: params.get("code") === "second" ? "access-two" : "access-one", refresh_token: "refresh-one", expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    if (url.endsWith("/user")) return reply({ id: options.accountId ?? 71, login: "owner" });
    if (url.includes("/user/installations?")) return reply({ total_count: options.installTotal ?? 1, installations: options.installTotal === 1001 || (options.installPage && new URL(url).searchParams.get("page") !== String(options.installPage)) ? [] : [{ id: 50, app_id: 123, permissions: { contents: options.appContents ?? "write", pull_requests: "write" } }] });
    if (url.includes("/user/installations/50/repositories?")) return reply({ total_count: options.repoTotal ?? 1, repositories: options.repoTotal === 1001 ? [] : [{ id: 42, full_name: "owner/repo", default_branch: "main", private: true }] });
    if (url.endsWith("/repos/owner/repo")) return reply({ id: options.repoId ?? 42, permissions: { pull: true, push: options.push ?? true } });
    if (url.endsWith("/applications/client/token")) return new Response(null, { status: 204 });
    throw new Error(`Unexpected GitHub URL: ${url}`);
  }, { preconnect: () => {} });
}

async function connect(id: string, session = "session-a", code = "first") {
  await seedSession(session, id);
  const { authorizeUrl } = await startAuthorization({ userId: id, sessionId: session });
  const state = new URL(authorizeUrl).searchParams.get("state")!;
  return completeAuthorization({ userId: id, sessionId: session, state, code });
}

describe("personal GitHub credential broker", () => {
  beforeEach(async () => {
    await setupTestDb();
    process.env.EZ_GITHUB_INSTANCE_ID = "instance-test";
    process.env.EZ_GITHUB_APP_ID = "123";
    process.env.EZ_GITHUB_APP_SLUG = "ezharness-test";
    process.env.EZ_GITHUB_APP_CLIENT_ID = "client";
    process.env.EZ_GITHUB_APP_CLIENT_SECRET = "secret";
    process.env.EZ_GITHUB_APP_CALLBACK_URL = "https://app.example/api/github/callback";
    process.env.EZ_GITHUB_AUTH_MODE = "oauth";
    setGithubFetch();
  });
  afterAll(async () => {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries({ EZ_GITHUB_INSTANCE_ID: oldEnv.instanceId, EZ_GITHUB_APP_ID: oldEnv.appId, EZ_GITHUB_APP_SLUG: oldEnv.slug, EZ_GITHUB_APP_CLIENT_ID: oldEnv.clientId, EZ_GITHUB_APP_CLIENT_SECRET: oldEnv.secret, EZ_GITHUB_APP_CALLBACK_URL: oldEnv.callback, EZ_GITHUB_AUTH_MODE: oldEnv.mode })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await closeTestDb();
    restoreModuleMocks();
  });

  test("OAuth binds user and session, stores ciphertext, and denies another user", async () => {
    const a = await userId("a@github-user.test");
    const b = await userId("b@github-user.test");
    await seedSession("a-session", a);
    await seedSession("b-session", b);
    const { authorizeUrl } = await startAuthorization({ userId: a, sessionId: "a-session" });
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    expect(new URL(authorizeUrl).searchParams.get("code_challenge_method")).toBe("S256");
    await expect(completeAuthorization({ userId: b, sessionId: "a-session", state, code: "first" })).rejects.toThrow();
    await expect(completeAuthorization({ userId: a, sessionId: "b-session", state, code: "first" })).rejects.toThrow();
    expect((await completeAuthorization({ userId: a, sessionId: "a-session", state, code: "first" })).account).toEqual({ id: 71, login: "owner" });
    await expect(completeAuthorization({ userId: a, sessionId: "a-session", state, code: "first" })).rejects.toThrow();
    expect((await getConnectionStatus({ userId: b })).status).toBe("disconnected");
    expect(await getConnectionBinding({ userId: a })).toEqual({ githubAccountId: 71, generation: 1 });
    await expect(getConnectionBinding({ userId: b })).rejects.toThrow("Connect GitHub again");
    const [row] = await getTestDb().select().from(githubUserConnections).where(eq(githubUserConnections.userId, a));
    expect(row.accessCiphertext).not.toContain("access-one");
    expect(() => decryptWithAad(row.accessCiphertext, `github-user:v1:instance-test:${b}:71:123:access`)).toThrow();
    expect((await checkRepository({ userId: a, repositoryId: 42 })).status).toBe("ready");
  });

  test("disconnect fences a callback that is still exchanging its code", async () => {
    const a = await userId("late@github-user.test");
    await seedSession("same", a);
    let release!: () => void;
    let exchanging!: () => void;
    const entered = new Promise<void>((resolve) => { exchanging = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setGithubFetch(async () => { exchanging(); await gate; });
    const { authorizeUrl } = await startAuthorization({ userId: a, sessionId: "same" });
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const completing = completeAuthorization({ userId: a, sessionId: "same", state, code: "first" });
    await entered;
    await disconnect({ userId: a });
    release();
    await expect(completing).rejects.toThrow("stale");
    expect((await getConnectionStatus({ userId: a })).status).toBe("disconnected");
  });

  test("revoking the local session during OAuth exchange cannot install credentials", async () => {
    const a = await userId("revoked-session@github-user.test");
    await seedSession("revoked-session", a);
    let release!: () => void;
    let exchanging!: () => void;
    const entered = new Promise<void>((resolve) => { exchanging = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setGithubFetch(async () => { exchanging(); await gate; });
    const { authorizeUrl } = await startAuthorization({ userId: a, sessionId: "revoked-session" });
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const completing = completeAuthorization({ userId: a, sessionId: "revoked-session", state, code: "first" });
    await entered;
    await getTestDb().delete(sessions).where(eq(sessions.id, "revoked-session"));
    release();
    await expect(completing).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect((await getConnectionStatus({ userId: a })).status).toBe("disconnected");
  });

  test("invalid GitHub identity is refused and corrupt ciphertext cannot block local disconnect", async () => {
    const a = await userId("invalid@github-user.test");
    await seedSession("invalid-session", a);
    setGithubFetch(undefined, { accountId: 0 });
    const { authorizeUrl } = await startAuthorization({ userId: a, sessionId: "invalid-session" });
    await expect(completeAuthorization({ userId: a, sessionId: "invalid-session", state: new URL(authorizeUrl).searchParams.get("state")!, code: "first" })).rejects.toThrow("Invalid GitHub account");
    expect((await getConnectionStatus({ userId: a })).status).toBe("disconnected");
    setGithubFetch();
    await connect(a, "valid-session");
    await getTestDb().update(githubUserConnections).set({ accessCiphertext: "corrupt" }).where(eq(githubUserConnections.userId, a));
    expect((await disconnect({ userId: a })).status).toBe("disconnected");
  });

  test("dispatch claim precedes an effect and disconnect cannot revive the connection", async () => {
    const a = await userId("effect@github-user.test");
    await connect(a);
    const [authority] = await getTestDb().select().from(githubUserAuthorities).where(eq(githubUserAuthorities.userId, a));
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const effect = withUserToken({ userId: a, repositoryId: 42, operationId: "one", kind: "publish", expectedGeneration: authority.generation, authorizeDispatch: async () => {} }, async () => {
      entered(); await gate; return "done";
    });
    await inside;
    const [claim] = await getTestDb().select().from(githubUserEffectClaims).where(eq(githubUserEffectClaims.operationId, "one"));
    expect(claim.state).toBe("dispatched");
    await disconnect({ userId: a });
    release();
    expect(await effect).toBe("done");
    await expect(withUserToken({ userId: a, repositoryId: 42, operationId: "two", kind: "publish", expectedGeneration: authority.generation, authorizeDispatch: async () => {} }, async () => "bad")).rejects.toThrow();
  });

  test("refresh rotates the pair atomically without changing authorization generation", async () => {
    const a = await userId("refresh@github-user.test");
    await connect(a);
    const [before] = await getTestDb().select().from(githubUserAuthorities).where(eq(githubUserAuthorities.userId, a));
    await getTestDb().update(githubUserConnections).set({ accessExpiresAt: new Date(0) }).where(eq(githubUserConnections.userId, a));
    expect((await checkRepository({ userId: a, repositoryId: 42 })).status).toBe("ready");
    const [after] = await getTestDb().select().from(githubUserConnections).where(eq(githubUserConnections.userId, a));
    const [authority] = await getTestDb().select().from(githubUserAuthorities).where(eq(githubUserAuthorities.userId, a));
    expect(authority.generation).toBe(before.generation);
    expect(after.tokenRevision).toBe(1);
    expect(decryptWithAad(after.accessCiphertext, `github-user:v1:instance-test:${a}:71:123:access`)).toBe("access-refreshed");
    expect(decryptWithAad(after.refreshCiphertext, `github-user:v1:instance-test:${a}:71:123:refresh`)).toBe("refresh-refreshed");
  });

  test("failed refresh marks the current connection for reconnect", async () => {
    const a = await userId("refresh-fail@github-user.test");
    await connect(a);
    await getTestDb().update(githubUserConnections).set({ accessExpiresAt: new Date(0) }).where(eq(githubUserConnections.userId, a));
    setGithubFetch(undefined, { refreshFails: true });
    await expect(checkRepository({ userId: a, repositoryId: 42 })).rejects.toThrow();
    expect((await getConnectionStatus({ userId: a })).status).toBe("reconnect_required");
  });

  test("a refresh held at GitHub cannot restore authority after disconnect", async () => {
    const a = await userId("refresh-disconnect@github-user.test");
    await connect(a);
    await getTestDb().update(githubUserConnections).set({ accessExpiresAt: new Date(0) }).where(eq(githubUserConnections.userId, a));
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url.endsWith("/login/oauth/access_token") && new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token") {
        entered(); await gate;
        return reply({ access_token: "access-refreshed", refresh_token: "refresh-refreshed", expires_in: 28800, refresh_token_expires_in: 15897600 });
      }
      if (url.endsWith("/applications/client/token")) return new Response(null, { status: 204 });
      if (url.includes("/user/installations?")) return reply({ total_count: 1, installations: [{ id: 50, app_id: 123, permissions: { contents: "write", pull_requests: "write" } }] });
      if (url.includes("/user/installations/50/repositories?")) return reply({ total_count: 1, repositories: [{ id: 42, full_name: "owner/repo" }] });
      if (url.endsWith("/repos/owner/repo")) return reply({ id: 42, permissions: { pull: true, push: true } });
      throw new Error(`Unexpected GitHub URL: ${url}`);
    }, { preconnect: () => {} });
    const checking = checkRepository({ userId: a, repositoryId: 42 });
    await inside;
    const stopping = disconnect({ userId: a });
    release();
    const [, stopped] = await Promise.allSettled([checking, stopping]);
    expect(stopped.status).toBe("fulfilled");
    expect((await getConnectionStatus({ userId: a })).status).toBe("disconnected");
  });

  test("same-account reconnect does not authorize an old operation", async () => {
    const a = await userId("reconnect@github-user.test");
    await connect(a);
    const [before] = await getTestDb().select().from(githubUserAuthorities).where(eq(githubUserAuthorities.userId, a));
    await connect(a, "session-b", "second");
    const [after] = await getTestDb().select().from(githubUserAuthorities).where(eq(githubUserAuthorities.userId, a));
    expect(after.generation).toBe(before.generation + 1);
    let ran = false;
    await expect(withUserToken({ userId: a, repositoryId: 42, operationId: "stale", kind: "publish", expectedGeneration: before.generation, authorizeDispatch: async () => {} }, async () => { ran = true; })).rejects.toThrow("changed");
    expect(ran).toBe(false);
  });

  test("repository picker and access checks use GitHub installation and user permissions", async () => {
    const a = await userId("permissions@github-user.test");
    await connect(a);
    expect(await listAccessibleRepositories({ userId: a })).toEqual([{ id: 42, fullName: "owner/repo", defaultBranch: "main", private: true, accessStatus: "ready" }]);
    expect((await checkRepository({ userId: a, repositoryId: 99 })).status).toBe("repository_not_enabled");
    setGithubFetch(undefined, { push: false });
    expect((await checkRepository({ userId: a, repositoryId: 42 })).status).toBe("insufficient_user_permission");
    await expect(withUserToken({ userId: a, repositoryId: 42, operationId: "denied", kind: "publish", expectedGeneration: 1, authorizeDispatch: async () => {} }, async () => "bad")).rejects.toThrow("access");
    expect((await getTestDb().select().from(githubUserEffectClaims).where(eq(githubUserEffectClaims.operationId, "denied"))).length).toBe(0);
    expect(await withUserToken({ userId: a, repositoryId: 42, operationId: "read", kind: "import" }, async (token) => token)).toBe("access-one");
  });

  test("an uncertain dispatched effect is never retried under its operation ID", async () => {
    const a = await userId("uncertain@github-user.test");
    await connect(a);
    await expect(withUserToken({ userId: a, repositoryId: 42, operationId: "maybe", kind: "import" }, async () => { throw new Error("network response lost"); })).rejects.toThrow("network response lost");
    const [claim] = await getTestDb().select().from(githubUserEffectClaims).where(eq(githubUserEffectClaims.operationId, "maybe"));
    expect(claim.state).toBe("unknown");
    const binding = await getConnectionBinding({ userId: a });
    expect(await withUserTokenReadOnly({ userId: a, repositoryId: 42, expectedAccountId: binding.githubAccountId }, async (token) => token)).toBe("access-one");
    expect((await getTestDb().select().from(githubUserEffectClaims)).length).toBe(1);
    let repeated = false;
    await expect(withUserToken({ userId: a, repositoryId: 42, operationId: "maybe", kind: "import" }, async () => { repeated = true; })).rejects.toThrow();
    expect(repeated).toBe(false);
    await disconnect({ userId: a });
    await expect(withUserTokenReadOnly({ userId: a, repositoryId: 42, expectedAccountId: binding.githubAccountId }, async () => "bad")).rejects.toThrow();
  });

  test("read-only reconciliation can use a reconnected matching account", async () => {
    const a = await userId("reconcile-after-reconnect@github-user.test");
    await connect(a);
    const original = await getConnectionBinding({ userId: a });
    await disconnect({ userId: a });
    await connect(a, "reconnected-session", "second");
    expect(await withUserTokenReadOnly({ userId: a, repositoryId: 42, expectedAccountId: original.githubAccountId }, async token => token)).toBe("access-two");
    await expect(withUserToken({ userId: a, repositoryId: 42, operationId: "old-generation", kind: "publish", expectedGeneration: original.generation, authorizeDispatch: async () => {} }, async () => "bad")).rejects.toMatchObject({ code: "STALE_CONNECTION" });
    await disconnect({ userId: a });
    setGithubFetch(undefined, { accountId: 72 });
    await connect(a, "other-account-session", "second");
    let read = false;
    await expect(withUserTokenReadOnly({ userId: a, repositoryId: 42, expectedAccountId: original.githubAccountId }, async () => { read = true; })).rejects.toMatchObject({ code: "STALE_CONNECTION" });
    expect(read).toBe(false);
  });

  test("disconnect and reconnect fence later requests of a claimed publication", async () => {
    const a = await userId("multi-effect@github-user.test");
    const b = await userId("other-effect@github-user.test");
    await connect(a);
    const binding = await getConnectionBinding({ userId: a });
    const operation = { userId: a, repositoryId: 42, operationId: "several-requests", expectedGeneration: binding.generation };
    await expect(assertUserEffectCurrent(operation)).rejects.toThrow("changed");
    await withUserToken({ ...operation, kind: "publish", authorizeDispatch: async () => {} }, async () => {
      await assertUserEffectCurrent(operation);
      await expect(assertUserEffectCurrent({ ...operation, userId: b })).rejects.toThrow("changed");
      await expect(assertUserEffectCurrent({ ...operation, repositoryId: 99 })).rejects.toThrow("changed");
      await disconnect({ userId: a });
      await expect(assertUserEffectCurrent(operation)).rejects.toThrow("changed");
      await connect(a, "reconnected-effect", "two");
      await expect(assertUserEffectCurrent(operation)).rejects.toThrow("changed");
    });
    await expect(assertUserEffectCurrent(operation)).rejects.toThrow("changed");
    expect((await getTestDb().select().from(githubUserEffectClaims)).length).toBe(1);
  });

  test("repository enumeration reads later pages and refuses an incomplete scan", async () => {
    const a = await userId("pagination@github-user.test");
    await connect(a);
    setGithubFetch(undefined, { installTotal: 101, installPage: 2 });
    expect((await checkRepository({ userId: a, repositoryId: 42 })).status).toBe("ready");
    setGithubFetch(undefined, { repoTotal: 1001 });
    await expect(checkRepository({ userId: a, repositoryId: 42 })).rejects.toThrow("Too many GitHub repositories");
    setGithubFetch(undefined, { installTotal: 1001 });
    await expect(checkRepository({ userId: a, repositoryId: 42 })).rejects.toThrow("Too many GitHub installations");
  });
});
