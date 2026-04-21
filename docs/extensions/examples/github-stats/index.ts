#!/usr/bin/env bun
// github-stats - Fetch GitHub repo and user data via the GitHub API.
// Migrated onto @ezcorp/sdk/runtime (rpc + http/fetchPermitted wrappers) in Phase 2.3.

import {
  createToolDispatcher,
  fetchPermitted,
  getChannel,
  toolResult,
  toolError,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

// GitHub API helper — uses fetchPermitted so the host-granted network
// allowlist (`permissions.network: ["api.github.com"]` in ezcorp.config.ts)
// is enforced at call time. fetchPermitted throws when the hostname is
// not present in `EZCORP_PERMITTED_HOSTS`.
async function githubFetch(path: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers: Record<string, string> = { "User-Agent": "github-stats-ext" };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetchPermitted(`https://api.github.com${path}`, { headers });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// Tool handlers — each returns a ToolCallResult; host-side dispatcher
// serializes into the JSON-RPC envelope.

const repoStats: ToolHandler = async (args) => {
  const { owner, repo } = args as { owner: string; repo: string };
  const { ok, status, data } = await githubFetch(`/repos/${owner}/${repo}`);
  if (!ok) {
    if (status === 404) return toolError(`Repository ${owner}/${repo} not found`);
    if (status === 403) return toolError("GitHub API rate limit exceeded");
    return toolError(`GitHub API error: ${status}`);
  }
  const d = data as Record<string, unknown>;
  return toolResult(JSON.stringify({
    name: d.full_name, stars: d.stargazers_count, forks: d.forks_count,
    openIssues: d.open_issues_count, language: d.language, description: d.description,
  }));
};

const userProfile: ToolHandler = async (args) => {
  const { username } = args as { username: string };
  const { ok, status, data } = await githubFetch(`/users/${username}`);
  if (!ok) {
    if (status === 404) return toolError(`User ${username} not found`);
    if (status === 403) return toolError("GitHub API rate limit exceeded");
    return toolError(`GitHub API error: ${status}`);
  }
  const d = data as Record<string, unknown>;
  return toolResult(JSON.stringify({
    login: d.login, name: d.name, bio: d.bio,
    publicRepos: d.public_repos, followers: d.followers, following: d.following,
  }));
};

const repoLanguages: ToolHandler = async (args) => {
  const { owner, repo } = args as { owner: string; repo: string };
  const { ok, status, data } = await githubFetch(`/repos/${owner}/${repo}/languages`);
  if (!ok) {
    if (status === 404) return toolError(`Repository ${owner}/${repo} not found`);
    if (status === 403) return toolError("GitHub API rate limit exceeded");
    return toolError(`GitHub API error: ${status}`);
  }
  return toolResult(JSON.stringify(data));
};

const tools: Record<string, ToolHandler> = {
  "repo-stats": repoStats,
  "user-profile": userProfile,
  "repo-languages": repoLanguages,
};

// --- Production wiring ---
//
// Gated on `import.meta.main` so test imports don't open stdin. Order is
// load-bearing: `getChannel()` arms the dispatcher registration before
// `createToolDispatcher(tools)` supplies the handlers; `ch.start()` then
// kicks off the stdin read loop.

if (import.meta.main) {
  const ch = getChannel();
  createToolDispatcher(tools);
  ch.start();
}
