import { createHash } from "node:crypto";
import type { ValidatedSnapshot } from "./snapshot";

export type GithubRequest = (token: string, path: string, method: "GET" | "POST", body?: unknown) => Promise<unknown>;
const SHA = /^[a-f0-9]{40}$/;
const NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export class PrPublisherError extends Error {
  constructor(public readonly code: "invalid_input" | "base_changed" | "provider_mismatch" | "remote_conflict" | "outcome_unknown", message: string) {
    super(message);
    this.name = "PrPublisherError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PrPublisherError("provider_mismatch", "GitHub returned an invalid object");
  return value as Record<string, unknown>;
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new PrPublisherError("provider_mismatch", "GitHub returned an invalid Git object ID");
  return value;
}
function repositoryPath(name: string): string {
  if (!NAME.test(name)) throw new PrPublisherError("invalid_input", "Invalid repository identity");
  return `/repos/${name.split("/").map(encodeURIComponent).join("/")}`;
}
function refPath(ref: string): string {
  if (!REF.test(ref) || ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".lock")) throw new PrPublisherError("invalid_input", "Invalid Git reference");
  return ref.split("/").map(encodeURIComponent).join("/");
}
function blobSha(bytes: Uint8Array): string { return createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex"); }

export interface FrozenPublishInput {
  token: string;
  repositoryId: number;
  repositoryName: string;
  baseRef: string;
  baseSha: string;
  branch: string;
  title: string;
  body: string;
  base: ValidatedSnapshot;
  current: ValidatedSnapshot;
  onCommitReady: (commitSha: string) => Promise<void>;
}

export interface PublishedPr { url: string; number: number; branch: string; commitSha: string }

async function exactBase(request: GithubRequest, token: string, repo: string, baseRef: string, baseSha: string): Promise<string> {
  const head = object(await request(token, `${repo}/git/ref/heads/${refPath(baseRef)}`, "GET"));
  const objectRef = object(head.object);
  if (sha(objectRef.sha) !== baseSha) throw new PrPublisherError("base_changed", "The base branch changed after review");
  const commit = object(await request(token, `${repo}/git/commits/${baseSha}`, "GET"));
  return sha(object(commit.tree).sha);
}

async function exactRepository(request: GithubRequest, token: string, repo: string, expectedId: number): Promise<void> {
  const detail = object(await request(token, repo, "GET"));
  if (detail.id !== expectedId) throw new PrPublisherError("provider_mismatch", "Selected repository identity changed");
}

/** One host publisher for an immutable tree and explicit host credential. */
export async function publishFrozenDraft(input: FrozenPublishInput, request: GithubRequest): Promise<PublishedPr> {
  const repo = repositoryPath(input.repositoryName);
  refPath(input.branch); refPath(input.baseRef);
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0 || !SHA.test(input.baseSha) || !input.title.trim() || input.title.length > 500 || input.body.length > 100_000) throw new PrPublisherError("invalid_input", "Invalid approved pull request");
  await exactRepository(request, input.token, repo, input.repositoryId);
  const baseTreeSha = await exactBase(request, input.token, repo, input.baseRef, input.baseSha);
  const old = new Map(input.base.files.map(file => [file.path, file]));
  const next = new Map(input.current.files.map(file => [file.path, file]));
  const paths = [...new Set([...old.keys(), ...next.keys()])].sort();
  const changes = paths.filter(path => old.get(path)?.sha256 !== next.get(path)?.sha256 || old.get(path)?.mode !== next.get(path)?.mode);
  if (!changes.length || changes.length > 100) throw new PrPublisherError("invalid_input", "No bounded changes to publish");
  if (changes.some(path => path.startsWith(".github/workflows/"))) throw new PrPublisherError("invalid_input", "Workflow file changes are unsupported in this version");
  const treeEntries: Array<{ path: string; mode: "100644" | "100755"; type: "blob"; sha: string | null }> = [];
  for (const path of changes) {
    const file = next.get(path);
    if (!file) { treeEntries.push({ path, mode: old.get(path)!.mode, type: "blob", sha: null }); continue; }
    const expected = blobSha(file.bytes);
    const blob = object(await request(input.token, `${repo}/git/blobs`, "POST", { content: Buffer.from(file.bytes).toString("base64"), encoding: "base64" }));
    if (sha(blob.sha) !== expected) throw new PrPublisherError("provider_mismatch", "GitHub blob differs from the frozen artifact");
    treeEntries.push({ path, mode: file.mode, type: "blob", sha: expected });
  }
  const tree = object(await request(input.token, `${repo}/git/trees`, "POST", { base_tree: baseTreeSha, tree: treeEntries }));
  const treeSha = sha(tree.sha);
  const commit = object(await request(input.token, `${repo}/git/commits`, "POST", { message: input.title, tree: treeSha, parents: [input.baseSha], author: { name: "EZHarness", email: "changes@ezcorp.invalid" } }));
  const commitSha = sha(commit.sha);
  await input.onCommitReady(commitSha);
  await exactBase(request, input.token, repo, input.baseRef, input.baseSha);
  await request(input.token, `${repo}/git/refs`, "POST", { ref: `refs/heads/${input.branch}`, sha: commitSha });
  await exactBase(request, input.token, repo, input.baseRef, input.baseSha);
  const pr = object(await request(input.token, `${repo}/pulls`, "POST", { title: input.title, body: input.body, base: input.baseRef, head: input.branch, draft: true }));
  const url = pr.html_url;
  if (typeof url !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/.test(url) || !Number.isSafeInteger(pr.number) || Number(pr.number) <= 0) throw new PrPublisherError("provider_mismatch", "GitHub returned an invalid pull request");
  const returnedHead = object(pr.head); const returnedBase = object(pr.base);
  if (returnedHead.sha !== commitSha || returnedHead.ref !== input.branch || returnedBase.ref !== input.baseRef || pr.draft !== true) throw new PrPublisherError("provider_mismatch", "GitHub pull request differs from the approved operation");
  return { url, number: Number(pr.number), branch: input.branch, commitSha };
}

/** Read-only reconciliation after an uncertain write. Never creates a ref or PR. */
export async function reconcileFrozenDraft(input: { token: string; repositoryId: number; repositoryName: string; baseRef: string; branch: string; commitSha: string }, request: GithubRequest): Promise<PublishedPr | null> {
  const repo = repositoryPath(input.repositoryName);
  refPath(input.branch); refPath(input.baseRef); sha(input.commitSha);
  await exactRepository(request, input.token, repo, input.repositoryId);
  const reference = object(await request(input.token, `${repo}/git/ref/heads/${refPath(input.branch)}`, "GET"));
  if (object(reference.object).sha !== input.commitSha) throw new PrPublisherError("remote_conflict", "Remote branch does not match the frozen commit");
  const [owner] = input.repositoryName.split("/");
  const prs = await request(input.token, `${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${input.branch}`)}&base=${encodeURIComponent(input.baseRef)}&per_page=100`, "GET");
  if (!Array.isArray(prs)) throw new PrPublisherError("provider_mismatch", "GitHub returned an invalid pull request list");
  const matches = prs.filter(value => { const pr = object(value); return object(pr.head).sha === input.commitSha && object(pr.head).ref === input.branch && object(pr.base).ref === input.baseRef; });
  if (matches.length > 1) throw new PrPublisherError("remote_conflict", "More than one matching pull request exists");
  if (!matches.length) return null;
  const pr = object(matches[0]);
  if (typeof pr.html_url !== "string" || !Number.isSafeInteger(pr.number) || pr.draft !== true) throw new PrPublisherError("remote_conflict", "Matching pull request has unexpected state");
  return { url: pr.html_url, number: Number(pr.number), branch: input.branch, commitSha: input.commitSha };
}
