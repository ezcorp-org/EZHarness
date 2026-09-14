import { guardedFetch } from "../search/egress";
import { getSecret } from "./secrets-store";
import { LifecycleError } from "./v4/types";

export class ProjectGitHubHttpError extends LifecycleError {
  constructor(readonly status: number) { super("github_failed", `GitHub returned HTTP ${status}.`); }
}

export interface ProjectGitHubRequest {
  readonly projectId: string;
  readonly path: string;
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly body?: unknown;
  /** Rechecks the caller's exact recorded project action before network access. */
  readonly authorize: () => Promise<unknown>;
  readonly signal?: AbortSignal;
  /**
   * Where the token comes from, for a caller that is not the project secret store.
   *
   * The trusted release broker holds its credential in private service configuration rather than
   * in `github-projects`, and it is the only caller that supplies this. The value never leaves
   * this function: it is read, put in one header, and dropped.
   */
  readonly readToken?: () => Promise<string | null>;
  /** A publication materializes a whole tree, which does not fit the project path's budgets. */
  readonly maxBodyBytes?: number;
  readonly timeoutMs?: number;
}

/** Shared host-only transport for approved project and factory publication actions. */
export async function requestProjectGitHub(input: ProjectGitHubRequest): Promise<unknown> {
  const { projectId, path, method = "GET", signal } = input;
  const authorize = input.authorize;
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("#") || path.includes("\\") || /\p{Cc}/u.test(path)) throw new LifecycleError("github_path_invalid", "GitHub requests require a relative API path.");
  const maxBodyBytes = input.maxBodyBytes ?? 2 * 1024 * 1024;
  const timeoutMs = input.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 64 * 1024 * 1024 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new LifecycleError("github_path_invalid", "GitHub request bounds are outside the permitted range.");
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  await authorize();
  const token = input.readToken ? await input.readToken() : await getSecret("github-projects", projectId, "apiToken");
  if (!token) throw new LifecycleError("credential_required", "Configure the host-owned GitHub credential for this project.");
  const response = await guardedFetch(`https://api.github.com${path}`, {
    method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" },
    ...(body === undefined ? {} : { body }), ...(signal ? { signal } : {}),
  }, { mode: "backend", allowedHosts: ["api.github.com"], maxRedirects: 0, maxBodyBytes, timeoutMs, retryConnectionFailures: false, authorizeUrl: async () => { await authorize(); } });
  if (!response.ok) throw new ProjectGitHubHttpError(response.status);
  if (response.status === 204) return null;
  const value = await response.json();
  if (value && typeof value === "object" && "errors" in value) throw new LifecycleError("github_failed", "GitHub rejected the requested operation.");
  return value;
}
