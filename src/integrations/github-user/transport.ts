import { EgressBlockedError, guardedFetch } from "../../search/egress";

/** Narrow GitHub transport. Tokens never enter a URL or guest process. */
export class GithubUserError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

async function request(url: string, init: RequestInit, host: "github.com" | "api.github.com"): Promise<Response> {
  try {
    return await guardedFetch(url, init, {
      mode: "backend", allowedHosts: [host], maxRedirects: 0, maxBodyBytes: 1_000_000,
      timeoutMs: 15_000, retryConnectionFailures: false,
    });
  } catch (error) {
    // DNS resolution happens before guardedFetch can open a connection. The
    // caller may safely retry a single-use refresh token in this one case.
    if (error instanceof EgressBlockedError && error.reason === "no-address") {
      throw new GithubUserError("PROVIDER_NOT_SENT", "GitHub is unavailable");
    }
    // The network error might include request headers. Do not propagate it.
    throw new GithubUserError("PROVIDER_NETWORK", "GitHub is unavailable");
  }
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* guardedFetch already enforced the byte cap */ }
  throw new GithubUserError("PROVIDER_RESPONSE", "Invalid GitHub response");
}

async function boundedApiJson(response: Response): Promise<unknown> {
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === "object") return parsed;
  } catch { /* guardedFetch already enforced the byte cap */ }
  throw new GithubUserError("PROVIDER_RESPONSE", "Invalid GitHub response");
}

export async function githubApi<T>(token: string, path: string): Promise<T> {
  return githubApiRequest<T>(token, path, "GET");
}

export async function githubApiRequest<T>(token: string, path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new GithubUserError("INVALID_PATH", "Invalid GitHub API path");
  const payload = method === "POST" ? JSON.stringify(body ?? {}) : undefined;
  if (payload && Buffer.byteLength(payload) > 1_000_000) throw new GithubUserError("REQUEST_TOO_LARGE", "GitHub request is too large");
  const response = await request(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
      ...(payload ? { "content-type": "application/json" } : {}),
      "x-github-api-version": "2022-11-28", "user-agent": "EZHarness-GitHub-User",
    },
    body: payload,
  }, "api.github.com");
  if (!response.ok) throw new GithubUserError(`GITHUB_${response.status}`, `GitHub request failed (${response.status})`);
  return await boundedApiJson(response) as T;
}

export type GithubTokenPair = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
};

async function tokenRequest(config: { clientId: string; clientSecret?: string }, fields: Record<string, string>, failureCode: string): Promise<GithubTokenPair> {
  const response = await request("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, ...(config.clientSecret ? { client_secret: config.clientSecret } : {}), ...fields }),
  }, "github.com");
  const payload = await boundedJson(response);
  const valid = response.ok && typeof payload.access_token === "string" && payload.access_token.length > 0 &&
    typeof payload.refresh_token === "string" && payload.refresh_token.length > 0 &&
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) && payload.expires_in > 0 &&
    typeof payload.refresh_token_expires_in === "number" && Number.isFinite(payload.refresh_token_expires_in) && payload.refresh_token_expires_in > 0;
  if (!valid) throw new GithubUserError(failureCode, "GitHub connection needs authorization");
  return payload as GithubTokenPair;
}

export function exchangeCode(config: { clientId: string; clientSecret: string; callbackUrl: string }, code: string, verifier: string): Promise<GithubTokenPair> {
  return tokenRequest(config, { code, redirect_uri: config.callbackUrl, code_verifier: verifier }, "OAUTH_EXCHANGE");
}

export function refreshPair(config: { clientId: string; clientSecret: string }, refreshToken: string): Promise<GithubTokenPair> {
  return tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken }, "REFRESH_FAILED");
}

export function refreshDevicePair(config: { clientId: string }, refreshToken: string): Promise<GithubTokenPair> {
  return tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken }, "REFRESH_FAILED");
}

export type GithubDeviceCode = { deviceCode: string; userCode: string; verificationUri: "https://github.com/login/device"; expiresIn: number; interval: number };
export async function beginDeviceCode(config: { clientId: string }): Promise<GithubDeviceCode> {
  const response = await request("https://github.com/login/device/code", {
    method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId }),
  }, "github.com");
  const payload = await boundedJson(response);
  const expiresIn = payload.expires_in ?? 900;
  const interval = payload.interval ?? 5;
  if (!response.ok || typeof payload.device_code !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(payload.device_code) ||
    typeof payload.user_code !== "string" || !/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(payload.user_code) ||
    payload.verification_uri !== "https://github.com/login/device" ||
    typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn < 60 || expiresIn > 3600 ||
    typeof interval !== "number" || !Number.isSafeInteger(interval) || interval < 1 || interval > 60) throw new GithubUserError("DEVICE_START_FAILED", "GitHub device authorization is unavailable");
  return { deviceCode: payload.device_code, userCode: payload.user_code, verificationUri: payload.verification_uri, expiresIn, interval };
}

export type GithubDevicePoll = { status: "pending" | "slow_down"; interval?: number } | { status: "expired" | "denied" } | { status: "connected"; pair: GithubTokenPair };
export async function exchangeDeviceCode(config: { clientId: string }, deviceCode: string): Promise<GithubDevicePoll> {
  const response = await request("https://github.com/login/oauth/access_token", {
    method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
  }, "github.com");
  const payload = await boundedJson(response);
  if (payload.error === "authorization_pending") return { status: "pending" };
  if (payload.error === "slow_down") {
    const interval = typeof payload.interval === "number" && Number.isSafeInteger(payload.interval) && payload.interval <= 300 ? payload.interval : undefined;
    return { status: "slow_down", ...(interval ? { interval } : {}) };
  }
  if (["expired_token", "token_expired", "bad_verification_code"].includes(String(payload.error))) return { status: "expired" };
  if (payload.error === "access_denied") return { status: "denied" };
  if (payload.error) throw new GithubUserError("DEVICE_EXCHANGE_FAILED", "GitHub device authorization is unavailable");
  const valid = response.ok && typeof payload.access_token === "string" && payload.access_token.length > 0 &&
    typeof payload.refresh_token === "string" && payload.refresh_token.length > 0 &&
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) && payload.expires_in > 0 &&
    typeof payload.refresh_token_expires_in === "number" && Number.isFinite(payload.refresh_token_expires_in) && payload.refresh_token_expires_in > 0;
  if (!valid) throw new GithubUserError("DEVICE_EXCHANGE_FAILED", "GitHub device authorization is unavailable");
  return { status: "connected", pair: payload as GithubTokenPair };
}

/** Best-effort provider revocation after local authority has already been fenced. */
export async function revokeToken(config: { clientId: string; clientSecret: string }, token: string): Promise<void> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  await request(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`, {
    method: "DELETE",
    headers: { authorization: `Basic ${basic}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" },
    body: JSON.stringify({ access_token: token }),
  }, "api.github.com");
}
