import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PodmanRunner, provisionToolchain, buildLimits } from "@ezcorp/extension-runner";
import type { Runner, WorkspaceFiles } from "@ezcorp/extension-contract";
import { snapshotFirstPartyExtension } from "../../../scripts/migrate-extension-v4";
import { digestObject } from "../../extensions/v4/blobs";
import { releaseRuntimeFixture } from "./release-runtime";
import { getTestDb } from "./test-pglite";
import { conversations, projects, projectMembers, users } from "../../db/schema";
import { createExtension, getExtension } from "../../db/queries/extensions";
import { getStorageValue } from "../../db/queries/extension-storage";
import { ReleaseProcess } from "../../extensions/release-process";
import { ExtensionRegistry } from "../../extensions/registry";
import { registerCallProvenance, releaseCallProvenance } from "../../extensions/call-provenance";
import { buildFullGrantFromManifest } from "../../extensions/install-grant";
import { handleVirtualFilesystemRpc, type VirtualFsOperation } from "../../extensions/virtual-filesystem";
import { handleStorageRpc } from "../../extensions/storage-handler";
import { handleNetworkBroker } from "../../extensions/network-broker";
import { handleCredentialBroker } from "../../extensions/credential-broker";
import { handleProjectGit } from "../../extensions/project-git-broker";
import { DatabaseLifecycleRepository } from "../../db/queries/extension-releases";
import { up as createReleaseTables } from "../../db/migrations/add-extension-releases";
import { createStubPermissionEngine } from "./permission-engine-stub";
import type { JsonRpcRequest, JsonRpcResponse } from "../../extensions/types";

export async function seedFirstPartyGit(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "README.md"), "# probe\n");
  for (const args of [["init", "-q"], ["config", "user.email", "probe@example.test"], ["config", "user.name", "Probe"], ["add", "README.md"], ["commit", "-q", "-m", "feat: seed the probe repo"]]) {
    const process = Bun.spawn(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe", env: { ...globalThis.process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    const stderr = await new Response(process.stderr).text();
    if (await process.exited !== 0) throw new Error(stderr);
  }
}

export async function buildFirstPartyRelease(name: string) {
  const source = await snapshotFirstPartyExtension(resolve(import.meta.dir, "../../.."), name);
  return buildIsolatedRelease(source.files, source.source.entrypoint);
}

export async function buildIsolatedRelease(files: WorkspaceFiles, entrypoint: string) {
  const root = await mkdtemp(join(tmpdir(), "first-party-release-"));
  const projectRoot = resolve(import.meta.dir, "../../..");
  const toolchain = await provisionToolchain({ sdkEntrypoint: join(projectRoot, "packages/@ezcorp/sdk/src/v4/index.ts") });
  const runner = new PodmanRunner({ root: join(root, "runner"), ...toolchain });
  try {
    await runner.initialize();
    const build = await runner.build({ operationId: crypto.randomUUID(), sourceDigest: digestObject(files), files, entrypoint, limits: buildLimits });
    if (build.state !== "succeeded" || !build.manifest || !build.artifactDigest) throw new Error(JSON.stringify(build.diagnostics));
    const manifest = build.manifest;
    const name = manifest.name;
    const artifactDigest = build.artifactDigest;
    return {
      async close() { await runner.close(); await rm(root, { recursive: true, force: true }); },
      manifest,
      async session(options: { projectRoot?: string; settings?: Record<string, unknown>; denyNetwork?: boolean; networkHosts?: string[]; fetchImpl?: typeof fetch; credential?: string; persistRelease?: boolean; handler?: (request: JsonRpcRequest) => Promise<JsonRpcResponse | undefined> } = {}) {
        const database = getTestDb();
        const directory = options.projectRoot ?? await mkdtemp(join(tmpdir(), "first-party-project-"));
        const data = join(directory, ".ezcorp", "extension-data", name);
        await mkdir(directory, { recursive: true });
        const [user] = await database.insert(users).values({ email: `${crypto.randomUUID()}@test.local`, passwordHash: "fixture", name: "Owner", role: "admin", status: "active" }).returning();
        const [project] = await database.insert(projects).values({ name: "Test", path: directory }).returning();
        await database.insert(projectMembers).values({ projectId: project!.id, userId: user!.id });
        const [conversation] = await database.insert(conversations).values({ projectId: project!.id, userId: user!.id }).returning();
        const id = crypto.randomUUID();
        const grants = buildFullGrantFromManifest(manifest);
        await createExtension({ id, name, version: manifest.version, manifest, grantedPermissions: grants, source: "release-v4", creatorUserId: user!.id });
        const snapshot = releaseRuntimeFixture(id, manifest, { ownerId: user!.id, artifactDigest }).snapshot;
        snapshot.limits.timeoutMs = 30_000;
        if (options.persistRelease) {
          await createReleaseTables(database);
          await new DatabaseLifecycleRepository(database).create({ installation: snapshot.installation, releases: { [snapshot.release.id]: snapshot.release }, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
        }
        const registry = ExtensionRegistry.getInstance();
        registry.setManifestForTest(id, manifest);
        registry.setGrantedPermsForTest(id, grants);
        const engine = createStubPermissionEngine(options.denyNetwork ? "deny-all" : "allow-all");
        const authorize = engine.authorize;
        if (options.networkHosts) engine.authorize = async (context, capabilities) => capabilities.some(capability => capability.kind === "network" && (!capability.value || !options.networkHosts!.includes(capability.value))) ? { decision: "deny", reason: "fixture_network_policy", auditId: "fixture-network-policy" } : authorize(context, capabilities);
        const deps = { registry, engine, resolveExtensionScopeGrant: async () => true };
        let starts = 0;
        const failures: string[] = [];
        const isolatedRunner: Runner = {
          build: runner.build.bind(runner), cancel: runner.cancel.bind(runner), inspect: runner.inspect.bind(runner), collectArtifacts: runner.collectArtifacts.bind(runner),
          async start(input, reverse) { starts++; return runner.start(input, async (method, params) => { try { return await reverse(method, params); } catch (error) { failures.push(`${method}: ${error instanceof Error ? error.message : String(error)}`); throw error; } }); },
        };
        const runtime = { runner: async () => isolatedRunner, resolve: async (extensionId: string) => extensionId === id ? snapshot : null };
        const process = new ReleaseProcess(id, runtime);
        const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
        process.setNotificationHandler((notification) => { notifications.push(notification); });
        process.setRequestHandler(async (request) => {
          const custom = await options.handler?.(request);
          if (custom) return custom;
          if (request.method === "ezcorp/storage") return handleStorageRpc(id, request, { conversationId: conversation!.id, userId: user!.id, manifest, grantedPermissions: grants, engine });
          if (request.method.startsWith("ezcorp/fs.")) return handleVirtualFilesystemRpc(request.method.slice("ezcorp/fs.".length) as VirtualFsOperation, request, { registry, engine, extensionId: id, conversationId: conversation!.id, userId: user!.id }, { roots: async () => ({ project: directory, data }) });
          if (request.method.startsWith("ezcorp/project.")) return handleProjectGit(deps, id, request);
          if (request.method.startsWith("ezcorp/network.")) return handleNetworkBroker(deps, id, request, { resolveHost: async () => ["1.1.1.1"], fetchImpl: options.fetchImpl ?? (async () => { throw new Error("Unexpected network access"); }) });
          if (request.method === "ezcorp/env.get") return options.credential ? handleCredentialBroker(deps, id, request, { resolveCredential: async () => options.credential! }) : { jsonrpc: "2.0", id: request.id, result: null };
          if (request.method === "ezcorp/invoke" && request.params?.tool === "runtime.settings.getMine") return { jsonrpc: "2.0", id: request.id, result: options.settings ?? {} };
          return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unexpected capability: ${request.method}` } };
        });
        const invoke = async (method: string, params: Record<string, unknown>) => {
          const token = registerCallProvenance({ actorExtensionId: id, onBehalfOf: user!.id, conversationId: conversation!.id, runId: null, parentCallId: null, kind: "tool", ownerless: false });
          try { return await process.call(method, { ...params, _meta: { ezCallId: token } }); }
          finally { releaseCallProvenance(token); }
        };
        return {
          id, process, runtime, registry, snapshot, notifications, failures, userId: user!.id, projectId: project!.id, projectRoot: directory, dataRoot: data, conversationId: conversation!.id, starts: () => starts,
          installed: () => getExtension(id),
          call: invoke,
          async tool(tool: string, input: Record<string, unknown>) { return (await invoke("tools/call", { name: tool, arguments: input })).result as { isError: boolean; content: Array<{ type: string; text?: string }> }; },
          async storage(key: string) { return (await getStorageValue(id, "global", null, key))?.value; },
          async close() { process.kill(); await process.whenCallsSettled(); if (!options.projectRoot) await rm(directory, { recursive: true, force: true }); },
        };
      },
    };
  } catch (error) { await runner.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
