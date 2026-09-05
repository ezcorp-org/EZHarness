import { apiRegistry } from "../api-registry";
import type { JsonRpcRequest, JsonRpcResponse } from "./types";
import type { RpcHandlerDeps } from "./tool-executor/rpc-handlers";
import { resolveReverseRpcMeta } from "./tool-executor/provenance";
import { LifecycleError } from "./v4/types";
import { hostApiRouteCapability, type Capability } from "./capability-types";

export interface HostApiTransport {
  request(userId: string, request: { path: string; method: string; body?: unknown }): Promise<{ status: number; body: string; headers?: Record<string, string> }>;
  events(userId: string, request: { cursor?: string; waitMs: number; conversationId: string | null }): Promise<{ cursor: string; events: unknown[]; done?: boolean }>;
}

let transport: HostApiTransport | undefined;
export function configureHostApiTransport(value: HostApiTransport): void { transport = value; }

export function routeMatches(pattern: string, path: string): boolean {
  const template = pattern.split("/");
  const actual = path.split("/");
  return template.length === actual.length && template.every((part, index) => part.startsWith(":") ? /^[a-zA-Z0-9_-]+$/.test(actual[index] ?? "") : part === actual[index]);
}

export function validateHostApiRequest(input: unknown, permissions: { routes: { method: string; path: string }[] }): { path: string; method: string; body?: unknown } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LifecycleError("invalid_input", "Provide an API request object.");
  const value = input as Record<string, unknown>;
  if (typeof value.path !== "string" || value.path.length > 4096 || !value.path.startsWith("/api/") || /[\\#]/.test(value.path) || [...value.path].some((character) => character.charCodeAt(0) <= 32) || /%2f|%5c|%2e/i.test(value.path)) throw new LifecycleError("invalid_path", "Only canonical local API paths are allowed.");
  const url = new URL(value.path, "http://127.0.0.1");
  if (url.pathname !== value.path.split("?")[0] || url.origin !== "http://127.0.0.1") throw new LifecycleError("invalid_path", "API path normalization is not allowed.");
  const method = value.method;
  if (typeof method !== "string" || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new LifecycleError("invalid_method", "Use an explicit supported HTTP method.");
  const route = apiRegistry.find((entry) => entry.method === method && routeMatches(entry.path, url.pathname));
  if (!route || route.scope === "session" || route.scope === "admin" || url.pathname === "/api/runtime-events" || url.pathname.startsWith("/api/auth/") && url.pathname !== "/api/auth/me" || url.pathname.startsWith("/api/extensions/") || url.pathname.startsWith("/api/__test/") || url.pathname.startsWith("/api/settings/")) throw new LifecycleError("api_route_denied", "This host API route is not available to extensions.");
  if (!permissions.routes.some((grant) => grant.method === method && routeMatches(grant.path, url.pathname))) throw new LifecycleError("permission_denied", "This API method and path were not approved.");
  if (method === "GET" && value.body !== undefined) throw new LifecycleError("invalid_input", "GET requests cannot include a body.");
  return { path: `${url.pathname}${url.search}`, method, ...(value.body === undefined ? {} : { body: value.body }) };
}

export async function handleHostApi(deps: RpcHandlerDeps, extensionId: string, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const resolved = resolveReverseRpcMeta(extensionId, request);
  if (!resolved.ok) return resolved.errorResponse;
  const { onBehalfOf, conversationId } = resolved;
  try {
    const manifest = deps.registry.getManifest(extensionId);
    const grants = deps.registry.getGrantedPermissions(extensionId);
    const declared = manifest?.permissions.hostApi;
    const approved = grants?.hostApi;
    if (!declared || !approved) throw new LifecycleError("permission_denied", "Host API access was not approved.");
    if (!transport) throw new LifecycleError("broker_unavailable", "Host API transport is not configured.");
    const { getUserById } = await import("../db/queries/users");
    const user = await getUserById(resolved.onBehalfOf);
    if (user?.status !== "active") throw new LifecycleError("unauthorized", "An active caller is required.");
    async function authorize(capability: Capability): Promise<void> {
      const decision = await deps.engine.authorize({ extensionId, userId: onBehalfOf, conversationId, toolName: request.method }, [capability]);
      if (decision.decision !== "allow") throw new LifecycleError("permission_denied", "Host API access is not permitted in this context.");
    }
    let result: unknown;
    if (request.method === "ezcorp/api.events") {
      if (!declared.events || !approved.events) throw new LifecycleError("permission_denied", "Runtime event access was not approved.");
      const input = request.params as Record<string, unknown> | undefined;
      const waitMs = input?.waitMs ?? 1000;
      if (!Number.isSafeInteger(waitMs) || Number(waitMs) < 0 || Number(waitMs) > 1000 || input?.cursor !== undefined && (typeof input.cursor !== "string" || !/^\d{1,20}$/.test(input.cursor))) throw new LifecycleError("invalid_input", "Provide a numeric cursor and waitMs between 0 and 1000.");
      await authorize({ kind: "ezcorp:api:events" });
      result = await transport.events(user.id, { cursor: input?.cursor as string | undefined, waitMs: Number(waitMs), conversationId: resolved.conversationId });
    } else {
      const input = validateHostApiRequest(request.params, declared);
      validateHostApiRequest(input, approved);
      const grantedRoute = approved.routes.find((route) => route.method === input.method && routeMatches(route.path, input.path.split("?")[0]!))!;
      await authorize(hostApiRouteCapability(grantedRoute));
      result = await transport.request(user.id, input);
    }
    return { jsonrpc: "2.0", id: request.id, result };
  } catch (cause) {
    return { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: cause instanceof LifecycleError ? cause.message : "Host API request failed." } };
  }
}
