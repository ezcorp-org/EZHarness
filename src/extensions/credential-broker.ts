import { randomBytes } from "node:crypto";
import type { RpcHandlerDeps } from "./tool-executor/rpc-handlers";
import type { JsonRpcRequest, JsonRpcResponse } from "./types";
import { resolveReverseRpcMeta } from "./tool-executor/provenance";

export class BrokerError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "BrokerError"; }
}
export interface CredentialScope { extensionId: string; userId: string; conversationId: string | null }
export type CredentialResolver = (name: string, scope: CredentialScope) => Promise<string | null>;
let credentialResolver: CredentialResolver = async () => null;
let rawCredentialResolver: CredentialResolver = async () => null;
export function configureCredentialResolver(resolve: CredentialResolver, readRaw: CredentialResolver = async () => null): void { credentialResolver = resolve; rawCredentialResolver = readRaw; }
const policies = {
  OPENAI_API_KEY: { origin: "https://api.openai.com", path: "/", account: false },
  OPENAI_ACCESS_TOKEN: { origin: "https://chatgpt.com", path: "/backend-api/codex", account: true },
  GITHUB_TOKEN: { origin: "https://api.github.com", path: "/", account: false },
} as const;
type CredentialName = keyof typeof policies;
const prefix = "ezcred_v4_";
const handles = new Map<string, { name: CredentialName; token: string; scope: CredentialScope; expires: number; resolve: CredentialResolver }>();

export function clearExpiredCredentialHandles(now = Date.now()): void {
  for (const [id, handle] of handles) if (handle.expires <= now) handles.delete(id);
}

async function authorizeCredential(deps: RpcHandlerDeps, scope: CredentialScope, name: string): Promise<void> {
  const granted = deps.registry.getGrantedPermissions(scope.extensionId);
  const manifest = deps.registry.getManifest(scope.extensionId);
  if (!granted?.env?.includes(name) || !manifest?.permissions.env?.includes(name)) throw new BrokerError("credential_denied", "Credential access was not declared and approved.");
  const decision = await deps.engine.authorize({ extensionId: scope.extensionId, userId: scope.userId, conversationId: scope.conversationId, toolName: "env.get" }, [{ kind: "env", value: name }]);
  if (decision.decision !== "allow") throw new BrokerError("credential_denied", "Credential access is not permitted in this scope.");
}

function scopeFor(extensionId: string, request: JsonRpcRequest): { token: string; scope: CredentialScope } {
  const resolved = resolveReverseRpcMeta(extensionId, request);
  if (!resolved.ok || resolved.prov.actorExtensionId !== extensionId) throw new BrokerError("invalid_token", "A matching active invocation is required.");
  const token = (request.params as { _meta?: { ezCallId?: unknown } })?._meta?.ezCallId;
  if (typeof token !== "string") throw new BrokerError("invalid_token", "A matching active invocation is required.");
  return { token, scope: { extensionId, userId: resolved.onBehalfOf, conversationId: resolved.conversationId } };
}

export async function handleCredentialBroker(deps: RpcHandlerDeps, extensionId: string, request: JsonRpcRequest, options: { resolveCredential?: CredentialResolver; readRawCredential?: CredentialResolver } = {}): Promise<JsonRpcResponse> {
  try {
    const { token, scope } = scopeFor(extensionId, request);
    const name = (request.params as { name?: unknown })?.name;
    if (!["ezcorp/env.get", "ezcorp/credentials.read"].includes(request.method) || typeof name !== "string" || !Object.hasOwn(policies, name)) throw new BrokerError("credential_unsupported", "Only approved provider credentials are available.");
    if (request.method === "ezcorp/credentials.read") {
      const authorize = async () => {
        scopeFor(extensionId, request);
        if (!deps.registry.getManifest(extensionId)?.permissions.secretRead?.includes(name) || !deps.registry.getGrantedPermissions(extensionId)?.secretRead?.includes(name)) throw new BrokerError("credential_denied", "Raw credential extraction requires a separate reviewed grant.");
        const decision = await deps.engine.authorize({ extensionId, userId: scope.userId, conversationId: scope.conversationId, toolName: "credentials.read" }, [{ kind: "secret.read", value: name }]);
        if (decision.decision !== "allow") throw new BrokerError("credential_denied", "Raw credential extraction is not permitted in this scope.");
      };
      await authorize();
      const value = await (options.readRawCredential ?? rawCredentialResolver)(name, scope);
      await authorize();
      if (value !== null && (typeof value !== "string" || !value || value.length > 16384 || /[\r\n]/.test(value))) throw new BrokerError("credential_invalid", "Provider credential is not valid.");
      return { jsonrpc: "2.0", id: request.id, result: value };
    }
    await authorizeCredential(deps, scope, name);
    clearExpiredCredentialHandles();
    const resolve = options.resolveCredential ?? credentialResolver;
    const value = await resolve(name, scope);
    if (value === null) return { jsonrpc: "2.0", id: request.id, result: null };
    if (typeof value !== "string" || !value || value.length > 16384 || /[\r\n]/.test(value)) throw new BrokerError("credential_invalid", "Provider credential is not valid.");
    if (handles.size >= 4096) throw new BrokerError("credential_capacity", "Credential handle capacity is full.");
    const handle = `${prefix}${randomBytes(32).toString("hex")}`;
    handles.set(handle, { name: name as CredentialName, token, scope, expires: Date.now() + 60_000, resolve });
    return { jsonrpc: "2.0", id: request.id, result: handle };
  } catch (error) {
    return { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error instanceof BrokerError ? error.message : "Credential access failed." } };
  }
}

export async function injectCredentialHeaders(deps: RpcHandlerDeps, extensionId: string, request: JsonRpcRequest, target: URL, sourceHeaders: Headers): Promise<Headers> {
  const headers = new Headers(sourceHeaders);
  if (target.toString().includes(prefix)) throw new BrokerError("credential_location", "Credential handles may only appear in an Authorization header.");
  for (const [name, value] of headers) if (value.includes(prefix) && name !== "authorization") throw new BrokerError("credential_location", "Credential handles may only appear in an Authorization header.");
  const authorization = headers.get("authorization");
  if (!authorization?.includes(prefix)) return headers;
  clearExpiredCredentialHandles();
  const handleId = authorization.match(/^Bearer (ezcred_v4_[a-f0-9]{64})$/)?.[1];
  const handle = handleId ? handles.get(handleId) : undefined;
  const current = scopeFor(extensionId, request);
  if (!handle || handle.token !== current.token || handle.scope.extensionId !== extensionId || handle.scope.userId !== current.scope.userId || handle.scope.conversationId !== current.scope.conversationId) throw new BrokerError("credential_unavailable", "Credential handle is expired or belongs to another invocation.");
  const policy = policies[handle.name];
  if (target.origin !== policy.origin || target.username || target.password || target.hash || !(policy.path === "/" || (target.pathname === policy.path || target.pathname.startsWith(`${policy.path}/`)) && !target.pathname.includes("%"))) throw new BrokerError("credential_destination", "Credential handle is not approved for this destination.");
  await authorizeCredential(deps, current.scope, handle.name);
  const value = await handle.resolve(handle.name, current.scope);
  if (typeof value !== "string" || !value || value.length > 16384 || /[\r\n]/.test(value)) throw new BrokerError("credential_unavailable", "Provider credential is no longer available.");
  headers.set("authorization", `Bearer ${value}`);
  if (policy.account) {
    let claims: unknown;
    try { claims = JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString("utf8")); } catch { throw new BrokerError("credential_invalid", "Provider account metadata is unavailable."); }
    const account = (claims as { "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown } })?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof account !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(account)) throw new BrokerError("credential_invalid", "Provider account metadata is unavailable.");
    if (headers.has("chatgpt-account-id") && headers.get("chatgpt-account-id") !== account) throw new BrokerError("credential_account", "Provider account header does not match the credential.");
    headers.set("chatgpt-account-id", account);
  }
  return headers;
}
