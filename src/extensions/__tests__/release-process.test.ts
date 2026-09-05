import { describe, expect, test } from "bun:test";
import { ReleaseProcess, configureReleaseRuntime, getReleaseRuntime, releaseBinding } from "../release-process";
import { sha256 } from "@ezcorp/extension-contract";
import type { ActiveExtensionRelease, ReleaseRuntimeDependencies } from "../release-process";
import { registerCallProvenance, releaseCallProvenance } from "../call-provenance";
import type { InvocationContext, ReverseRpc, Runner, StartRequest } from "@ezcorp/extension-contract";

function harness() {
  let snapshot: ActiveExtensionRelease = {
    installation: { id: "installation", ownerId: "alice", scope: "project", activeReleaseId: "release", generation: 1, enabled: true, uninstalled: false, status: "active", grants: ["storage"], acknowledgedGeneration: 1 },
    release: { id: "release", installationId: "installation", workspaceId: "workspace", workspaceRevision: 1, sourceDigest: "source", artifactDigest: "artifact", imageDigest: "image", runnerProfile: "secure", releaseDigest: "digest", policyDigest: "policy", createdAt: "2026-09-04", evidence: { protocolVersion: 4, validatorVersion: "4.0.0", tests: [], discoveryDigest: "discovery" }, manifest: { schemaVersion: 4, name: "release-test", version: "1.0.0", description: "Fixture", author: { name: "Test" }, permissions: { storage: true }, pages: [{ id: "home", title: "Home" }], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object", required: ["content", "isError"], properties: { content: { type: "array" }, isError: { type: "boolean" } }, additionalProperties: false } }], methods: [{ name: "page/render", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] } },
    limits: { memoryBytes: 512 * 1024 * 1024, cpuMillis: 1000, pids: 64, tmpBytes: 64 * 1024 * 1024, outputBytes: 1024 * 1024, timeoutMs: 60_000 },
  };
  const starts: StartRequest[] = [];
  const reverse: ReverseRpc[] = [];
  let closed = 0;
  let onInvoke: (params: Record<string, unknown>, rpc: ReverseRpc) => Promise<unknown> = async () => ({ content: [{ type: "text", text: "done" }], isError: false });
  let onDiscover: (() => unknown) | undefined;
  const runner: Runner = {
    build: async () => { throw new Error("not used"); }, cancel: async () => {}, inspect: async id => ({ id, state: "running", diagnostics: [] }), collectArtifacts: async () => ({}),
    start: async (input, rpc) => {
      starts.push(input); reverse.push(rpc);
      return { workerId: input.workerId, request: async (method, params) => method === "extension/discover" ? (onDiscover ? onDiscover() : structuredClone(snapshot.release.manifest)) : onInvoke(params as Record<string, unknown>, rpc), close: async () => { closed++; }, onNotification: () => () => {} };
    },
  };
  const runtime: ReleaseRuntimeDependencies = { runner: async () => runner, resolve: async () => structuredClone(snapshot) };
  const process = new ReleaseProcess("installation", runtime);
  const token = registerCallProvenance({ actorExtensionId: "installation", onBehalfOf: "alice", conversationId: "conversation", ownerless: false, runId: null, parentCallId: null, kind: "tool" });
  return { process, token, starts, reverse, snapshot: () => snapshot, mutate: (change: (value: ActiveExtensionRelease) => void) => change(snapshot), setSnapshot: (value: ActiveExtensionRelease) => { snapshot = value; }, invoke: (callback: typeof onInvoke) => { onInvoke = callback; }, discover: (callback: typeof onDiscover) => { onDiscover = callback; }, closed: () => closed, cleanup: () => { process.kill(); releaseCallProvenance(token); } };
}

test("release runtime configuration exposes the configured runner without starting it", () => {
  const runtime: ReleaseRuntimeDependencies = { runner: async () => { throw new Error("No worker requested"); }, resolve: async () => null };
  configureReleaseRuntime(runtime);
  expect(getReleaseRuntime()).toBe(runtime);
});

describe("release runtime", () => {
  test("notifications require an acknowledged durable delivery hook", async () => {
    const missing = new ReleaseProcess("installation", { runner: async () => { throw new Error("unused"); }, resolve: async () => null });
    await expect(missing.sendNotification("event", {})).rejects.toThrow("not configured");
    const calls: unknown[] = [];
    const process = new ReleaseProcess("installation", { runner: async () => { throw new Error("unused"); }, resolve: async () => null, dispatchNotification: async (...args) => { calls.push(args); } });
    await process.sendNotification("event", { id: "delivery" });
    expect(calls).toEqual([["installation", "event", { id: "delivery" }]]);
    missing.kill();
    process.kill();
  });
  test("executes immutable release with host-bound broker context and fresh workers", async () => {
    const fixture = harness();
    const requests: unknown[] = [];
    fixture.process.setRequestHandler(async request => { requests.push(request); return { jsonrpc: "2.0", id: request.id, result: { saved: true } }; });
    fixture.invoke(async (params, rpc) => {
      await rpc("ezcorp/storage", { context: params.context, input: { key: "one", _toolName: "wider-tool", _meta: { ezCallId: "forged" } } });
      return { content: [], isError: false };
    });
    try {
      await fixture.process.callTool("read", {}, { ezCallId: fixture.token, ezProjectRoot: "/host-secret", ezModel: "model" });
      await fixture.process.callTool("read", {}, { ezCallId: fixture.token });
      expect(fixture.starts).toHaveLength(2);
      expect(fixture.starts[0]!.workerId).not.toBe(fixture.starts[1]!.workerId);
      expect(fixture.starts[0]!.context).toMatchObject({ principalId: "alice", scopeId: "conversation", releaseId: "release", metadata: { ezModel: "model" } });
      expect(JSON.stringify(fixture.starts)).not.toContain("host-secret");
      expect(requests[0]).toMatchObject({ method: "ezcorp/storage", params: { key: "one", _toolName: "read", _meta: { ezCallId: fixture.token } } });
      expect(fixture.closed()).toBe(2);
      expect(fixture.process.inFlightCallCount).toBe(0);
      await fixture.process.whenCallsSettled();
    } finally { fixture.cleanup(); }
  });

  test("forged, expired and foreign tokens cannot start a worker", async () => {
    const fixture = harness();
    const foreign = registerCallProvenance({ actorExtensionId: "other", onBehalfOf: "alice", conversationId: "conversation", ownerless: false, runId: null, parentCallId: null, kind: "tool" });
    try {
      for (const token of [undefined, "forged", foreign]) await expect(fixture.process.callTool("read", {}, token ? { ezCallId: token } : {})).rejects.toThrow("active call token");
      releaseCallProvenance(fixture.token);
      await expect(fixture.process.callTool("read", {}, { ezCallId: fixture.token })).rejects.toThrow();
      expect(fixture.starts).toHaveLength(0);
    } finally { releaseCallProvenance(foreign); fixture.cleanup(); }
  });

  test("reverse calls reject mismatched identities, stale release grants and late completion", async () => {
    const fixture = harness();
    let effects = 0;
    let lastContext: InvocationContext | undefined;
    fixture.process.setRequestHandler(async request => { effects++; return { jsonrpc: "2.0", id: request.id, result: {} }; });
    fixture.invoke(async (params, rpc) => {
      lastContext = params.context as InvocationContext;
      for (const field of ["principalId", "scopeId", "workerId", "releaseId", "token", "invocationId"]) await expect(rpc("ezcorp/storage", { context: { ...lastContext, [field]: "forged" }, input: {} })).rejects.toThrow();
      fixture.mutate(value => { value.installation.grants = []; });
      await expect(rpc("ezcorp/storage", { context: lastContext, input: {} })).rejects.toThrow("changed");
      return { content: [], isError: false };
    });
    try {
      await expect(fixture.process.callTool("read", {}, { ezCallId: fixture.token })).rejects.toThrow("changed");
      await expect(fixture.reverse[0]!("ezcorp/storage", { context: lastContext, input: {} })).rejects.toThrow("no longer active");
      expect(effects).toBe(0);
    } finally { fixture.cleanup(); }
  });

  test("catalog tampering and invalid output close workers without dispatch", async () => {
    const fixture = harness();
    try {
      fixture.discover(() => ({ ...fixture.snapshot().release.manifest, description: "tampered" }));
      await expect(fixture.process.callTool("read", {}, { ezCallId: fixture.token })).rejects.toThrow("does not match");
      fixture.discover(undefined);
      fixture.invoke(async () => ({ wrong: true }));
      await expect(fixture.process.callTool("read", {}, { ezCallId: fixture.token })).rejects.toThrow();
      expect(fixture.closed()).toBe(2);
    } finally { fixture.cleanup(); }
  });

  test("disabled or unacknowledged releases fail before spawn and no host commands exist", async () => {
    const fixture = harness();
    try {
      fixture.mutate(value => { value.installation.acknowledgedGeneration = 0; });
      await expect(fixture.process.callTool("read", {}, { ezCallId: fixture.token })).rejects.toThrow("acknowledged");
      expect(fixture.starts).toHaveLength(0);
      expect(() => fixture.process.getSpawnArgs()).toThrow("only through");
      expect(fixture.process.getSpawnCwd()).toBeUndefined();
      fixture.process.kill();
      expect(fixture.process.isRunning).toBe(false);
      await expect(fixture.process.sendNotification("page/render", {})).rejects.toThrow("retired");
    } finally { fixture.cleanup(); }
  });

  test("declared pages pass scoped dispatch and undeclared pushes are refused", async () => {
    const fixture = harness();
    const notifications: unknown[] = [];
    fixture.process.setNotificationHandler(notification => { notifications.push(notification); });
    fixture.invoke(async (params, rpc) => {
      expect(params.method).toBe("page/render");
      await expect(rpc("ezcorp/page-state", { context: params.context, input: { pageId: "other" } })).rejects.toThrow("not declared");
      await rpc("ezcorp/page-state", { context: params.context, input: { pageId: "home", page: { title: "Home" } } });
      return { title: "Home" };
    });
    try {
      const response = await fixture.process.call("page/render", { _meta: { ezCallId: fixture.token } });
      expect(response.result).toEqual({ title: "Home" });
      expect(notifications).toHaveLength(1);
    } finally { fixture.cleanup(); }
  });

  test("typed outputs adapt to tool cards and queued generation mismatches refuse dispatch", async () => {
    const fixture = harness();
    try {
      await expect(fixture.process.call("page/render", { _meta: { ezCallId: fixture.token, releaseId: "old-release", expectedGeneration: 1 } })).rejects.toThrow("active release generation");
      fixture.mutate(value => { value.release.manifest.tools![0]!.outputSchema = { type: "string" }; });
      fixture.invoke(async () => "typed output");
      expect(await fixture.process.callTool("read", {}, { ezCallId: fixture.token })).toEqual({ content: [{ type: "text", text: "typed output" }], isError: false });
    } finally { fixture.cleanup(); }
  });
});

test("browser binding cannot adopt changed grants or a later release at worker dispatch", async () => {
  const fixture = harness();
  try {
    const expectedReleaseBinding = await sha256(releaseBinding(fixture.snapshot()));
    const meta = { ezCallId: fixture.token, expectedReleaseBinding };
    expect((await fixture.process.callTool("read", {}, meta)).isError).toBe(false);
    fixture.mutate(value => { value.installation.grants = []; });
    await expect(fixture.process.callTool("read", {}, meta)).rejects.toMatchObject({ code: "RELEASE_CHANGED" });
    fixture.mutate(value => { value.installation.grants = ["storage"]; value.installation.generation = 2; value.installation.acknowledgedGeneration = 2; });
    await expect(fixture.process.callTool("read", {}, meta)).rejects.toMatchObject({ code: "RELEASE_CHANGED" });
    expect(fixture.starts).toHaveLength(1);
  } finally { fixture.cleanup(); }
});
