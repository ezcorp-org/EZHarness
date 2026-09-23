import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, type DbTransaction } from "../../db/connection";
import { githubUserAuthorities, githubUserConnections, githubUserDeviceAttempts, githubUserEffectClaims, githubUserOAuthAttempts, sessions } from "../../db/schema";
import { decryptWithAad, encryptWithAad } from "../../providers/encryption";
import { getGithubOAuthConfig, getGithubUserConfig } from "./config";
import { beginDeviceCode, exchangeCode, exchangeDeviceCode, githubApi, GithubUserError, refreshDevicePair, refreshPair, revokeToken, type GithubTokenPair } from "./transport";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const aad = (userId: string, accountId: number, appId: number, kind: "access" | "refresh") => `github-user:v1:${getGithubUserConfig().instanceId}:${userId}:${accountId}:${appId}:${kind}`;
const oauthAad = (userId: string, stateDigest: string) => `github-user-oauth:${getGithubUserConfig().instanceId}:${userId}:${stateDigest}`;
const deviceAad = (userId: string, attemptId: string) => `github-user-device:${getGithubUserConfig().instanceId}:${userId}:${attemptId}`;
const expires = (seconds: number) => new Date(Date.now() + seconds * 1000);
const tokenCipher = (pair: GithubTokenPair, userId: string, accountId: number, appId: number) => ({
  accessCiphertext: encryptWithAad(pair.access_token, aad(userId, accountId, appId, "access")),
  refreshCiphertext: encryptWithAad(pair.refresh_token, aad(userId, accountId, appId, "refresh")),
  accessExpiresAt: expires(pair.expires_in), refreshExpiresAt: expires(pair.refresh_token_expires_in),
});

/** UPDATE obtains the database row lock used by callback, refresh, disconnect, and dispatch. */
async function lockAuthority(tx: DbTransaction, userId: string): Promise<{ generation: number }> {
  await tx.insert(githubUserAuthorities).values({ userId }).onConflictDoNothing();
  const [row] = await tx.update(githubUserAuthorities).set({ updatedAt: new Date() }).where(eq(githubUserAuthorities.userId, userId)).returning({ generation: githubUserAuthorities.generation });
  if (!row) throw new GithubUserError("NO_USER", "User is unavailable");
  return row;
}

async function requireLiveSession(tx: DbTransaction, userId: string, sessionId: string): Promise<void> {
  const [session] = await tx.select({ userId: sessions.userId, expiresAt: sessions.expiresAt }).from(sessions).where(eq(sessions.id, sessionId)).for("update");
  if (!session || session.userId !== userId || session.expiresAt <= new Date()) throw new GithubUserError("SESSION_EXPIRED", "Sign in again to connect GitHub");
}

const installationUrl = (appSlug: string) => `https://github.com/apps/${appSlug}/installations/new`;
export type ConnectionStatus = { configured: boolean; authMode: "device" | "oauth" | null; status: "disconnected" | "connected" | "reconnect_required"; installUrl?: string; account?: { id: number; login: string } };
export async function getConnectionStatus({ userId }: { userId: string }): Promise<ConnectionStatus> {
  let config: ReturnType<typeof getGithubUserConfig> | undefined;
  try { config = getGithubUserConfig(); } catch { /* Invalid configuration is reported as disconnected. */ }
  const publicConfig = config ? { configured: true, authMode: config.mode, installUrl: installationUrl(config.appSlug) } : { configured: false, authMode: null };
  const [row] = await getDb().select().from(githubUserConnections).where(eq(githubUserConnections.userId, userId));
  if (!row) return { ...publicConfig, status: "disconnected" };
  return { ...publicConfig, status: row.state, account: { id: row.githubAccountId, login: row.githubLogin } };
}

/** Host-only immutable identity to bind a new proposal before review. */
export async function getConnectionBinding({ userId }: { userId: string }): Promise<{ githubAccountId: number; generation: number }> {
  return getDb().transaction(async (tx: DbTransaction) => {
    const authority = await lockAuthority(tx, userId);
    const [row] = await tx.select().from(githubUserConnections).where(eq(githubUserConnections.userId, userId));
    if (row?.state !== "connected") throw new GithubUserError("RECONNECT_REQUIRED", "Connect GitHub again");
    return { githubAccountId: row.githubAccountId, generation: authority.generation };
  });
}

export async function startAuthorization({ userId, sessionId, returnReviewId }: { userId: string; sessionId: string; returnReviewId?: string }): Promise<{ authorizeUrl: string }> {
  const config = getGithubOAuthConfig();
  if (returnReviewId && !/^[A-Za-z0-9_-]{1,128}$/.test(returnReviewId)) throw new GithubUserError("INVALID_RETURN", "Invalid review reference");
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await getDb().transaction(async (tx: DbTransaction) => {
    await requireLiveSession(tx, userId, sessionId);
    const authority = await lockAuthority(tx, userId);
    await tx.insert(githubUserOAuthAttempts).values({
      stateDigest: digest(state), userId, sessionDigest: digest(sessionId), expectedGeneration: authority.generation,
      verifierCiphertext: encryptWithAad(verifier, oauthAad(userId, digest(state))),
      returnReviewId: returnReviewId ?? null, expiresAt: new Date(Date.now() + 10 * 60_000),
    });
  });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { authorizeUrl: url.toString() };
}

export async function completeAuthorization({ userId, sessionId, state, code }: { userId: string; sessionId: string; state: string; code: string }): Promise<{ returnReviewId?: string; account: { id: number; login: string } }> {
  const config = getGithubOAuthConfig();
  if (!state || !code || state.length > 256 || code.length > 2048) throw new GithubUserError("INVALID_CALLBACK", "Invalid GitHub callback");
  const stateDigest = digest(state);
  const attempt = await getDb().transaction(async (tx: DbTransaction) => {
    await requireLiveSession(tx, userId, sessionId);
    const [found] = await tx.update(githubUserOAuthAttempts)
      .set({ consumedAt: new Date() })
      .where(and(eq(githubUserOAuthAttempts.stateDigest, stateDigest), eq(githubUserOAuthAttempts.userId, userId), eq(githubUserOAuthAttempts.sessionDigest, digest(sessionId)), isNull(githubUserOAuthAttempts.consumedAt)))
      .returning();
    if (!found || found.expiresAt <= new Date()) throw new GithubUserError("INVALID_CALLBACK", "GitHub authorization expired or was already used");
    const authority = await lockAuthority(tx, userId);
    if (authority.generation !== found.expectedGeneration) throw new GithubUserError("STALE_CALLBACK", "GitHub authorization is stale");
    return found;
  });
  const verifier = decryptWithAad(attempt.verifierCiphertext, oauthAad(userId, stateDigest));
  const pair = await exchangeCode(config, code, verifier);
  let account: { id: number; login: string };
  try {
    const user = await githubApi<{ id: number; login: string }>(pair.access_token, "/user");
    if (!Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.login !== "string" || !user.login) throw new GithubUserError("INVALID_ACCOUNT", "Invalid GitHub account");
    account = { id: user.id, login: user.login };
  } catch (error) {
    await revokeToken(config, pair.access_token).catch(() => undefined);
    throw error;
  }
  try {
    const previousToken = await getDb().transaction(async (tx: DbTransaction) => {
      await requireLiveSession(tx, userId, sessionId);
      const authority = await lockAuthority(tx, userId);
      if (authority.generation !== attempt.expectedGeneration) throw new GithubUserError("STALE_CALLBACK", "GitHub authorization is stale");
      const [old] = await tx.select().from(githubUserConnections).where(eq(githubUserConnections.userId, userId));
      const generation = authority.generation + 1;
      await tx.update(githubUserAuthorities).set({ generation, updatedAt: new Date() }).where(eq(githubUserAuthorities.userId, userId));
      const token = tokenCipher(pair, userId, account.id, config.appId);
      const connectionId = crypto.randomUUID();
      if (old && old.githubAccountId !== account.id) throw new GithubUserError("ACCOUNT_MISMATCH", "Disconnect the existing GitHub account before connecting another");
      await tx.insert(githubUserConnections).values({ userId, connectionId, githubAccountId: account.id, githubLogin: account.login, appId: config.appId, authFlow: "oauth", ...token })
        .onConflictDoUpdate({ target: githubUserConnections.userId, set: { connectionId, githubAccountId: account.id, githubLogin: account.login, appId: config.appId, authFlow: "oauth", ...token, tokenRevision: 0, state: "connected", updatedAt: new Date() } });
      return old ? decryptWithAad(old.accessCiphertext, aad(userId, old.githubAccountId, old.appId, "access")) : null;
    });
    if (previousToken && previousToken !== pair.access_token) await revokeToken(config, previousToken).catch(() => undefined);
  } catch (error) {
    await revokeToken(config, pair.access_token).catch(() => undefined);
    throw error;
  }
  return { account, ...(attempt.returnReviewId ? { returnReviewId: attempt.returnReviewId } : {}) };
}

type DeviceInput = { userId: string; sessionId: string; attemptId: string };
export type DevicePollResult = { status: "pending" | "slow_down"; nextPollAt: string } | { status: "connected"; returnReviewId?: string } | { status: "expired" | "denied" | "cancelled" };
const unavailableAttempt = () => new GithubUserError("DEVICE_ATTEMPT_UNAVAILABLE", "GitHub device authorization is unavailable");

/** GitHub receives only the public client ID. The device secret stays encrypted locally. */
export async function startDeviceAuthorization({ userId, sessionId, returnReviewId }: { userId: string; sessionId: string; returnReviewId?: string }): Promise<{ attemptId: string; userCode: string; verificationUri: string; expiresAt: string; intervalSeconds: number }> {
  const config = getGithubUserConfig();
  if (config.mode !== "device") throw new GithubUserError("DEVICE_DISABLED", "GitHub device authorization is disabled");
  if (returnReviewId && !/^[A-Za-z0-9_-]{1,128}$/.test(returnReviewId)) throw new GithubUserError("INVALID_RETURN", "Invalid review reference");
  await getDb().transaction((tx: DbTransaction) => requireLiveSession(tx, userId, sessionId));
  const code = await beginDeviceCode(config);
  const attemptId = crypto.randomUUID();
  const expiresAt = expires(code.expiresIn);
  await getDb().transaction(async (tx: DbTransaction) => {
    await requireLiveSession(tx, userId, sessionId);
    const authority = await lockAuthority(tx, userId);
    await tx.update(githubUserDeviceAttempts).set({ status: "cancelled", pollClaimToken: null, pollClaimExpiresAt: null })
      .where(and(eq(githubUserDeviceAttempts.userId, userId), eq(githubUserDeviceAttempts.status, "pending")));
    await tx.insert(githubUserDeviceAttempts).values({
      attemptId, userId, sessionDigest: digest(sessionId), expectedGeneration: authority.generation,
      appId: config.appId, clientId: config.clientId,
      deviceCiphertext: encryptWithAad(code.deviceCode, deviceAad(userId, attemptId)),
      returnReviewId: returnReviewId ?? null, intervalSeconds: code.interval,
      nextPollAt: expires(code.interval), expiresAt,
    });
  });
  return { attemptId, userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: expiresAt.toISOString(), intervalSeconds: code.interval };
}

/** A local cancel commits before any in-flight GitHub response can install tokens. */
export async function cancelDeviceAuthorization({ userId, sessionId, attemptId }: DeviceInput): Promise<{ status: "cancelled" }> {
  if (!/^[0-9a-f-]{36}$/.test(attemptId)) throw unavailableAttempt();
  await getDb().transaction(async (tx: DbTransaction) => {
    await requireLiveSession(tx, userId, sessionId);
    await lockAuthority(tx, userId);
    const [attempt] = await tx.select().from(githubUserDeviceAttempts).where(eq(githubUserDeviceAttempts.attemptId, attemptId));
    if (!attempt || attempt.userId !== userId || attempt.sessionDigest !== digest(sessionId)) throw unavailableAttempt();
    if (attempt.status === "connected") throw unavailableAttempt();
    await tx.update(githubUserDeviceAttempts).set({ status: "cancelled", pollClaimToken: null, pollClaimExpiresAt: null })
      .where(eq(githubUserDeviceAttempts.attemptId, attemptId));
  });
  return { status: "cancelled" };
}

/** Reserve the provider interval in the DB, then release its lock before HTTP. */
export async function pollDeviceAuthorization({ userId, sessionId, attemptId }: DeviceInput): Promise<DevicePollResult> {
  if (!/^[0-9a-f-]{36}$/.test(attemptId)) throw unavailableAttempt();
  const config = getGithubUserConfig();
  if (config.mode !== "device") throw new GithubUserError("DEVICE_DISABLED", "GitHub device authorization is disabled");
  const claimed = await getDb().transaction(async (tx: DbTransaction) => {
    await requireLiveSession(tx, userId, sessionId);
    const authority = await lockAuthority(tx, userId);
    const [attempt] = await tx.select().from(githubUserDeviceAttempts).where(eq(githubUserDeviceAttempts.attemptId, attemptId));
    if (!attempt || attempt.userId !== userId || attempt.sessionDigest !== digest(sessionId)) throw unavailableAttempt();
    if (attempt.status !== "pending") return { result: { status: attempt.status, ...(attempt.status === "connected" && attempt.returnReviewId ? { returnReviewId: attempt.returnReviewId } : {}) } as DevicePollResult };
    const now = new Date();
    if (attempt.expiresAt <= now) {
      await tx.update(githubUserDeviceAttempts).set({ status: "expired", pollClaimToken: null, pollClaimExpiresAt: null }).where(eq(githubUserDeviceAttempts.attemptId, attemptId));
      return { result: { status: "expired" as const } };
    }
    if (attempt.expectedGeneration !== authority.generation || attempt.appId !== config.appId || attempt.clientId !== config.clientId) {
      await tx.update(githubUserDeviceAttempts).set({ status: "cancelled", pollClaimToken: null, pollClaimExpiresAt: null }).where(eq(githubUserDeviceAttempts.attemptId, attemptId));
      return { result: { status: "cancelled" as const } };
    }
    const next = Math.max(attempt.nextPollAt.getTime(), attempt.pollClaimExpiresAt?.getTime() ?? 0);
    if (next > now.getTime()) return { result: { status: "pending" as const, nextPollAt: new Date(next).toISOString() } };
    const claimToken = crypto.randomUUID();
    const nextPollAt = new Date(now.getTime() + attempt.intervalSeconds * 1000);
    // Two sequential 15-second GitHub calls plus time to persist the result.
    await tx.update(githubUserDeviceAttempts).set({ pollClaimToken: claimToken, pollClaimExpiresAt: new Date(now.getTime() + 90_000), nextPollAt }).where(eq(githubUserDeviceAttempts.attemptId, attemptId));
    return { attempt, claimToken };
  });
  if ("result" in claimed) return claimed.result;
  const deviceCode = decryptWithAad(claimed.attempt.deviceCiphertext, deviceAad(userId, attemptId));
  const response = await exchangeDeviceCode(config, deviceCode);
  const approvedPair = response.status === "connected" ? response.pair : undefined;
  let account: { id: number; login: string } | undefined;
  if (approvedPair) {
    try {
      const user = await githubApi<{ id: number; login: string }>(approvedPair.access_token, "/user");
      if (!Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.login !== "string" || !user.login) throw new GithubUserError("INVALID_ACCOUNT", "Invalid GitHub account");
      account = { id: user.id, login: user.login };
    } catch {
      // The exchange consumed the code. Retrying it cannot recover this attempt.
      await getDb().update(githubUserDeviceAttempts).set({ status: "cancelled", pollClaimToken: null, pollClaimExpiresAt: null })
        .where(and(eq(githubUserDeviceAttempts.attemptId, attemptId), eq(githubUserDeviceAttempts.status, "pending"), eq(githubUserDeviceAttempts.pollClaimToken, claimed.claimToken)));
      throw new GithubUserError("DEVICE_RESTART_REQUIRED", "GitHub account lookup failed. Start a new connection.");
    }
  }
  const result = await getDb().transaction(async (tx: DbTransaction) => {
    const authority = await lockAuthority(tx, userId);
    const [attempt] = await tx.select().from(githubUserDeviceAttempts).where(eq(githubUserDeviceAttempts.attemptId, attemptId));
    if (!attempt || attempt.userId !== userId || attempt.sessionDigest !== digest(sessionId)) throw unavailableAttempt();
    if (attempt.status !== "pending" || attempt.pollClaimToken !== claimed.claimToken) return { status: "cancelled" as const };
    const [session] = await tx.select({ userId: sessions.userId, expiresAt: sessions.expiresAt }).from(sessions).where(eq(sessions.id, sessionId));
    if (!session || session.userId !== userId || session.expiresAt <= new Date() || attempt.expiresAt <= new Date() || authority.generation !== attempt.expectedGeneration) {
      const status = attempt.expiresAt <= new Date() ? "expired" : "cancelled";
      await tx.update(githubUserDeviceAttempts).set({ status, pollClaimToken: null, pollClaimExpiresAt: null }).where(eq(githubUserDeviceAttempts.attemptId, attemptId));
      return { status } as DevicePollResult;
    }
    if (response.status === "pending" || response.status === "slow_down") {
      const intervalSeconds = response.status === "slow_down" ? Math.max(attempt.intervalSeconds + 5, response.interval ?? 0) : attempt.intervalSeconds;
      const nextPollAt = expires(intervalSeconds);
      await tx.update(githubUserDeviceAttempts).set({ intervalSeconds, nextPollAt, pollClaimToken: null, pollClaimExpiresAt: null }).where(eq(githubUserDeviceAttempts.attemptId, attemptId));
      return { status: response.status, nextPollAt: nextPollAt.toISOString() };
    }
    if (response.status === "expired" || response.status === "denied") {
      await tx.update(githubUserDeviceAttempts).set({ status: response.status, pollClaimToken: null, pollClaimExpiresAt: null }).where(eq(githubUserDeviceAttempts.attemptId, attemptId));
      return { status: response.status };
    }
    const [old] = await tx.select().from(githubUserConnections).where(eq(githubUserConnections.userId, userId));
    if (old && old.githubAccountId !== account!.id) {
      await tx.update(githubUserDeviceAttempts).set({ status: "denied", pollClaimToken: null, pollClaimExpiresAt: null }).where(eq(githubUserDeviceAttempts.attemptId, attemptId));
      return { status: "denied" as const };
    }
    if (!approvedPair || !account) throw new GithubUserError("DEVICE_EXCHANGE_FAILED", "GitHub device authorization is unavailable");
    const token = tokenCipher(approvedPair, userId, account.id, config.appId);
    const connectionId = crypto.randomUUID();
    await tx.update(githubUserAuthorities).set({ generation: authority.generation + 1, updatedAt: new Date() }).where(eq(githubUserAuthorities.userId, userId));
    await tx.insert(githubUserConnections).values({ userId, connectionId, githubAccountId: account!.id, githubLogin: account!.login, appId: config.appId, authFlow: "device", ...token })
      .onConflictDoUpdate({ target: githubUserConnections.userId, set: { connectionId, githubAccountId: account!.id, githubLogin: account!.login, appId: config.appId, authFlow: "device", ...token, tokenRevision: 0, state: "connected", updatedAt: new Date() } });
    await tx.update(githubUserDeviceAttempts).set({ status: "connected", pollClaimToken: null, pollClaimExpiresAt: null }).where(eq(githubUserDeviceAttempts.attemptId, attemptId));
    return { status: "connected" as const, ...(attempt.returnReviewId ? { returnReviewId: attempt.returnReviewId } : {}) };
  });
  return result;
}

export async function disconnect({ userId }: { userId: string }): Promise<{ status: "disconnected" }> {
  const oldToken = await getDb().transaction(async (tx: DbTransaction) => {
    const authority = await lockAuthority(tx, userId);
    const [old] = await tx.select().from(githubUserConnections).where(eq(githubUserConnections.userId, userId));
    await tx.update(githubUserAuthorities).set({ generation: authority.generation + 1, updatedAt: new Date() }).where(eq(githubUserAuthorities.userId, userId));
    await tx.delete(githubUserConnections).where(eq(githubUserConnections.userId, userId));
    await tx.update(githubUserDeviceAttempts).set({ status: "cancelled", pollClaimToken: null, pollClaimExpiresAt: null }).where(and(eq(githubUserDeviceAttempts.userId, userId), eq(githubUserDeviceAttempts.status, "pending")));
    if (old?.authFlow !== "oauth") return null;
    try { return decryptWithAad(old.accessCiphertext, aad(userId, old.githubAccountId, old.appId, "access")); }
    catch { return null; }
  });
  if (oldToken) {
    try { await revokeToken(getGithubOAuthConfig(), oldToken); } catch { /* local authority is already revoked */ }
  }
  return { status: "disconnected" };
}

async function markReconnect(userId: string, connectionId: string): Promise<void> {
  await getDb().transaction(async (tx: DbTransaction) => {
    await lockAuthority(tx, userId);
    await tx.update(githubUserConnections).set({ state: "reconnect_required", updatedAt: new Date() })
      .where(and(eq(githubUserConnections.userId, userId), eq(githubUserConnections.connectionId, connectionId)));
  });
}

async function currentToken(userId: string): Promise<{ token: string; connectionId: string; generation: number; accountId: number }> {
  const [row] = await getDb().select().from(githubUserConnections).where(eq(githubUserConnections.userId, userId));
  if (row?.state !== "connected") throw new GithubUserError("RECONNECT_REQUIRED", "Connect GitHub again");
  if (row.accessExpiresAt.getTime() > Date.now() + 60_000) {
    const [authority] = await getDb().select().from(githubUserAuthorities).where(eq(githubUserAuthorities.userId, userId));
    if (!authority) throw new GithubUserError("RECONNECT_REQUIRED", "Connect GitHub again");
    return { token: decryptWithAad(row.accessCiphertext, aad(userId, row.githubAccountId, row.appId, "access")), connectionId: row.connectionId, generation: authority.generation, accountId: row.githubAccountId };
  }
  try {
    return await getDb().transaction(async (tx: DbTransaction) => {
      const authority = await lockAuthority(tx, userId);
      const [fresh] = await tx.select().from(githubUserConnections).where(eq(githubUserConnections.userId, userId));
      if (fresh?.state !== "connected") throw new GithubUserError("RECONNECT_REQUIRED", "Connect GitHub again");
      if (fresh.accessExpiresAt.getTime() > Date.now() + 60_000) return { token: decryptWithAad(fresh.accessCiphertext, aad(userId, fresh.githubAccountId, fresh.appId, "access")), connectionId: fresh.connectionId, generation: authority.generation, accountId: fresh.githubAccountId };
      if (fresh.refreshExpiresAt <= new Date()) throw new GithubUserError("RECONNECT_REQUIRED", "Connect GitHub again");
      const config = getGithubUserConfig();
      if (config.appId !== fresh.appId) throw new GithubUserError("RECONNECT_REQUIRED", "Connect GitHub again");
      const previous = decryptWithAad(fresh.refreshCiphertext, aad(userId, fresh.githubAccountId, fresh.appId, "refresh"));
      const pair = fresh.authFlow === "device" ? await refreshDevicePair(config, previous) : await refreshPair(getGithubOAuthConfig(), previous);
      const token = tokenCipher(pair, userId, fresh.githubAccountId, fresh.appId);
      await tx.update(githubUserConnections).set({ ...token, tokenRevision: fresh.tokenRevision + 1, updatedAt: new Date() })
        .where(and(eq(githubUserConnections.userId, userId), eq(githubUserConnections.connectionId, fresh.connectionId), eq(githubUserConnections.tokenRevision, fresh.tokenRevision)));
      return { token: pair.access_token, connectionId: fresh.connectionId, generation: authority.generation, accountId: fresh.githubAccountId };
    });
  } catch (error) {
    // DNS resolution failed before dispatch, so GitHub cannot have rotated the
    // refresh token. All failures after dispatch remain ambiguous and fail closed.
    if (!(error instanceof GithubUserError && error.code === "PROVIDER_NOT_SENT")) await markReconnect(userId, row.connectionId);
    throw error;
  }
}

export type RepositoryCheck = {
  status: "ready" | "repository_not_enabled" | "insufficient_user_permission" | "reconnect_required";
  repository?: { id: number; fullName: string };
  installUrl?: string;
  manageUrl?: string;
};

type InstalledRepository = { id: number; full_name: string; default_branch: string; private: boolean; permissions?: { pull?: boolean; push?: boolean } };
type InstalledEntry = { repository: InstalledRepository; installationId: number; appPermissions?: { contents?: string; pull_requests?: string } };

async function* installedRepositories(token: string, appId: number): AsyncGenerator<InstalledEntry> {
  let page = 1;
  while (page <= 10) {
    const installs = await githubApi<{ installations: Array<{ id: number; app_id: number; permissions?: { contents?: string; pull_requests?: string } }>; total_count: number }>(token, `/user/installations?per_page=100&page=${page}`);
    for (const install of installs.installations) {
      if (install.app_id !== appId) continue;
      for (let repoPage = 1; repoPage <= 10; repoPage++) {
        const listing = await githubApi<{ repositories: InstalledRepository[]; total_count: number }>(token, `/user/installations/${install.id}/repositories?per_page=100&page=${repoPage}`);
        for (const repository of listing.repositories) yield { repository, installationId: install.id, appPermissions: install.permissions };
        if (repoPage * 100 >= listing.total_count) break;
        if (repoPage === 10) throw new GithubUserError("PROVIDER_LIMIT", "Too many GitHub repositories to verify");
      }
    }
    if (page * 100 >= installs.total_count) break;
    if (page === 10) throw new GithubUserError("PROVIDER_LIMIT", "Too many GitHub installations to verify");
    page++;
  }
}

function repositoryAccess(item: InstalledEntry, permissions: { pull?: boolean; push?: boolean } | undefined, required: "read" | "write"): boolean {
  const canRead = (permissions?.pull === true || permissions?.push === true) && ["read", "write"].includes(item.appPermissions?.contents ?? "");
  const canWrite = canRead && permissions?.push === true && item.appPermissions?.contents === "write" && item.appPermissions?.pull_requests === "write";
  return required === "read" ? canRead : canWrite;
}

async function checkRepositoryWithToken(token: string, repositoryId: number, appId: number, required: "read" | "write" = "write"): Promise<RepositoryCheck> {
  for await (const item of installedRepositories(token, appId)) {
    if (item.repository.id !== repositoryId) continue;
    const detail = await githubApi<{ id: number; permissions?: { pull?: boolean; push?: boolean } }>(token, `/repos/${item.repository.full_name}`);
    if (detail.id !== repositoryId) throw new GithubUserError("REPOSITORY_MISMATCH", "GitHub repository changed");
    return {
      status: repositoryAccess(item, detail.permissions, required) ? "ready" : "insufficient_user_permission",
      repository: { id: item.repository.id, fullName: item.repository.full_name },
      manageUrl: `https://github.com/settings/installations/${item.installationId}`,
    };
  }
  return { status: "repository_not_enabled" };
}

export type AccessibleRepository = { id: number; fullName: string; defaultBranch: string; private: boolean; accessStatus: "ready" | "insufficient_user_permission" };
export async function listAccessibleRepositories({ userId }: { userId: string }): Promise<AccessibleRepository[]> {
  const config = getGithubUserConfig();
  const current = await currentToken(userId);
  const result: AccessibleRepository[] = [];
  for await (const item of installedRepositories(current.token, config.appId)) {
    if (result.length >= 100) throw new GithubUserError("PROVIDER_LIMIT", "Too many repositories to list");
    const detail = await githubApi<{ id: number; permissions?: { pull?: boolean; push?: boolean } }>(current.token, `/repos/${item.repository.full_name}`);
    if (detail.id !== item.repository.id) throw new GithubUserError("REPOSITORY_MISMATCH", "GitHub repository changed");
    result.push({ id: item.repository.id, fullName: item.repository.full_name, defaultBranch: item.repository.default_branch, private: item.repository.private, accessStatus: repositoryAccess(item, detail.permissions, "write") ? "ready" : "insufficient_user_permission" });
  }
  return result.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function checkRepository({ userId, repositoryId }: { userId: string; repositoryId: number }): Promise<RepositoryCheck> {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new GithubUserError("INVALID_REPOSITORY", "Invalid repository");
  const config = getGithubUserConfig();
  try {
    const current = await currentToken(userId);
    const result = await checkRepositoryWithToken(current.token, repositoryId, config.appId);
    if (result.status === "repository_not_enabled") return { ...result, installUrl: installationUrl(config.appSlug) };
    return result;
  } catch (error) {
    if (error instanceof GithubUserError && (error.code === "RECONNECT_REQUIRED" || error.code === "GITHUB_401")) return { status: "reconnect_required" };
    throw error;
  }
}

/** Host-only read path for an uncertain, already-dispatched operation. No new write claim. */
export async function withUserTokenReadOnly<T>(
  input: { userId: string; repositoryId: number; expectedGeneration: number },
  effect: (token: string) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0) throw new GithubUserError("INVALID_REPOSITORY", "Invalid repository");
  const current = await currentToken(input.userId);
  const repository = await checkRepositoryWithToken(current.token, input.repositoryId, getGithubUserConfig().appId, "read");
  if (repository.status !== "ready") throw new GithubUserError("REPOSITORY_ACCESS", "GitHub repository access is unavailable");
  await getDb().transaction(async (tx: DbTransaction) => {
    const authority = await lockAuthority(tx, input.userId);
    const [connection] = await tx.select().from(githubUserConnections).where(eq(githubUserConnections.userId, input.userId));
    if (authority.generation !== input.expectedGeneration || current.generation !== authority.generation || connection?.connectionId !== current.connectionId || connection.state !== "connected") throw new GithubUserError("STALE_CONNECTION", "GitHub connection changed");
  });
  return effect(current.token);
}

/** Each request in a multi-request publication needs a new dispatch decision. */
export async function assertUserEffectCurrent(input: { userId: string; operationId: string; repositoryId: number; expectedGeneration: number }): Promise<void> {
  await getDb().transaction(async (tx: DbTransaction) => {
    const authority = await lockAuthority(tx, input.userId);
    const [connection] = await tx.select().from(githubUserConnections).where(eq(githubUserConnections.userId, input.userId));
    const [claim] = await tx.select().from(githubUserEffectClaims).where(eq(githubUserEffectClaims.operationId, input.operationId));
    if (connection?.state !== "connected" || authority.generation !== input.expectedGeneration ||
      !claim || claim.userId !== input.userId || claim.repositoryId !== input.repositoryId || claim.kind !== "publish" ||
      claim.state !== "dispatched" || claim.generation !== authority.generation || claim.connectionId !== connection.connectionId) {
      throw new GithubUserError("STALE_CONNECTION", "GitHub connection or publication changed");
    }
  });
}

/** Claims an exact operation under the same durable row lock as disconnect. */
export async function withUserToken<T>(
  input: { userId: string; repositoryId: number; kind: "import" | "publish"; operationId: string; expectedGeneration?: number; authorizeDispatch?: (tx: DbTransaction) => Promise<void> },
  effect: (token: string) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0 || !input.operationId || input.operationId.length > 128) throw new GithubUserError("INVALID_OPERATION", "Invalid GitHub operation");
  if (input.kind === "publish" && (!input.authorizeDispatch || input.expectedGeneration === undefined)) throw new GithubUserError("INVALID_OPERATION", "Publication needs an approved proposal");
  const current = await currentToken(input.userId);
  const repository = await checkRepositoryWithToken(current.token, input.repositoryId, getGithubUserConfig().appId, input.kind === "import" ? "read" : "write");
  if (repository.status !== "ready") throw new GithubUserError("REPOSITORY_ACCESS", "GitHub repository access is unavailable");
  await getDb().transaction(async (tx: DbTransaction) => {
    const authority = await lockAuthority(tx, input.userId);
    const [connection] = await tx.select().from(githubUserConnections).where(eq(githubUserConnections.userId, input.userId));
    if (!connection || connection.connectionId !== current.connectionId || connection.state !== "connected" || authority.generation !== current.generation || (input.expectedGeneration !== undefined && authority.generation !== input.expectedGeneration)) throw new GithubUserError("STALE_CONNECTION", "GitHub connection changed");
    if (input.authorizeDispatch) await input.authorizeDispatch(tx);
    await tx.insert(githubUserEffectClaims).values({ operationId: input.operationId, userId: input.userId, connectionId: current.connectionId, generation: authority.generation, repositoryId: input.repositoryId, kind: input.kind, state: "dispatched" });
  });
  try {
    const result = await effect(current.token);
    await getDb().update(githubUserEffectClaims).set({ state: "completed", completedAt: new Date() }).where(eq(githubUserEffectClaims.operationId, input.operationId));
    return result;
  } catch (error) {
    await getDb().update(githubUserEffectClaims).set({ state: "unknown" }).where(eq(githubUserEffectClaims.operationId, input.operationId));
    throw error;
  }
}
