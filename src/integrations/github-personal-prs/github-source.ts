import { createHash } from "node:crypto";
import { validateSnapshot, type SnapshotFileInput, type ValidatedSnapshot } from "./snapshot";

export class GithubSourceError extends Error {
  constructor(public readonly code: "invalid_repository" | "invalid_base" | "unsupported_repository" | "provider_unavailable", message: string) {
    super(message);
    this.name = "GithubSourceError";
  }
}

export interface ApprovedBase { repositoryId: number; fullName: string; baseRef: string; baseSha: string; snapshot: ValidatedSnapshot }
export type GithubJsonTransport = (path: string, token: string) => Promise<unknown>;

const SHA = /^[a-f0-9]{40}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GithubSourceError("provider_unavailable", "GitHub returned an invalid repository object");
  return value as Record<string, unknown>;
}

function repositoryPath(input: { repositoryId: number; fullName: string; baseRef: string }): string {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0 || !NAME.test(input.fullName)) throw new GithubSourceError("invalid_repository", "Invalid repository selection");
  if (!REF.test(input.baseRef) || input.baseRef.includes("..") || input.baseRef.includes("//") || input.baseRef.endsWith("/") || input.baseRef.endsWith(".lock")) throw new GithubSourceError("invalid_base", "Invalid base branch");
  return input.fullName.split("/").map(encodeURIComponent).join("/");
}

async function approvedTree(input: { repositoryId: number; baseRef: string; token: string }, repo: string, transport: GithubJsonTransport): Promise<{ baseSha: string; entries: unknown[] }> {
  const detail = record(await transport(`/repos/${repo}`, input.token));
  if (detail.id !== input.repositoryId) throw new GithubSourceError("invalid_repository", "Selected repository identity changed");
  const ref = record(await transport(`/repos/${repo}/git/ref/heads/${input.baseRef.split("/").map(encodeURIComponent).join("/")}`, input.token));
  const base = record(ref.object);
  if (base.type !== "commit" || typeof base.sha !== "string" || !SHA.test(base.sha)) throw new GithubSourceError("invalid_base", "Base branch does not resolve to a commit");
  const commit = record(await transport(`/repos/${repo}/git/commits/${base.sha}`, input.token));
  const treeObject = record(commit.tree);
  if (typeof treeObject.sha !== "string" || !SHA.test(treeObject.sha)) throw new GithubSourceError("provider_unavailable", "GitHub commit has no tree");
  const tree = record(await transport(`/repos/${repo}/git/trees/${treeObject.sha}?recursive=1`, input.token));
  if (tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length === 0 || tree.tree.length > 2_000) throw new GithubSourceError("unsupported_repository", "Repository tree is empty or exceeds import limits");
  return { baseSha: base.sha, entries: tree.tree };
}

function supportedBlob(raw: unknown): { path: string; mode: "100644" | "100755"; sha: string; size: number } | null {
  const item = record(raw);
  if (item.type === "tree" && item.mode === "040000") return null;
  if (item.type !== "blob" || (item.mode !== "100644" && item.mode !== "100755") || typeof item.path !== "string" || typeof item.sha !== "string" || !SHA.test(item.sha) || typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size > 256 * 1024 || item.size < 0) throw new GithubSourceError("unsupported_repository", "Repository contains unsupported content");
  return item as { path: string; mode: "100644" | "100755"; sha: string; size: number };
}

async function verifiedBlob(repo: string, token: string, item: { path: string; mode: "100644" | "100755"; sha: string; size: number }, transport: GithubJsonTransport): Promise<SnapshotFileInput> {
  const blob = record(await transport(`/repos/${repo}/git/blobs/${item.sha}`, token));
  if (blob.encoding !== "base64" || typeof blob.content !== "string" || blob.size !== item.size) throw new GithubSourceError("provider_unavailable", "GitHub blob does not match the tree");
  const bytes = Buffer.from(blob.content.replace(/\n/g, ""), "base64");
  if (bytes.length !== item.size || createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex") !== item.sha) throw new GithubSourceError("provider_unavailable", "GitHub blob hash does not match the tree");
  return { path: item.path, mode: item.mode, data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Fetch a pinned Git tree on the host. The returned bytes have no Git credential or remote. */
export async function fetchApprovedBase(input: { repositoryId: number; fullName: string; baseRef: string; token: string }, transport: GithubJsonTransport): Promise<ApprovedBase> {
  const repo = repositoryPath(input);
  const tree = await approvedTree(input, repo, transport);
  const entries: SnapshotFileInput[] = [];
  let total = 0;
  for (const raw of tree.entries) {
    const item = supportedBlob(raw);
    if (!item) continue;
    total += item.size;
    if (total > 32 * 1024 * 1024) throw new GithubSourceError("unsupported_repository", "Repository exceeds import size limit");
    entries.push(await verifiedBlob(repo, input.token, item, transport));
  }
  try { return { repositoryId: input.repositoryId, fullName: input.fullName, baseRef: input.baseRef, baseSha: tree.baseSha, snapshot: validateSnapshot(entries) }; }
  catch { throw new GithubSourceError("unsupported_repository", "Repository contains unsafe paths or content"); }
}
