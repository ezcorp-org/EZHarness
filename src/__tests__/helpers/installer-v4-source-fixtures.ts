import { mock } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestObject } from "../../extensions/v4/blobs";
import type { LifecycleActor } from "../../extensions/v4";
import * as egress from "../../search/egress";
import type { GuardedFetchOptions } from "../../search/egress";

const originalEgress = { ...egress };
const guardedSourceFetch = egress.guardedFetch;

export const sourceActor: LifecycleActor = {
  principalId: "admin",
  scope: "global",
  kind: "human",
};

let root = "";
let user: { id: string; role: string; status: string } | undefined;
const workspace = mock(async (
  actor: LifecycleActor,
  input: { files: Record<string, string> },
) => ({
  installation: {
    id: "installation",
    ownerId: actor.principalId,
    enabled: false,
    activeReleaseId: null,
  },
  workspace: { id: "workspace", revision: 1, sourceDigest: digestObject(input.files) },
}));
const build = mock(async (
  _actor: LifecycleActor,
  input: { idempotencyKey: string },
) => ({ id: `operation:${input.idempotencyKey}`, state: "queued" as const }));
const runBuild = mock(async () => {});

mock.module("../../search/egress", () => ({
  ...originalEgress,
  guardedFetch: (url: string, init: RequestInit, options: GuardedFetchOptions) =>
    guardedSourceFetch(url, init, {
      ...options,
      resolveHost: options.resolveHost ?? (async () => ["93.184.216.34"]),
    }),
}));
mock.module("../../db/queries/users", () => ({ getUserById: async () => user }));
mock.module("../../db/queries/projects", () => ({
  listProjects: async () => [{ path: join(root, "project") }],
}));
mock.module("../../extensions/project-root", () => ({ getProjectRoot: () => root }));
mock.module("../../extensions/extension-lifecycle-service", () => ({
  getExtensionLifecycle: async () => ({ createWorkspace: workspace, build, runBuild }),
}));

export function resetInstallerV4SourceFixture(): void {
  user = { id: "admin", role: "admin", status: "active" };
  workspace.mockClear();
  build.mockClear();
  runBuild.mockClear();
  runBuild.mockImplementation(async () => {});
}

export function setSourceUser(value: typeof user): void {
  user = value;
}

export function stagingCalls() {
  return { workspace, build, runBuild };
}

export async function createInstallerV4SourceTree(): Promise<{
  root: string;
  local: string;
  bundled: string;
  projectSource: string;
  cleanup(): Promise<void>;
}> {
  root = await mkdtemp(join(tmpdir(), "installer-v4-source-"));
  const local = join(root, ".ezcorp/extensions/local");
  const bundled = join(root, "extensions/bundled");
  const projectSource = join(root, "project/.ezcorp/extensions/project-source");
  await Promise.all([mkdir(join(root, "docs/extensions/examples"), { recursive: true }), mkdir(join(root, "packages/@ezcorp"), { recursive: true })]);
  for (const path of [local, bundled, projectSource]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "extension.ts"), "throw new Error('source must not execute on host')");
    await writeFile(join(path, "ezcorp.config.ts"), "throw new Error('metadata must remain source data')");
    await writeFile(join(path, ".env"), "SECRET=not-for-workspace");
  }
  return { root, local, bundled, projectSource, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export function installSourceFetch(fetcher: typeof fetch): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  return () => { globalThis.fetch = originalFetch; };
}

export function githubFetchFixture(
  entries: Array<{ path: string; mode?: "100644" | "100755" | "120000" | "160000"; type?: "blob" | "commit"; content?: Uint8Array }> = [{ path: "extension.ts", content: Buffer.from("export const extension = 4;") }],
): { calls: Array<{ url: string; init?: RequestInit }>; fetcher: typeof fetch } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const indexed = entries.map((entry, index) => ({
    ...entry,
    mode: entry.mode ?? "100644",
    type: entry.type ?? "blob",
    content: entry.content ?? Buffer.from("export const extension = 4;"),
    sha: String(index + 1).repeat(40),
  }));
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/commits/")) return Response.json({ commit: { tree: { sha: "a".repeat(40) } } });
    if (url.includes("/git/trees/")) return Response.json({
      truncated: false,
      tree: indexed.map(({ path, mode, type, sha, content }) => ({ path, mode, type, sha, size: content.length })),
    });
    const entry = indexed.find((candidate) => url.endsWith(candidate.sha));
    if (!entry) return new Response("missing fixture blob", { status: 404 });
    return Response.json({ encoding: "base64", content: Buffer.from(entry.content).toString("base64") + "\n" });
  }) as typeof fetch;
  return { calls, fetcher };
}

export function restoreInstallerV4SourceFixture(): void {
  mock.restore();
  mock.module("../../search/egress", () => originalEgress);
}
