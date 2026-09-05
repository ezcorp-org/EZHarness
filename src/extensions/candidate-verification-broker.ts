import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertJson, canonicalJson, validateInvocationContext, validateWorkspacePath, type CandidateVerificationReport, type InvocationContext, type ReleaseRecord, type ReverseRpc } from "@ezcorp/extension-contract";
import { firstMissingCapability, grantsToCapabilitySet } from "./capability-types";
import { registerCallProvenance, releaseCallProvenance, resolveCallProvenance } from "./call-provenance";
import { handleCredentialBroker } from "./credential-broker";
import { buildFullGrantFromManifest } from "./install-grant";
import { handleNetworkBroker } from "./network-broker";
import type { PermissionEngine } from "./permission-engine";
import type { ExtensionRegistry } from "./registry";
import { handleStorageRpc, type StorageRepository } from "./storage-handler";
import type { RpcHandlerDeps } from "./tool-executor/rpc-handlers";
import { handleVirtualFilesystemRpc, type VirtualFsOperation } from "./virtual-filesystem";
import type { ExtensionManifestV2, JsonRpcResponse } from "./types";
import { LifecycleError } from "./v4/types";

export interface CandidateFixtures {
  projectFiles?: Record<string, string>;
  dataFiles?: Record<string, string>;
  network?: Array<{ url: string; method: string; requestBody?: string; status: number; headers?: Record<string, string>; body: string }>;
}

export interface CandidateVerificationBroker {
  reverseRpc: ReverseRpc;
  begin(toolName: string): void;
  coverage(): CandidateVerificationReport["capabilities"];
  close(): Promise<void>;
}

function fixtureStorage(extensionId: string): StorageRepository {
  const rows = new Map<string, { value: unknown; encrypted: boolean; sizeBytes: number; expiresAt: Date | null; key: string }>();
  const secret = randomBytes(32);
  let pending: Promise<unknown> = Promise.resolve();
  const identity = (...parts: unknown[]) => canonicalJson(parts);
  const repository: StorageRepository = {
    async transaction(_id, operation) {
      const result = pending.then(async () => {
        const snapshot = structuredClone(rows);
        try { return await operation(repository); }
        catch (error) { rows.clear(); for (const [key, value] of snapshot) rows.set(key, value); throw error; }
      });
      pending = result.catch(() => undefined);
      return result;
    },
    async get(id, scope, scopeId, key) {
      const address = identity(id, scope, scopeId, key);
      const row = rows.get(address);
      if (row?.expiresAt && row.expiresAt.getTime() <= Date.now()) { rows.delete(address); return null; }
      return row ? structuredClone(row) : null;
    },
    async set(id, scope, scopeId, key, value, encrypted, sizeBytes, expiresAt) { rows.set(identity(id, scope, scopeId, key), { value: structuredClone(value), encrypted, sizeBytes, expiresAt: expiresAt ?? null, key }); },
    async delete(id, scope, scopeId, key) { return rows.delete(identity(id, scope, scopeId, key)); },
    async list(id, scope, scopeId, prefix = "", limit = 100) {
      const result = [];
      for (const [address, row] of rows) if (address === identity(id, scope, scopeId, row.key) && row.key.startsWith(prefix) && (!row.expiresAt || row.expiresAt.getTime() > Date.now())) result.push({ key: row.key, encrypted: row.encrypted, sizeBytes: row.sizeBytes, expiresAt: row.expiresAt });
      return result.slice(0, limit);
    },
    async usage(id) {
      const selected = [...rows].filter(([address, row]) => JSON.parse(address)[0] === id && (!row.expiresAt || row.expiresAt.getTime() > Date.now()));
      return { totalBytes: selected.reduce((sum, [, row]) => sum + row.sizeBytes, 0), keyCount: selected.length };
    },
    async conversationExtensionIds() { return [extensionId]; },
    encrypt(value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", secret, nonce);
      const encrypted = Buffer.concat([cipher.update(canonicalJson(value)), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
    },
    decrypt(value) {
      const bytes = Buffer.from(value, "base64");
      const cipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"));
    },
  };
  return repository;
}

function capabilityFor(method: string): string {
  if (method.startsWith("ezcorp/fs.")) return "filesystem";
  if (method.startsWith("ezcorp/network.")) return "network";
  if (method.startsWith("ezcorp/env.")) return "env";
  if (method === "ezcorp/storage") return "storage";
  return method;
}

export async function createCandidateVerificationBroker(release: ReleaseRecord, context: InvocationContext, fixtures: CandidateFixtures = {}): Promise<CandidateVerificationBroker> {
  validateInvocationContext(context);
  if (context.releaseId !== release.id || !context.scopeId.startsWith("verification:") || context.principalId !== "extension-verification") throw new LifecycleError("invalid_verification_context", "Candidate broker requires a dedicated verification scope.");
  const root = await mkdtemp(join(tmpdir(), "extension-candidate-"));
  const project = join(root, "project");
  const data = join(root, "data");
  try {
    for (const [directory, files] of [[project, fixtures.projectFiles], [data, fixtures.dataFiles]] as const) {
      await mkdir(directory, { mode: 0o700 });
      for (const [path, value] of Object.entries(files ?? {})) {
        validateWorkspacePath(path);
        const parts = path.split("/");
        await mkdir(join(directory, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 });
        await writeFile(join(directory, path), value, { mode: 0o600 });
      }
    }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  const extensionId = `verification-${randomUUID()}`;
  const token = registerCallProvenance({ actorExtensionId: extensionId, onBehalfOf: context.principalId, conversationId: context.scopeId, runId: null, parentCallId: null, kind: "tool", ownerless: false });
  const manifest = release.manifest as unknown as ExtensionManifestV2;
  const grants = buildFullGrantFromManifest(manifest);
  const granted = grantsToCapabilitySet(grants, context.principalId);
  const registry = { getManifest: () => manifest, getGrantedPermissions: () => grants } as unknown as ExtensionRegistry;
  const engine = { async authorize(_actor, needed) { const missing = firstMissingCapability(needed, granted); return missing ? { decision: "deny", reason: "Undeclared test capability", missing, auditId: randomUUID() } : { decision: "allow", auditId: randomUUID() }; } } as PermissionEngine;
  const dependencies = { registry, engine, resolveExtensionScopeGrant: async () => false } as RpcHandlerDeps;
  const repository = fixtureStorage(extensionId);
  const coverage = new Map<string, CandidateVerificationReport["capabilities"][number]>(Object.entries(manifest.permissions).filter(([, value]) => value !== false && value !== undefined && (!Array.isArray(value) || value.length > 0)).map(([capability]) => [capability, { capability, state: "unexercised", calls: 0 }]));
  let activeTool: string | undefined;
  let closed = false;
  const denied = (capability: string) => { const previous = coverage.get(capability); coverage.set(capability, { capability, state: "denied", calls: (previous?.calls ?? 0) + 1 }); };
  return {
    begin(toolName) {
      if (closed || !manifest.tools?.some((tool) => tool.name === toolName)) throw new LifecycleError("missing_test_tool", "Candidate test tool is undeclared.");
      activeTool = toolName;
    },
    coverage: () => structuredClone([...coverage.values()].sort((left, right) => left.capability.localeCompare(right.capability))),
    async close() { closed = true; activeTool = undefined; releaseCallProvenance(token); await rm(root, { recursive: true, force: true }); },
    async reverseRpc(method, raw) {
      const capability = capabilityFor(method);
      try {
        if (closed || !activeTool || context.deadline <= Date.now() || !resolveCallProvenance(token)) throw new LifecycleError("test_effect_denied", "Candidate effects require an active bounded smoke invocation.");
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LifecycleError("test_context_mismatch", "Missing candidate capability envelope.");
        const envelope = raw as Record<string, unknown>;
        if (Object.keys(envelope).some((key) => key !== "context" && key !== "input") || canonicalJson(validateInvocationContext(envelope.context)) !== canonicalJson(context) || !envelope.input || typeof envelope.input !== "object" || Array.isArray(envelope.input)) throw new LifecycleError("test_context_mismatch", "Candidate context does not match this worker.");
        const input = { ...envelope.input as Record<string, unknown>, _toolName: activeTool, _meta: { ezCallId: token } };
        const request = { jsonrpc: "2.0" as const, id: randomUUID(), method, params: input };
        let response: JsonRpcResponse;
        if (method === "ezcorp/storage") response = await handleStorageRpc(extensionId, request, { userId: context.principalId, conversationId: context.scopeId, manifest, grantedPermissions: grants, engine, repository });
        else if (/^ezcorp\/fs\.(read|write|list|stat|exists|mkdir|unlink)$/.test(method)) response = await handleVirtualFilesystemRpc(method.slice("ezcorp/fs.".length) as VirtualFsOperation, request, { extensionId, userId: context.principalId, conversationId: context.scopeId, registry, engine }, { roots: async () => ({ project, data }) });
        else if (method === "ezcorp/env.get") response = await handleCredentialBroker(dependencies, extensionId, request, { resolveCredential: async (name) => `verification-only-${name}` });
        else if (method === "ezcorp/network.fetch" || method === "ezcorp/network.read") {
          response = await handleNetworkBroker(dependencies, extensionId, request, {
            resolveHost: async () => ["1.1.1.1"],
            fetchImpl: async (target, init) => {
              const targetUrl = new URL(target);
              const host = new Headers(init?.headers).get("host");
              if (!host) throw new LifecycleError("test_fixture_missing", "Pinned fixture request is missing its original host.");
              targetUrl.host = host;
              const url = targetUrl.toString();
              const body = init?.body ? Buffer.from(init.body as Uint8Array).toString("utf8") : undefined;
              const fixture = fixtures.network?.find((candidate) => candidate.url === url && candidate.method === (init?.method ?? "GET") && candidate.requestBody === body);
              if (!fixture) throw new LifecycleError("test_fixture_missing", "No exact network fixture is defined for this request.");
              return new Response(fixture.body, { status: fixture.status, headers: fixture.headers });
            },
          });
        } else throw new LifecycleError("test_effect_denied", "This capability has no isolated candidate fixture adapter.");
        if (response.error) throw new LifecycleError("test_capability_denied", response.error.message);
        assertJson(response.result);
        const previous = coverage.get(capability);
        coverage.set(capability, { capability, state: previous?.state === "denied" ? "denied" : "tested", calls: (previous?.calls ?? 0) + 1 });
        return response.result;
      } catch (error) { denied(capability); throw error; }
    },
  };
}
