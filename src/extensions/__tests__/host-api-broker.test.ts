import { expect, test, mock } from "bun:test";
import { configureHostApiTransport, handleHostApi, routeMatches, validateHostApiRequest } from "../host-api-broker";
import { registerCallProvenance, releaseCallProvenance } from "../call-provenance";
import { grantsToCapabilitySet, hostApiRouteCapability, intersectPermissions } from "../capability-types";
import type { RpcHandlerDeps } from "../tool-executor/rpc-handlers";
import type { ExtensionPermissions, JsonRpcRequest } from "../types";

let activeUser = true;
mock.module("../../db/queries/users", () => ({ getUserById: async () => ({ id: "user", status: activeUser ? "active" : "inactive" }) }));

const permissions: NonNullable<ExtensionPermissions["hostApi"]> = { routes: [{ method: "GET", path: "/api/conversations/:id" }, { method: "POST", path: "/api/conversations" }] };

test("API broker matches exact segments and methods", () => {
  expect(routeMatches("/api/conversations/:id", "/api/conversations/conv_1")).toBe(true);
  expect(routeMatches("/api/conversations/:id", "/api/conversations/id/messages")).toBe(false);
  expect(validateHostApiRequest({ method: "GET", path: "/api/conversations/conv_1?limit=1" }, permissions)).toEqual({ method: "GET", path: "/api/conversations/conv_1?limit=1" });
  expect(validateHostApiRequest({ method: "POST", path: "/api/conversations", body: { title: "test" } }, permissions)).toHaveProperty("body");
  expect(() => validateHostApiRequest({ method: "DELETE", path: "/api/conversations/conv_1" }, permissions)).toThrow("not approved");
});

test("API broker rejects external, normalized, encoded and malformed paths", () => {
  for (const path of ["https://evil.test/api/conversations/id", "//evil.test/api/conversations/id", "/api/../api/conversations/id", "/api/conversations/%2e%2e", "/api/conversations/id%2fmessages", "/api/conversations/id\\messages", "/api/conversations/id#fragment", "/api/conversations/id\n"]) expect(() => validateHostApiRequest({ method: "GET", path }, permissions)).toThrow();
  for (const input of [null, [], {}, { path: "/api/conversations/id", method: "get" }, { path: "/api/conversations/id", method: "GET", body: {} }]) expect(() => validateHostApiRequest(input, permissions)).toThrow();
});

test("even a declared grant cannot reach human approval or privileged host routes", () => {
  for (const path of ["/api/extensions/releases/id/approve", "/api/extensions/control", "/api/auth/login", "/api/settings/providers", "/api/__test/mock-llm", "/api/runtime-events", "/api/not-a-route"]) {
    expect(() => validateHostApiRequest({ method: "POST", path }, { routes: [{ method: "POST", path }] })).toThrow("not available");
  }
});

test("host API grants remain bounded through caller-capability intersections", () => {
  const first = { grantedAt: {}, hostApi: { ...permissions, events: true } };
  const second = { grantedAt: {}, hostApi: { routes: [permissions.routes[0]!], events: false } };
  const narrowed = intersectPermissions(first, second);
  expect(narrowed.hostApi).toEqual({ routes: [permissions.routes[0]], events: false });
  expect(grantsToCapabilitySet(narrowed)).toEqual([hostApiRouteCapability(permissions.routes[0]!)]);
  expect(grantsToCapabilitySet(first)).toContainEqual({ kind: "ezcorp:api:events" });
  expect(intersectPermissions(first, { grantedAt: {}, hostApi: { routes: [], events: false } }).hostApi).toBeUndefined();
  expect(intersectPermissions(first, { grantedAt: {} }).hostApi).toBeUndefined();
});

test("production broker requires matching identity, live grants, active user and per-call policy", async () => {
  const token = registerCallProvenance({ actorExtensionId: "extension", onBehalfOf: "user", conversationId: "conversation", runId: null, parentCallId: null, kind: "tool", ownerless: false });
  let declared = true; let approved = true; let events = true; let allowed = true; let transportFails = false;
  const requestTransport = mock(async () => { if (transportFails) throw new Error("secret failure"); return { status: 200, body: "owned response" }; });
  const eventTransport = mock(async () => ({ cursor: "2", events: [{ type: "owned" }] }));
  const authorize = mock(async () => ({ decision: allowed ? "allow" : "prompt" }));
  const deps = { registry: { getManifest: () => ({ permissions: { hostApi: declared ? { ...permissions, events } : undefined } }), getGrantedPermissions: () => ({ hostApi: approved ? { ...permissions, events } : undefined }) }, engine: { authorize } } as unknown as RpcHandlerDeps;
  const request = (method = "ezcorp/api.request", input: Record<string, unknown> = { method: "GET", path: "/api/conversations/conv_1" }): JsonRpcRequest => ({ jsonrpc: "2.0", id: "request", method, params: { ...input, _meta: { ezCallId: token } } });
  try {
    expect((await handleHostApi(deps, "foreign", request())).error?.code).toBe(-32602);
    expect((await handleHostApi(deps, "extension", request())).error?.message).toContain("not configured");
    configureHostApiTransport({ request: requestTransport, events: eventTransport });
    expect((await handleHostApi(deps, "extension", request())).result).toEqual({ status: 200, body: "owned response" });
    expect(requestTransport).toHaveBeenCalledWith("user", { method: "GET", path: "/api/conversations/conv_1" });
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ userId: "user", conversationId: "conversation" }), [hostApiRouteCapability(permissions.routes[0]!)]);
    allowed = false;
    expect((await handleHostApi(deps, "extension", request())).error?.message).toContain("not permitted");
    expect(requestTransport).toHaveBeenCalledTimes(1);
    allowed = true; activeUser = false;
    expect((await handleHostApi(deps, "extension", request())).error?.message).toContain("active caller");
    activeUser = true; declared = false;
    expect((await handleHostApi(deps, "extension", request())).error?.message).toContain("not approved");
    declared = true; approved = false;
    expect((await handleHostApi(deps, "extension", request())).error?.message).toContain("not approved");
    approved = true; transportFails = true;
    expect((await handleHostApi(deps, "extension", request())).error?.message).toBe("Host API request failed.");
    transportFails = false;
    expect((await handleHostApi(deps, "extension", request("ezcorp/api.events", { cursor: "1", waitMs: 0 }))).result).toEqual({ cursor: "2", events: [{ type: "owned" }] });
    expect(eventTransport).toHaveBeenCalledWith("user", { cursor: "1", waitMs: 0, conversationId: "conversation" });
    expect((await handleHostApi(deps, "extension", request("ezcorp/api.events", { waitMs: 1001 }))).error?.message).toContain("numeric cursor");
    expect((await handleHostApi(deps, "extension", request("ezcorp/api.events", { cursor: "foreign" }))).error?.message).toContain("numeric cursor");
    events = false;
    expect((await handleHostApi(deps, "extension", request("ezcorp/api.events", {}))).error?.message).toContain("not approved");
  } finally { activeUser = true; releaseCallProvenance(token); }
});
