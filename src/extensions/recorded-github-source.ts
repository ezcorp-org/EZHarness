/**
 * A recorded GitHub API for extension source imports in the real-browser e2e harness.
 *
 * The real-auth suite imports the pinned commit below through the visible source form. Fetched live, a GitHub rate
 * limit or 403 turned the gate red with no product change (ci 40136530299 and 39594517781: "Source server returned
 * 403"). Under the harness's outbound boundary (isE2eProviderIsolationEnabled) the import keeps its whole real path
 * (route, authorization, collectGitHubSource, guardedFetch, staging, build) and only the transport answers from this
 * recording. Nothing here opens a connection.
 *
 * recorded-github-source.json holds the answers to the three requests collectGitHubSource makes, taken from the git
 * objects of that commit (the same object ids, modes, sizes and bytes api.github.com serves). Its tree lists only the
 * imported directory, the part collectGitHubSource reads. Any other request gets GitHub's 404 shape.
 */
import type { FetchLike, ResolveHost } from "../search/egress";
import recording from "./recorded-github-source.json";

type Recording = {
  repository: string;
  commits: Record<string, unknown>;
  trees: Record<string, unknown>;
  blobs: Record<string, string>;
};
const recorded: Recording = recording;

/** An address that passes the egress check. The recorded fetch below never connects to it. */
const RECORDED_ADDRESS = "140.82.112.6";

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const recordedGitHubSourceResolveHost: ResolveHost = async () => [RECORDED_ADDRESS];

export const recordedGitHubSourceFetch: FetchLike = async (url, init) => {
  const path = decodeURIComponent(new URL(url).pathname);
  const base = `/repos/${recorded.repository}/`;
  const host = new Headers(init.headers).get("host");
  const [kind, id] = host === "api.github.com" && path.startsWith(base) ? splitResource(path.slice(base.length)) : [];
  if (kind === "commits" && id && recorded.commits[id]) return answer(200, recorded.commits[id]);
  if (kind === "git/trees" && id && recorded.trees[id]) return answer(200, recorded.trees[id]);
  if (kind === "git/blobs" && id && recorded.blobs[id] !== undefined) return answer(200, { sha: id, encoding: "base64", content: recorded.blobs[id] });
  return answer(404, { message: "Not Found" });
};

function splitResource(resource: string): [string, string] | [] {
  const match = /^(commits|git\/trees|git\/blobs)\/([^/]+)$/.exec(resource);
  return match ? [match[1]!, match[2]!] : [];
}
