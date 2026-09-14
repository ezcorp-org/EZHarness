import { ProjectGitHubHttpError, type requestProjectGitHub } from "../../extensions/project-github-transport";
import { factoryGitBlobId, factoryGitCommitId, factoryGitTreeId, type FactoryGitFile, type FactoryGitIdentity } from "../../factory/git-objects";

/**
 * A GitHub that stores exactly what it is told and answers with the identities those bytes have.
 *
 * It computes every SHA from the payload it received, using the same object hashing that
 * `git-objects.test.ts` measures against real git. That is what makes it a useful double: a
 * provider that sends the wrong tree gets back the SHA of the wrong tree, and the adapter's
 * identity check is exercised rather than bypassed.
 */

export interface FactoryGitHubFakeOptions {
  readonly repository: string;
  readonly repositoryId: number;
  readonly baseBranch: string;
  readonly baseFiles: readonly FactoryGitFile[];
  readonly identity: FactoryGitIdentity;
}

export interface FactoryGitHubCall { readonly method: string; readonly path: string; readonly body?: unknown }

interface StoredPull {
  number: number;
  node_id: string;
  html_url: string;
  draft: boolean;
  merged: boolean;
  state: string;
  body: string;
  title: string;
  head: { ref: string; sha: string };
  base: { ref: string; repo: { id: number } };
}

function isoFrom(date: unknown): number {
  const value = Date.parse(String(date));
  if (!Number.isSafeInteger(value)) throw new Error("the fake received an unparsable commit date");
  return Math.floor(value / 1000);
}

export class FactoryGitHubFake {
  readonly calls: FactoryGitHubCall[] = [];
  readonly blobs = new Map<string, Uint8Array>();
  readonly trees = new Map<string, readonly { path: string; mode: string; sha: string }[]>();
  readonly commits = new Map<string, { sha: string; tree: { sha: string }; parents: { sha: string }[]; message: string }>();
  readonly refs = new Map<string, string>();
  readonly pulls: StoredPull[] = [];
  readonly baseTreeSha: string;
  readonly baseCommitSha: string;
  /** Set to make the next matching call fail the way a dropped response looks. */
  failNext: { readonly method: string; readonly pathIncludes: string; readonly status?: number } | null = null;
  truncateBaseTree = false;
  private nextPull = 1;

  constructor(private readonly options: FactoryGitHubFakeOptions) {
    for (const file of options.baseFiles) this.blobs.set(factoryGitBlobId(file.content), file.content);
    this.baseTreeSha = factoryGitTreeId(options.baseFiles);
    this.trees.set(this.baseTreeSha, options.baseFiles.map(file => ({ path: file.path, mode: file.mode, sha: factoryGitBlobId(file.content) })));
    this.baseCommitSha = factoryGitCommitId({ treeId: this.baseTreeSha, parents: [], author: options.identity, committer: options.identity, message: "base\n" });
    this.commits.set(this.baseCommitSha, { sha: this.baseCommitSha, tree: { sha: this.baseTreeSha }, parents: [], message: "base\n" });
  }

  /** The transport seam the provider takes, with the same signature the real one has. */
  readonly request: typeof requestProjectGitHub = async input => {
    const method = input.method ?? "GET";
    this.calls.push({ method, path: input.path, ...(input.body === undefined ? {} : { body: input.body }) });
    if (this.failNext && this.failNext.method === method && input.path.includes(this.failNext.pathIncludes)) {
      const status = this.failNext.status ?? 500;
      this.failNext = null;
      throw new ProjectGitHubHttpError(status);
    }
    return this.route(method, input.path, input.body);
  };

  private route(method: string, path: string, body: unknown): unknown {
    const prefix = `/repos/${this.options.repository}`;
    if (!path.startsWith(prefix)) throw new ProjectGitHubHttpError(404);
    const rest = path.slice(prefix.length);
    if (method === "GET" && rest === "") return { id: this.options.repositoryId, full_name: this.options.repository, private: true, default_branch: this.options.baseBranch };
    if (method === "GET" && rest.startsWith("/git/commits/")) {
      const commit = this.commits.get(rest.slice("/git/commits/".length));
      if (!commit) throw new ProjectGitHubHttpError(404);
      return commit;
    }
    if (method === "GET" && rest.startsWith("/git/trees/")) {
      const sha = rest.slice("/git/trees/".length).split("?")[0]!;
      const tree = this.trees.get(sha);
      if (!tree) throw new ProjectGitHubHttpError(404);
      return { sha, truncated: this.truncateBaseTree, tree: tree.map(entry => ({ ...entry, type: "blob" })) };
    }
    if (method === "GET" && rest.startsWith("/git/ref/heads/")) {
      const branch = rest.slice("/git/ref/heads/".length).split("/").map(decodeURIComponent).join("/");
      const sha = this.refs.get(branch);
      if (!sha) throw new ProjectGitHubHttpError(404);
      return { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } };
    }
    if (method === "POST" && rest === "/git/blobs") {
      const request = body as { content: string; encoding: string };
      const content = new Uint8Array(Buffer.from(request.content, "base64"));
      const sha = factoryGitBlobId(content);
      this.blobs.set(sha, content);
      return { sha };
    }
    if (method === "POST" && rest === "/git/trees") {
      const entries = (body as { tree: { path: string; mode: string; sha: string }[] }).tree;
      const files: FactoryGitFile[] = entries.map(entry => {
        const content = this.blobs.get(entry.sha);
        if (!content) throw new ProjectGitHubHttpError(422);
        return { path: entry.path, mode: entry.mode as "100644", content };
      });
      const sha = factoryGitTreeId(files);
      this.trees.set(sha, entries);
      return { sha };
    }
    if (method === "POST" && rest === "/git/commits") {
      const request = body as { message: string; tree: string; parents: string[]; author: { name: string; email: string; date: string }; committer: { name: string; email: string; date: string } };
      const author = { name: request.author.name, email: request.author.email, atSeconds: isoFrom(request.author.date), timezone: "+0000" as const };
      const committer = { name: request.committer.name, email: request.committer.email, atSeconds: isoFrom(request.committer.date), timezone: "+0000" as const };
      const sha = factoryGitCommitId({ treeId: request.tree, parents: request.parents, author, committer, message: request.message });
      const commit = { sha, tree: { sha: request.tree }, parents: request.parents.map(parent => ({ sha: parent })), message: request.message };
      this.commits.set(sha, commit);
      return commit;
    }
    if (method === "POST" && rest === "/git/refs") {
      const request = body as { ref: string; sha: string };
      const branch = request.ref.replace(/^refs\/heads\//, "");
      if (this.refs.has(branch)) throw new ProjectGitHubHttpError(422);
      this.refs.set(branch, request.sha);
      return { ref: request.ref, object: { sha: request.sha, type: "commit" } };
    }
    if (method === "POST" && rest === "/pulls") {
      const request = body as { title: string; body: string; head: string; base: string; draft: boolean };
      const sha = this.refs.get(request.head);
      if (!sha) throw new ProjectGitHubHttpError(422);
      const pull: StoredPull = {
        number: this.nextPull++, node_id: `PR_node_${this.nextPull}`, html_url: `https://github.com/${this.options.repository}/pull/${this.nextPull - 1}`,
        draft: request.draft === true, merged: false, state: "open", body: request.body, title: request.title,
        head: { ref: request.head, sha }, base: { ref: request.base, repo: { id: this.options.repositoryId } },
      };
      this.pulls.push(pull);
      return pull;
    }
    if (method === "GET" && rest.startsWith("/pulls?")) {
      const query = new URLSearchParams(rest.slice("/pulls?".length));
      const head = (query.get("head") ?? "").split(":").slice(1).join(":");
      const base = query.get("base") ?? "";
      return this.pulls.filter(pull => pull.head.ref === head && pull.base.ref === base);
    }
    if (method === "GET" && /^\/pulls\/\d+$/.test(rest)) {
      const pull = this.pulls.find(item => item.number === Number(rest.slice("/pulls/".length)));
      if (!pull) throw new ProjectGitHubHttpError(404);
      return pull;
    }
    throw new ProjectGitHubHttpError(404);
  }
}
