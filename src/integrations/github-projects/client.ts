/**
 * Host GitHub Projects v2 client.  ──  OWNED BY AGENT A.
 *
 * Phase 0 STUB: signatures are frozen by `./types` (GithubClient). Agent A
 * replaces the body with real GraphQL/REST calls. Every request MUST pin its
 * origin to GITHUB_API_ORIGIN (https://api.github.com) and throw
 * GithubHostNotAllowedError otherwise (SSRF guard). Auth tokens are host-only
 * and must never be logged.
 *
 * Other agents only IMPORT `createGithubClient` (and mock it in their tests);
 * they never edit this file.
 */
import type { GithubClient } from "./types";

export function createGithubClient(): GithubClient {
  throw new Error(
    "github-projects: createGithubClient() not implemented yet (Agent A owns client.ts)",
  );
}
