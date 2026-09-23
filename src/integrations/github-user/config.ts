import { GithubUserError } from "./transport";
import { getStableInstallationId } from "../../providers/encryption";

type CommonConfig = { instanceId: string; appId: number; appSlug: string; clientId: string };
export type GithubOAuthConfig = CommonConfig & { mode: "oauth"; clientSecret: string; callbackUrl: string };
export type GithubUserConfig = (CommonConfig & { mode: "device" }) | GithubOAuthConfig;

/** Public App identifiers are enough for the default, direct device flow. */
export function getGithubUserConfig(): GithubUserConfig {
  const appId = Number(process.env.EZ_GITHUB_APP_ID || "5049328");
  const instanceId = process.env.EZ_GITHUB_INSTANCE_ID || getStableInstallationId();
  const appSlug = process.env.EZ_GITHUB_APP_SLUG || "ezcorp-github-auth";
  const clientId = process.env.EZ_GITHUB_APP_CLIENT_ID || "Iv23linp84AzzvCGxstF";
  const mode = process.env.EZ_GITHUB_AUTH_MODE || "device";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(instanceId) || !Number.isSafeInteger(appId) || appId <= 0 || !/^[A-Za-z0-9-]+$/.test(appSlug) || !clientId || !["device", "oauth"].includes(mode)) throw new GithubUserError("NOT_CONFIGURED", "GitHub connection is not configured");
  const common = { instanceId, appId, appSlug, clientId };
  if (mode === "device") return { ...common, mode: "device" };
  const clientSecret = process.env.EZ_GITHUB_APP_CLIENT_SECRET ?? "";
  const callbackUrl = process.env.EZ_GITHUB_APP_CALLBACK_URL ?? "";
  if (!clientSecret) throw new GithubUserError("NOT_CONFIGURED", "GitHub OAuth connection is not configured");
  try {
    const parsed = new URL(callbackUrl);
    if (parsed.protocol !== "https:" || parsed.pathname !== "/api/github/callback" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("invalid");
    const publicOrigin = process.env.EZCORP_PUBLIC_URL ?? process.env.ORIGIN;
    if (publicOrigin && new URL(publicOrigin).origin !== parsed.origin) throw new Error("origin mismatch");
  } catch { throw new GithubUserError("NOT_CONFIGURED", "GitHub callback URL is invalid"); }
  return { ...common, mode: "oauth", clientSecret, callbackUrl };
}

export function getGithubOAuthConfig(): GithubOAuthConfig {
  const config = getGithubUserConfig();
  if (config.mode !== "oauth") throw new GithubUserError("OAUTH_DISABLED", "Legacy GitHub OAuth is disabled");
  return config;
}

export function isGithubUserConfigured(): boolean {
  try { getGithubUserConfig(); return true; } catch { return false; }
}
