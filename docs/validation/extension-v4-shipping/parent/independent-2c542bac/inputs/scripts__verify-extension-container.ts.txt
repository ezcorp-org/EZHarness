import { strict as assert } from "node:assert";
import { HarnessClient } from "../packages/@ezcorp/harness-client/src/index";
import type { InstallationState, LifecycleApproval, LifecycleOperation, WorkspaceRecord } from "../src/extensions/v4/types";

const origin = "http://127.0.0.1:3000";
const deadline = Date.now() + 120_000;
while (true) {
  try {
    const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (health.ok) break;
  } catch (error) {
    if (Date.now() >= deadline) throw error;
  }
  assert(Date.now() < deadline, "Container health deadline exceeded");
  await Bun.sleep(100);
}

const setup = await fetch(`${origin}/api/auth/setup`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ name: "Container verification", email: "container-verification@example.test", password: `${crypto.randomUUID()}-A1!` }),
});
assert.equal(setup.status, 201, "Run only against a fresh disposable container");
const cookie = setup.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
assert(cookie.length > 0, "Setup must issue an authenticated session");
async function sessionPost(path: string, input: unknown, status = 200) {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(input) });
  assert.equal(response.status, status, `Unexpected status from ${path}`);
  return response.json();
}
const keyResponse = await sessionPost("/api/settings/developer/api-keys", { name: "Container verification", scopes: ["read", "chat", "extensions"] }, 201);
assert(keyResponse && typeof keyResponse === "object" && "key" in keyResponse && typeof keyResponse.key === "string", "API key response must contain a key");
const key = keyResponse.key;
const client = new HarnessClient({ baseUrl: origin, apiKey: key });
const name = `image-check-${Date.now().toString(36)}`;
const created = await client.extensionControl<{ installation: { id: string }; workspace: WorkspaceRecord }>("extensions_workspace", { action: "create", name });
const installationId = created.installation.id;
const operation = await client.extensionControl<LifecycleOperation>("extensions_build", { installationId, workspaceId: created.workspace.id, expectedRevision: created.workspace.revision, idempotencyKey: crypto.randomUUID() });
let state: InstallationState;
const buildDeadline = Date.now() + 240_000;
while (true) {
  state = await client.extensionControl<InstallationState>("extensions_inspect", { installationId, operationId: operation.id, waitMs: 1000 });
  const build = state.operations[operation.id]!;
  if (!["queued", "building", "verifying"].includes(build.state)) {
    assert.equal(build.state, "verified", JSON.stringify(build.diagnostics));
    break;
  }
  assert(Date.now() < buildDeadline, "Build deadline exceeded");
}
const release = Object.values(state.releases)[0]!;
assert.equal(release.runnerProfile, "rootless-podman-v4");
const { approval } = await client.extensionControl<{ approval: LifecycleApproval }>("extensions_release", { action: "requestApproval", installationId, releaseId: release.id, expectedActiveReleaseId: null });
await sessionPost(`/api/extensions/releases/${installationId}/approve`, { approvalId: approval.id, decision: true });
await client.extensionControl("extensions_release", { action: "activate", installationId, approvalId: approval.id, idempotencyKey: crypto.randomUUID() });
const conversation = await client.createConversation({ title: "Container isolated invocation" });
assert.deepEqual((await client.wireExtensions(conversation.id, [name])).wired, [name]);
const marker = `isolated-container-result-${crypto.randomUUID()}`;
const result = await client.invokeExtensionTool(conversation.id, name, "echo", { text: marker });
assert.equal(result.success, true);
assert(JSON.stringify(result.output).includes(marker));
await client.extensionControl("extensions_release", { action: "disable", installationId });
await assert.rejects(() => client.invokeExtensionTool(conversation.id, name, "echo", { text: marker }));
await client.extensionControl("extensions_release", { action: "uninstall", installationId });
const retained = await client.extensionControl<InstallationState>("extensions_inspect", { installationId });
assert.equal(retained.installation.uninstalled, true);
assert.equal(retained.releases[release.id]!.releaseDigest, release.releaseDigest);
console.log(JSON.stringify({ passed: true, profile: release.runnerProfile, checks: ["production-boot", "file-credential", "real-isolated-build", "human-approval", "activation", "tool-invocation", "disable-denial", "retained-history"] }));
