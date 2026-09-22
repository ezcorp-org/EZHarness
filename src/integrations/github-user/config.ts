import { GithubUserError } from "./transport";

export type GithubUserConfig = { instanceId: string; appId: number; appSlug: string; clientId: string; clientSecret: string; callbackUrl: string };

/** A distinct self-hosted deployment registers its own GitHub App callback. */
export function getGithubUserConfig(): GithubUserConfig {
  const appId = Number(process.env.EZ_GITHUB_APP_ID);
  const instanceId = process.env.EZ_GITHUB_INSTANCE_ID ?? "";
  const appSlug = process.env.EZ_GITHUB_APP_SLUG ?? "";
  const clientId = process.env.EZ_GITHUB_APP_CLIENT_ID ?? "";
  const clientSecret = process.env.EZ_GITHUB_APP_CLIENT_SECRET ?? "";
  const callbackUrl = process.env.EZ_GITHUB_APP_CALLBACK_URL ?? "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(instanceId) || !Number.isSafeInteger(appId) || appId <= 0 || !/^[A-Za-z0-9-]+$/.test(appSlug) || !clientId || !clientSecret) throw new GithubUserError("NOT_CONFIGURED", "GitHub connection is not configured");
  try {
    const parsed = new URL(callbackUrl);
    if (parsed.protocol !== "https:" || parsed.pathname !== "/api/github/callback" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("invalid");
    const publicOrigin = process.env.EZCORP_PUBLIC_URL ?? process.env.ORIGIN;
    if (publicOrigin && new URL(publicOrigin).origin !== parsed.origin) throw new Error("origin mismatch");
  } catch { throw new GithubUserError("NOT_CONFIGURED", "GitHub callback URL is invalid"); }
  return { instanceId, appId, appSlug, clientId, clientSecret, callbackUrl };
}

export function isGithubUserConfigured(): boolean {
  try { getGithubUserConfig(); return true; } catch { return false; }
}
