import { guardedFetch } from "../search/egress";
import { getSecret } from "./secrets-store";
import { LifecycleError } from "./v4/types";

export class ProjectGitHubHttpError extends LifecycleError {
  constructor(readonly status: number) { super("github_failed", `GitHub returned HTTP ${status}.`); }
}

export interface ProjectGitHubRequest {
  readonly projectId: string;
  readonly path: string;
  readonly method?: "GET" | "POST" | "PATCH" | "PUT";
  readonly body?: unknown;
  /** Rechecks the caller's exact recorded project action before network access. */
  readonly authorize: () => Promise<unknown>;
  readonly signal?: AbortSignal;
}

/** Shared host-only transport for approved project and factory publication actions. */
export async function requestProjectGitHub(input: ProjectGitHubRequest): Promise<unknown> {
  const { projectId, path, method = "GET", signal } = input;
  const authorize = input.authorize;
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("#") || path.includes("\\") || /\p{Cc}/u.test(path)) throw new LifecycleError("github_path_invalid", "GitHub requests require a relative API path.");
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  await authorize();
  const token = await getSecret("github-projects", projectId, "apiToken");
  if (!token) throw new LifecycleError("credential_required", "Configure the host-owned GitHub credential for this project.");
  const response = await guardedFetch(`https://api.github.com${path}`, {
    method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" },
    ...(body === undefined ? {} : { body }), ...(signal ? { signal } : {}),
  }, { mode: "backend", allowedHosts: ["api.github.com"], maxRedirects: 0, maxBodyBytes: 2 * 1024 * 1024, timeoutMs: 15_000, retryConnectionFailures: false, authorizeUrl: async () => { await authorize(); } });
  if (!response.ok) throw new ProjectGitHubHttpError(response.status);
  const value = await response.json();
  if (value && typeof value === "object" && "errors" in value) throw new LifecycleError("github_failed", "GitHub rejected the requested operation.");
  return value;
}
