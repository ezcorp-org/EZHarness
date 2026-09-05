import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LifecycleActor } from "../v4/types";
import * as egress from "../../search/egress";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";

const root = await mkdtemp(join(tmpdir(), "ez-private-source-"));
const actor: LifecycleActor = { principalId: "owner", scope: "global", kind: "human" };
let active = true;
let member = true;
let token: string | null = "private-source-fixture-token";
let projectExists = true;
const staged: unknown[] = [];
const requests: string[] = [];
const originalFetch = globalThis.fetch;
const originalEgress = { ...egress };
mock.module("../../search/egress", () => ({ ...originalEgress, guardedFetch: (url: string, init: RequestInit, options: egress.GuardedFetchOptions) => originalEgress.guardedFetch(url, init, { ...options, resolveHost: async () => ["93.184.216.34"] }) }));
mock.module("../../db/queries/users", () => ({ getUserById: async () => ({ id: "owner", role: "admin", status: active ? "active" : "disabled" }) }));
mock.module("../../db/queries/projects", () => ({ listProjects: async () => [], getProject: async (id: string) => projectExists && id === "project" ? { id, path: root } : undefined }));
mock.module("../../auth/middleware", () => ({ checkProjectRole: async () => member ? undefined : new Response(null, { status: 403 }) }));
mock.module("../secrets-store", () => ({ getSecret: async (extension: string, project: string, name: string) => { expect([extension, project, name]).toEqual(["github-projects", "project", "apiToken"]); return token; } }));
mock.module("../extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => ({
  createWorkspace: async (_actor: LifecycleActor, input: unknown) => { staged.push(input); return { installation: { id: "install", enabled: false }, workspace: { id: "workspace", revision: 1, sourceDigest: "digest" } }; },
  build: async () => ({ id: "operation", state: "queued" }), runBuild: async () => {},
}) }));
const { importExtensionSource, resolveProjectSourceCredential } = await import("../source-import");
async function git(...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const errors = await new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(errors);
}
beforeAll(async () => { await git("init"); await git("remote", "add", "origin", "https://github.com/owner/private.git"); });
beforeEach(() => {
  active = true; member = true; projectExists = true; token = "private-source-fixture-token";
  staged.length = 0; requests.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(new Headers(init?.headers).get("authorization") ?? "");
    if (requests.at(-1) !== "Bearer private-source-fixture-token") return new Response(null, { status: 404 });
    return Response.json(url.includes("/commits/") ? { commit: { tree: { sha: "a".repeat(40) } } }
      : url.includes("/git/trees/") ? { tree: [{ path: "extension.ts", mode: "100644", type: "blob", sha: "b".repeat(40), size: 7 }] }
      : { encoding: "base64", content: Buffer.from("fixture").toString("base64") });
  }) as typeof fetch;
});
afterAll(async () => { globalThis.fetch = originalFetch; restoreModuleMocks(); mock.module("../../search/egress", () => originalEgress); await rm(root, { recursive: true, force: true }); });

test("a selected project credential imports private source without activating or exposing the token", async () => {
  const input = { kind: "github" as const, repository: "owner/private", projectId: "project" };
  const result = await importExtensionSource(actor, input);
  expect(requests).toEqual(Array(3).fill("Bearer private-source-fixture-token"));
  expect(result.installation.enabled).toBe(false);
  expect(staged).toHaveLength(1);
  expect(JSON.stringify({ result, staged })).not.toContain(token!);
});

test("no project selection never borrows a project credential", async () => {
  await expect(importExtensionSource(actor, { kind: "github", repository: "owner/private" })).rejects.toThrow();
  expect(requests).toEqual([""]);
  expect(staged).toHaveLength(0);
});

test("wrong project or repository, revoked membership, and missing secrets fail before a request", async () => {
  for (const change of [() => { member = false; }, () => { projectExists = false; }, () => { token = null; }]) {
    member = true; projectExists = true; token = "private-source-fixture-token"; change();
    await expect(importExtensionSource(actor, { kind: "github", repository: "owner/private", projectId: "project" } as Parameters<typeof importExtensionSource>[1])).rejects.toThrow();
    expect(requests).toHaveLength(0);
  }
  member = true; projectExists = true; token = "private-source-fixture-token";
  await expect(importExtensionSource(actor, { kind: "github", repository: "attacker/other", projectId: "project" } as Parameters<typeof importExtensionSource>[1])).rejects.toThrow();
  expect(requests).toHaveLength(0);
  expect(staged).toHaveLength(0);
});

test("membership is checked again before the next source request", async () => {
  const transport = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { const response = await transport(...args); member = false; return response; }) as typeof fetch;
  await expect(importExtensionSource(actor, { kind: "github", repository: "owner/private", projectId: "project" } as Parameters<typeof importExtensionSource>[1])).rejects.toThrow();
  expect(requests).toEqual(["Bearer private-source-fixture-token"]);
  expect(staged).toHaveLength(0);
});

test("invalid project IDs and non-human or disabled actors cannot obtain source credentials", async () => {
  for (const projectId of ["", "../project", "a".repeat(129)]) {
    await expect(resolveProjectSourceCredential(actor, "owner/private", projectId)).rejects.toThrow("valid project");
  }
  await expect(resolveProjectSourceCredential({ ...actor, kind: "agent" }, "owner/private", "project")).rejects.toThrow("human administrator");
  active = false;
  await expect(resolveProjectSourceCredential(actor, "owner/private", "project")).rejects.toThrow("active user");
  expect(requests).toHaveLength(0);
  expect(staged).toHaveLength(0);
});
