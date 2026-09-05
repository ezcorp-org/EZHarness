import { expect, test } from "bun:test";
import type { InvocationContext, ReleaseRecord, Runner, StartRequest, ReverseRpc } from "@ezcorp/extension-contract";
import { createCandidateVerificationBroker } from "./candidate-verification-broker";
import { verifyExtensionCandidate } from "./extension-lifecycle-service";

const release = {
  id: "release", artifactDigest: "a".repeat(64),
  manifest: { schemaVersion: 4, name: "candidate-fixture", version: "1.0.0", description: "Fixture", author: { name: "Test" }, permissions: { filesystem: ["/project", "/data"], storage: true, network: ["example.com"], env: ["GITHUB_TOKEN"] }, tools: [{ name: "smoke", description: "Test", inputSchema: { type: "object" }, outputSchema: { type: "object" } }], smokeTest: { tool: "smoke", input: {}, expect: {} } },
} as unknown as ReleaseRecord;
function invocation(): InvocationContext { return { invocationId: crypto.randomUUID(), workerId: crypto.randomUUID(), releaseId: release.id, principalId: "extension-verification", scopeId: `verification:${crypto.randomUUID()}`, token: crypto.randomUUID(), deadline: Date.now() + 60_000 }; }

test("real filesystem and storage handlers run only inside isolated candidate roots and namespaces", async () => {
  const context = invocation();
  const broker = await createCandidateVerificationBroker(release, context, { projectFiles: { "nested/example.txt": "fixture data" } });
  broker.begin("smoke");
  const call = (method: string, input: unknown) => broker.reverseRpc(method, { input, context });
  try {
    expect(await call("ezcorp/fs.read", { path: "/project/nested/example.txt" })).toMatchObject({ body: Buffer.from("fixture data").toString("base64") });
    expect(await call("ezcorp/fs.write", { path: "/data/out.txt", content: "saved" })).toMatchObject({ bytes: 5 });
    expect(await call("ezcorp/storage", { action: "set", scope: "user", key: "secret", value: "fixture-secret", encrypted: true })).toMatchObject({ ok: true });
    expect(await call("ezcorp/storage", { action: "get", scope: "user", key: "secret" })).toMatchObject({ value: "fixture-secret" });
    expect(broker.coverage()).toContainEqual({ capability: "storage", state: "tested", calls: 2 });
    expect(broker.coverage()).toContainEqual({ capability: "network", state: "unexercised", calls: 0 });
  } finally { await broker.close(); }
  await expect(call("ezcorp/fs.read", { path: "/data/out.txt" })).rejects.toMatchObject({ code: "test_effect_denied" });
});

test("network broker uses exact explicit fixtures and never opens a real connection", async () => {
  const context = invocation();
  const broker = await createCandidateVerificationBroker(release, context, { network: [{ url: "https://example.com/status", method: "GET", status: 200, body: "fixture response" }] });
  broker.begin("smoke");
  try {
    const response = await broker.reverseRpc("ezcorp/network.fetch", { context, input: { url: "https://example.com/status" } });
    expect(response).toMatchObject({ status: 200, body: Buffer.from("fixture response").toString("base64") });
    await expect(broker.reverseRpc("ezcorp/network.fetch", { context, input: { url: "https://example.com/unconfigured" } })).rejects.toMatchObject({ code: "test_capability_denied" });
    await expect(broker.reverseRpc("ezcorp/network.fetch", { context, input: { url: "http://127.0.0.1/" } })).rejects.toMatchObject({ code: "test_capability_denied" });
    expect(broker.coverage()).toContainEqual({ capability: "network", state: "denied", calls: 3 });
  } finally { await broker.close(); }
});

test("production credential policy issues only fixture handles in test scope", async () => {
  const context = invocation();
  const broker = await createCandidateVerificationBroker(release, context);
  broker.begin("smoke");
  try {
    const handle = await broker.reverseRpc("ezcorp/env.get", { context, input: { name: "GITHUB_TOKEN" } });
    expect(handle).toMatch(/^ezcred_v4_[a-f0-9]{64}$/);
    expect(handle).not.toContain("verification-only");
    await expect(broker.reverseRpc("ezcorp/env.get", { context, input: { name: "OPENAI_API_KEY" } })).rejects.toMatchObject({ code: "test_capability_denied" });
  } finally { await broker.close(); }
});

test("wrong worker, scope, expired invocation and registration effects are denied", async () => {
  const context = invocation();
  const broker = await createCandidateVerificationBroker(release, context);
  const request = { context, input: { action: "get", key: "value" } };
  try {
    await expect(broker.reverseRpc("ezcorp/storage", request)).rejects.toMatchObject({ code: "test_effect_denied" });
    broker.begin("smoke");
    for (const field of ["workerId", "scopeId", "token", "releaseId"]) await expect(broker.reverseRpc("ezcorp/storage", { ...request, context: { ...context, [field]: "different" } })).rejects.toMatchObject({ code: "test_context_mismatch" });
    await expect(broker.reverseRpc("ezcorp/storage", { ...request, context, extra: true })).rejects.toMatchObject({ code: "test_context_mismatch" });
    context.deadline = 0;
    await expect(broker.reverseRpc("ezcorp/storage", request)).rejects.toMatchObject({ code: "test_effect_denied" });
  } finally { await broker.close(); }
});

test("separate candidate sessions do not share storage, files or credential identities", async () => {
  const firstContext = invocation();
  const secondContext = invocation();
  const first = await createCandidateVerificationBroker(release, firstContext);
  const second = await createCandidateVerificationBroker(release, secondContext);
  first.begin("smoke"); second.begin("smoke");
  try {
    await first.reverseRpc("ezcorp/storage", { context: firstContext, input: { action: "set", key: "value", value: "private" } });
    expect(await second.reverseRpc("ezcorp/storage", { context: secondContext, input: { action: "get", key: "value" } })).toMatchObject({ exists: false });
    await expect(second.reverseRpc("ezcorp/storage", { context: firstContext, input: { action: "get", key: "value" } })).rejects.toMatchObject({ code: "test_context_mismatch" });
  } finally { await first.close(); await second.close(); }
});

test("service evidence reports tested and unexercised capabilities and cannot hide denied calls", async () => {
  let hideDenied = false;
  let closed = 0;
  const runner = { async start(input: StartRequest, reverseRpc: ReverseRpc) { return { workerId: input.workerId, onNotification: () => () => {}, close: async () => { closed++; }, request: async (method: string) => {
    if (method === "extension/discover") return release.manifest;
    if (hideDenied) await expect(reverseRpc("ezcorp/shell", { context: input.context, input: { command: "dangerous" } })).rejects.toMatchObject({ code: "test_effect_denied" });
    else await reverseRpc("ezcorp/storage", { context: input.context, input: { action: "set", key: "test", value: 1 } });
    return {};
  } }; } } as unknown as Runner;
  const report = await verifyExtensionCandidate(runner, release);
  expect(report.smoke).toBe("passed");
  expect(report.capabilities).toContainEqual({ capability: "storage", state: "tested", calls: 1 });
  expect(report.capabilities).toContainEqual({ capability: "network", state: "unexercised", calls: 0 });
  hideDenied = true;
  await expect(verifyExtensionCandidate(runner, release)).rejects.toMatchObject({ code: "candidate_capability_blocked" });
  expect(closed).toBe(2);
});

test("fixture storage preserves scope separation, TTL expiry, list limits and deletion", async () => {
  const context = invocation();
  const broker = await createCandidateVerificationBroker(release, context);
  broker.begin("smoke");
  const call = (input: unknown) => broker.reverseRpc("ezcorp/storage", { context, input });
  try {
    for (const scope of ["global", "user", "conversation"]) await call({ action: "set", scope, key: "shared", value: scope });
    for (const scope of ["global", "user", "conversation"]) expect(await call({ action: "get", scope, key: "shared" })).toMatchObject({ value: scope });
    await call({ action: "set", scope: "user", key: "short-lived", value: true, ttlSeconds: 0.001 });
    await Bun.sleep(5);
    expect(await call({ action: "get", scope: "user", key: "short-lived" })).toMatchObject({ exists: false });
    expect(await call({ action: "list", scope: "user", prefix: "sha", limit: 1 })).toMatchObject({ keys: [{ key: "shared" }] });
    expect(await call({ action: "delete", scope: "user", key: "shared" })).toMatchObject({ deleted: true });
    expect(await call({ action: "delete", scope: "user", key: "shared" })).toMatchObject({ deleted: false });
    expect(await call({ action: "get", scope: "conversation", key: "shared" })).toMatchObject({ value: "conversation" });
  } finally { await broker.close(); }
});

test("fixture construction rejects traversal and non-verification identities", async () => {
  for (const patch of [{ releaseId: "different" }, { scopeId: "global" }, { principalId: "production-owner" }]) await expect(createCandidateVerificationBroker(release, { ...invocation(), ...patch })).rejects.toMatchObject({ code: "invalid_verification_context" });
  await expect(createCandidateVerificationBroker(release, invocation(), { dataFiles: { "../outside": "must not write" } })).rejects.toThrow();
  const context = invocation();
  const broker = await createCandidateVerificationBroker(release, context);
  expect(() => broker.begin("undeclared")).toThrow();
  broker.begin("smoke");
  try {
    for (const raw of [null, [], { context, input: [] }, { context, input: null }]) await expect(broker.reverseRpc("ezcorp/storage", raw)).rejects.toMatchObject({ code: "test_context_mismatch" });
    await expect(broker.reverseRpc("ezcorp/fs.read", { context, input: { path: "/etc/passwd" } })).rejects.toMatchObject({ code: "test_capability_denied" });
    await broker.reverseRpc("ezcorp/fs.write", { context, input: { path: "/data/safe", content: "safe", _toolName: "undeclared", _meta: { ezCallId: "forged" } } });
    expect(broker.coverage()).toContainEqual({ capability: "filesystem", state: "denied", calls: 2 });
    const copy = broker.coverage();
    copy.length = 0;
    expect(broker.coverage().length).toBeGreaterThan(0);
  } finally { await broker.close(); }
  expect(() => broker.begin("smoke")).toThrow();
  await broker.close();
});

test("chunked network fixtures are bound to their invocation and offsets", async () => {
  const context = invocation();
  const otherContext = invocation();
  const body = "fixture".repeat(50_000);
  const broker = await createCandidateVerificationBroker(release, context, { network: [{ url: "https://example.com/large", method: "POST", requestBody: "input", status: 200, body }] });
  const other = await createCandidateVerificationBroker(release, otherContext);
  broker.begin("smoke"); other.begin("smoke");
  try {
    const response = await broker.reverseRpc("ezcorp/network.fetch", { context, input: { url: "https://example.com/large", init: { method: "POST", body: Buffer.from("input").toString("base64") } } }) as { bodyId: string; bodyBytes: number };
    expect(response.bodyBytes).toBe(body.length);
    await expect(other.reverseRpc("ezcorp/network.read", { context: otherContext, input: { bodyId: response.bodyId, offset: 0 } })).rejects.toMatchObject({ code: "test_capability_denied" });
    let result = "";
    let done = false;
    while (!done) {
      const chunk = await broker.reverseRpc("ezcorp/network.read", { context, input: { bodyId: response.bodyId, offset: result.length } }) as { body: string; done: boolean };
      result += Buffer.from(chunk.body, "base64").toString("utf8");
      done = chunk.done;
    }
    expect(result).toBe(body);
    await expect(broker.reverseRpc("ezcorp/network.read", { context, input: { bodyId: response.bodyId, offset: 0 } })).rejects.toMatchObject({ code: "test_capability_denied" });
  } finally { await broker.close(); await other.close(); }
});
