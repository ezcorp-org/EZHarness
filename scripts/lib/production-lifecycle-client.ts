import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { HarnessClient } from "@ezcorp/harness-client";
import type { InstallationRecord, InstallationState, LifecycleApproval, LifecycleOperation, WorkspaceRecord } from "../../src/extensions/v4/types";

export function required(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}

export async function command(binary: string, args: string[]): Promise<string> {
  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(exit, 0, `${binary} ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}

export async function readSessionCookie(file: string): Promise<string> {
  const cookies = (await readFile(file, "utf8")).split("\n").flatMap(raw => {
    const line = raw.startsWith("#HttpOnly_") ? raw.slice("#HttpOnly_".length) : raw;
    if (!line || line.startsWith("#")) return [];
    const fields = line.split("\t");
    assert(fields.length === 7 && fields[5] && fields[6], "Invalid session cookie record");
    return [`${fields[5]}=${fields[6]}`];
  });
  assert(cookies.length, "The launcher must provide a human session cookie");
  return cookies.join("; ");
}

type SessionRequest = { method?: string; body?: unknown; headers?: Record<string, string> };

export async function productionLifecycleClient() {
  const origin = required("EZ_PRODUCTION_ORIGIN");
  const cookie = await readSessionCookie(required("EZ_PRODUCTION_COOKIE_FILE"));
  const apiKey = (await readFile(required("EZ_PRODUCTION_API_KEY_FILE"), "utf8")).trim();
  assert(apiKey, "The launcher must provide an API key");
  const client = new HarnessClient({ baseUrl: origin, apiKey });
  async function sessionJson<T = unknown>(path: string, options: SessionRequest = {}): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: { cookie, origin, ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`);
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }
  async function inspect(installationId: string): Promise<InstallationState> {
    return client.extensionControl<InstallationState>("extensions_inspect", { installationId });
  }
  async function waitVerified(installationId: string, operationId: string): Promise<InstallationState> {
    const deadline = Date.now() + 360_000;
    while (Date.now() < deadline) {
      const state = await client.extensionControl<InstallationState>("extensions_inspect", { installationId, operationId, waitMs: 30_000 });
      const operation = state.operations[operationId];
      assert(operation, "The build operation disappeared");
      if (["queued", "building", "verifying"].includes(operation.state)) continue;
      assert.equal(operation.state, "verified", JSON.stringify(operation.diagnostics));
      assert(operation.releaseId && state.releases[operation.releaseId], "Verified operation has no release");
      return state;
    }
    throw new Error(`Build ${operationId} did not finish within six minutes`);
  }
  async function approveAndActivate(installationId: string, releaseId: string, expectedActiveReleaseId: string | null): Promise<InstallationState> {
    const { approval } = await client.extensionControl<{ approval: LifecycleApproval }>("extensions_release", { action: "requestApproval", installationId, releaseId, expectedActiveReleaseId });
    await sessionJson(`/api/extensions/releases/${installationId}/approve`, { body: { approvalId: approval.id, decision: true } });
    const activation = await client.extensionControl<LifecycleOperation>("extensions_release", { action: "activate", installationId, approvalId: approval.id, idempotencyKey: crypto.randomUUID() });
    assert.equal(activation.state, "active", JSON.stringify(activation.diagnostics));
    const state = await inspect(installationId);
    assert.equal(state.installation.activeReleaseId, releaseId);
    assert.equal(state.installation.enabled, true);
    return state;
  }
  async function createBuild(name: string, files: Record<string, string>) {
    const created = await client.extensionControl<{ installation: InstallationRecord; workspace: WorkspaceRecord }>("extensions_workspace", { action: "create", name, writes: files });
    const operation = await client.extensionControl<LifecycleOperation>("extensions_build", { installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: created.workspace.revision, idempotencyKey: crypto.randomUUID() });
    const state = await waitVerified(created.installation.id, operation.id);
    return { ...created, operation: state.operations[operation.id]!, state, release: state.releases[state.operations[operation.id]!.releaseId!]! };
  }
  return { origin, cookie, client, sessionJson, inspect, waitVerified, approveAndActivate, createBuild };
}
