import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import { realpath, lstat } from "node:fs/promises";
import { snapshotExtensionSource, snapshotFirstPartyExtension } from "../../scripts/migrate-extension-v4";
import { canonicalJson, encodeWorkspaceFile, isWorkspaceTextPath, workspaceFileBytes, workspaceText, validatePublishedRelease, validateWorkspaceFiles, type WorkspaceFiles } from "@ezcorp/extension-contract";
import { getVersionById } from "../db/queries/marketplace-versions";
import { getListingById } from "../db/queries/marketplace";
import { getExtensionLifecycle } from "./extension-lifecycle-service";
import { getUserById } from "../db/queries/users";
import { listProjects } from "../db/queries/projects";
import { allowedInstallRoots } from "./install-roots";
import { getProjectRoot } from "./project-root";
import { LifecycleError, type LifecycleActor } from "./v4/types";
import { guardedFetch, type ResolveHost } from "../search/egress";

export type ExtensionSourceInput =
  | { kind: "marketplace"; versionId: string }
  | { kind: "bundled"; name: string }
  | { kind: "local"; path: string }
  | { kind: "github"; repository: string; ref?: string; directory?: string; projectId?: string };

const EXCLUDED = new Set(["node_modules", ".git", ".ezcorp", "dist", "coverage", "test-results", "playwright-report"]);
type GitHubSourceCredentialResolver = (actor: LifecycleActor, repository: string, projectId?: string) => Promise<string | null>;
let sourceCredentialResolver: GitHubSourceCredentialResolver = resolveProjectSourceCredential;

export async function resolveProjectSourceCredential(actor: LifecycleActor, repository: string, projectId?: string): Promise<string | null> {
  if (projectId === undefined) return null;
  if (typeof projectId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) throw new LifecycleError("invalid_source", "Select a valid project for private source access.");
  await requireSourceAdministrator(actor);
  const { getProject } = await import("../db/queries/projects");
  const { checkProjectRole } = await import("../auth/middleware");
  const { readProjectGit } = await import("./project-git-broker");
  const { getSecret } = await import("./secrets-store");
  const user = await getUserById(actor.principalId);
  const project = await getProject(projectId);
  if (!user || !project?.path || await checkProjectRole({ user }, projectId, "member") instanceof Response) throw new LifecycleError("forbidden", "Current project membership is required for private source access.");
  const origin = await readProjectGit(project.path, "origin");
  if (origin !== `https://github.com/${repository}`) throw new LifecycleError("source_mismatch", "The selected project must have this exact GitHub repository as its origin.");
  const token = await getSecret("github-projects", projectId, "apiToken");
  if (!token) throw new LifecycleError("credential_required", "Configure the host-owned GitHub credential for the selected project.");
  return token;
}

export function configureGitHubSourceCredentials(resolver: GitHubSourceCredentialResolver): void { sourceCredentialResolver = resolver; }

export async function collectMarketplaceSource(versionId: string): Promise<WorkspaceFiles> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(versionId)) throw new LifecycleError("invalid_source", "Invalid marketplace version identifier");
  const version = await getVersionById(versionId);
  if (!version?.release) throw new LifecycleError("migration_required", "Marketplace version has no verified v4 source release");
  if (!await getListingById(version.listingId)) throw new LifecycleError("source_unavailable", "Marketplace listing is no longer available");
  const release = await validatePublishedRelease(version.release);
  if (canonicalJson(version.manifest) !== canonicalJson(release.build.manifest) || version.version !== release.build.manifest?.version) throw new LifecycleError("source_mismatch", "Marketplace metadata does not match the immutable release");
  return structuredClone(release.sourceFiles);
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new LifecycleError("source_fetch_failed", `Source server returned ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new LifecycleError("source_limit", "Source response exceeded its size limit"); }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { reader.releaseLock(); }
}

export async function collectGitHubSource(input: Extract<ExtensionSourceInput, { kind: "github" }>, options: { token?: string; resolveCredential?: () => Promise<string | null>; fetch?: typeof fetch; resolveHost?: ResolveHost; signal?: AbortSignal } = {}): Promise<WorkspaceFiles> {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(input.repository) || input.repository.split("/").some(part => part === "." || part === "..")) throw new LifecycleError("invalid_source", "Use an owner/repository GitHub identifier");
  const ref = input.ref ?? "HEAD";
  if (!ref || ref.length > 200 || ref.split("/").some(part => part === "." || part === "..") || [...ref].some((character) => character.charCodeAt(0) <= 32)) throw new LifecycleError("invalid_ref", "Use a bounded Git branch, tag, or commit");
  const prefix = input.directory ? `${input.directory.replace(/\/$/, "")}/` : "";
  if (prefix.startsWith("/") || prefix.split("/").some((part) => part === ".." || part === ".") || prefix.includes("\\")) throw new LifecycleError("invalid_source", "Use a relative source directory without traversal");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000);
  async function request(path: string, limit: number): Promise<unknown> {
    const token = options.resolveCredential ? await options.resolveCredential() : options.token;
    const response = await guardedFetch(`https://api.github.com/repos/${input.repository}/${path}`, { redirect: "error", signal, headers: { accept: "application/vnd.github+json", "user-agent": "ezcorp-extension-import", ...(token ? { authorization: `Bearer ${token}` } : {}) } }, { mode: "read", maxRedirects: 0, maxBodyBytes: limit, timeoutMs: 30_000, retryConnectionFailures: false, fetchImpl: options.fetch, resolveHost: options.resolveHost });
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(response, limit)));
  }
  const commit = await request(`commits/${encodeURIComponent(ref)}`, 1024 * 1024) as { commit?: { tree?: { sha?: unknown } } };
  const treeId = commit.commit?.tree?.sha;
  if (typeof treeId !== "string" || !/^[a-f0-9]{40,64}$/.test(treeId)) throw new LifecycleError("invalid_source", "Source server did not return an immutable Git tree");
  const tree = await request(`git/trees/${treeId}?recursive=1`, 8 * 1024 * 1024) as { truncated?: unknown; tree?: unknown };
  if (tree.truncated || !Array.isArray(tree.tree)) throw new LifecycleError("source_limit", "Source tree is incomplete or exceeds its size limit");
  const files: WorkspaceFiles = Object.create(null);
  let total = 0;
  for (const raw of tree.tree) {
    if (!raw || typeof raw !== "object") throw new LifecycleError("invalid_source", "Invalid source tree entry");
    const entry = raw as Record<string, unknown>;
    if (typeof entry.path !== "string" || !entry.path.startsWith(prefix)) continue;
    const path = entry.path.slice(prefix.length);
    if (!path || path.split("/").some((part) => EXCLUDED.has(part) || part === ".env" || part.startsWith(".env."))) continue;
    if (entry.type === "tree") continue;
    if (entry.type !== "blob" || !["100644", "100755"].includes(String(entry.mode))) throw new LifecycleError("invalid_source", "Source links and submodules are not allowed");
    if (typeof entry.sha !== "string" || !/^[a-f0-9]{40,64}$/.test(entry.sha) || typeof entry.size !== "number" || entry.size > 4 * 1024 * 1024 || Object.keys(files).length >= 4096) throw new LifecycleError("source_limit", "Invalid or oversized source blob");
    const blob = await request(`git/blobs/${entry.sha}`, 6 * 1024 * 1024) as { encoding?: unknown; content?: unknown };
    if (blob.encoding !== "base64" || typeof blob.content !== "string" || !/^[A-Za-z0-9+/=\r\n]*$/.test(blob.content)) throw new LifecycleError("invalid_source", "Source blob encoding is invalid");
    const bytes = workspaceFileBytes({ encoding: "base64", data: blob.content.replace(/[\r\n]/g, ""), executable: entry.mode === "100755" });
    total += bytes.byteLength;
    if (bytes.byteLength > 4 * 1024 * 1024 || total > 64 * 1024 * 1024) throw new LifecycleError("source_limit", "Source size limit exceeded");
    files[path] = encodeWorkspaceFile(bytes, !isWorkspaceTextPath(path) && entry.mode === "100755");
  }
  validateWorkspaceFiles(files);
  if (!files["extension.ts"]) throw new LifecycleError("migration_required", "Source needs a v4 extension.ts entrypoint before it can be built");
  workspaceText(files["extension.ts"], "extension.ts");
  return files;
}

async function requireSourceAdministrator(actor: LifecycleActor): Promise<void> {
  const user = await getUserById(actor.principalId);
  if (user?.status !== "active") throw new LifecycleError("forbidden", "An active user is required");
  if (user.role !== "admin" || actor.kind !== "human") throw new LifecycleError("forbidden", "A human administrator must import source");
}

export async function importExtensionSource(actor: LifecycleActor, input: ExtensionSourceInput) {
  await requireSourceAdministrator(actor);
  let files: WorkspaceFiles;
  if (input.kind === "marketplace") files = await collectMarketplaceSource(input.versionId);
  else if (input.kind === "github") files = await collectGitHubSource(input, { resolveCredential: () => sourceCredentialResolver(actor, input.repository, input.projectId) });
  else {
    if (input.kind === "bundled") files = (await snapshotFirstPartyExtension(getProjectRoot(), input.name)).files;
    else {
      if (!isAbsolute(input.path) || !(await lstat(input.path)).isDirectory()) throw new LifecycleError("invalid_source", "Use a regular source directory in an allowed installation root");
      const source = await realpath(input.path);
      const roots = await Promise.all(allowedInstallRoots((await listProjects()).map((project) => project.path)).map((root) => realpath(root).catch(() => null)));
      if (!roots.some((root) => root && source.startsWith(root + sep) && !relative(root, source).startsWith(".."))) throw new LifecycleError("forbidden", "Local source is outside the allowed installation roots");
      files = (await snapshotExtensionSource(dirname(source), { name: basename(source), directory: basename(source), entrypoint: "extension.ts" })).files;
    }
  }
  const provenance: ExtensionSourceInput | { kind: "local"; name: string } = input.kind === "local" ? { kind: "local", name: basename(input.path) } : input;
  return stageExtensionSourceFiles(actor, files, provenance);
}

export async function stageExtensionSourceFiles(actor: LifecycleActor, sourceFiles: WorkspaceFiles, provenance: ExtensionSourceInput | { kind: "local" | "skill"; name: string }) {
  await requireSourceAdministrator(actor);
  const files = { ...validateWorkspaceFiles(sourceFiles), "extension-source.json": JSON.stringify({ schemaVersion: 4, source: provenance }, null, 2) };
  const lifecycle = await getExtensionLifecycle();
  const result = await lifecycle.createWorkspace(actor, { files });
  const operation = await lifecycle.build(actor, { installationId: result.installation.id, workspaceId: result.workspace.id, expectedRevision: result.workspace.revision, idempotencyKey: `source-import:${result.workspace.sourceDigest}` });
  void lifecycle.runBuild(actor, result.installation.id, operation.id).catch(() => undefined);
  return { ...result, operation, source: provenance, openUrl: `/extensions/author?installation=${encodeURIComponent(result.installation.id)}&workspace=${encodeURIComponent(result.workspace.id)}` };
}
