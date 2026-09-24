import { expect, test } from "bun:test";
import { GET, POST } from "./+server";

const admin = { user: { id: "admin", role: "admin" }, authMethod: "session" };
const url = "http://localhost/api/infrastructure/incus/capacity";

function event(locals: Record<string, unknown>, body: unknown, origin: string | null = "http://localhost",
  contentType = "application/json"): Parameters<typeof POST>[0] {
  return { locals, request: new Request(url, { method: "POST", headers: { "content-type": contentType,
    ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }) } as unknown as Parameters<typeof POST>[0];
}

test("capacity Plan and Apply require a same-origin admin session", async () => {
  const body = { action: "plan", setupId: "setup" };
  expect((await POST(event({}, body))).status).toBe(401);
  expect((await POST(event({ ...admin, authMethod: "api-key" }, body))).status).toBe(403);
  expect((await POST(event({ user: { id: "member", role: "member" }, authMethod: "session" }, body))).status).toBe(403);
  expect((await POST(event(admin, body, "https://other.example"))).status).toBe(403);
  expect((await POST(event(admin, body, null))).status).toBe(403);
  expect((await POST(event(admin, body, "http://localhost", "text/plain"))).status).toBe(400);
  expect((await GET({ locals: {}, url: new URL(`${url}?setupId=setup`) } as Parameters<typeof GET>[0])).status).toBe(401);
});

test("capacity route rejects extra authority, invalid plans, and oversized JSON before service access", async () => {
  for (const body of [
    { action: "plan", setupId: "setup", host: "other" },
    { action: "plan", setupId: "../setup" },
    { action: "apply", plan: {}, planDigest: "bad" },
    { action: "apply", plan: "bad", planDigest: "a".repeat(64) },
    { action: "other", setupId: "setup" },
  ]) expect((await POST(event(admin, body))).status).toBe(400);
  const oversized = { action: "plan", setupId: "setup", padding: "x".repeat(20_000) };
  expect((await POST(event(admin, oversized))).status).toBe(400);
  expect((await GET({ locals: admin, url: new URL(`${url}?setupId=../bad`) } as Parameters<typeof GET>[0])).status).toBe(400);
});
