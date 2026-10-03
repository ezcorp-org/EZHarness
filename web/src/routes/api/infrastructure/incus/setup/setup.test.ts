import { expect, test } from "bun:test";
import { GET, POST } from "./+server";

function event(locals: Record<string, unknown>, body?: unknown): Parameters<typeof POST>[0] {
  return { locals, url: new URL("http://localhost/api/infrastructure/incus/setup"),
    request: new Request("http://localhost/api/infrastructure/incus/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }) } as unknown as Parameters<typeof POST>[0];
}

test("Incus setup rejects anonymous callers, API keys, and non-admin sessions before reading host config", async () => {
  const anonymous = await GET(event({}));
  expect(anonymous.status).toBe(401);
  const key = await POST(event({ user: { id: "admin", role: "admin" }, authMethod: "api-key" }, { action: "plan", installationId: "provider" }));
  expect(key.status).toBe(403);
  const member = await POST(event({ user: { id: "member", role: "member" }, authMethod: "session" }, { action: "plan", installationId: "provider" }));
  expect(member.status).toBe(403);
});

test("Incus setup rejects browser-supplied SSH paths and private keys", async () => {
  const administrator = { user: { id: "admin", role: "admin" }, authMethod: "session" };
  for (const injected of [
    { action: "plan", installationId: "provider", sshIdentityFile: "/tmp/attacker" },
    { action: "apply", setupId: "setup", planDigest: "a".repeat(64), privateKeyPem: "secret" },
    { action: "probe", setupId: "setup", endpoint: "https://attacker.example" },
  ]) {
    const response = await POST(event(administrator, injected));
    expect(response.status).toBe(400);
  }
});
