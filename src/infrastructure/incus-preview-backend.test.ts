import { expect, test } from "bun:test";
import type { ProviderSandboxWorkspaceCaller } from "../runtime/workspaces/provider-backend";
import type { SandboxPreviewServeRequest, SandboxWorkspaceBinding } from "../runtime/workspaces/target";
import { IncusSandboxPreviewBackend } from "./incus-preview-backend";

const binding: SandboxWorkspaceBinding = {
  projectId: "project-a", workspaceId: "binding-a", connectionId: "connection-a", providerId: "incus",
  generation: 2, presetId: "compose", releaseDigest: "a".repeat(64), presetDigest: "b".repeat(64),
  effectiveSettingsDigest: "c".repeat(64),
};
const expiresAt = new Date(Date.now() + 60_000);

function preview(request: Request, targetPort = 3000): SandboxPreviewServeRequest {
  return { binding, previewId: "preview-a", userId: "user-a", targetPort, requestPath: new URL(request.url).pathname,
    request, expiresAt };
}

test("sandbox preview open accepts only a current bounded endpoint", async () => {
  let calls = 0;
  const now = 1_000_000;
  const backend = new IncusSandboxPreviewBackend({ call: async () => { calls++; return {}; } }, () => now);
  const valid = { binding, previewId: "preview-a", userId: "user-a", conversationId: "conversation-a",
    targetPort: 3000, expiresAt: new Date(now + 60_000) };
  await backend.open(valid);
  await expect(backend.open({ ...valid, targetPort: 80 })).rejects.toThrow("port");
  await expect(backend.open({ ...valid, expiresAt: new Date(now) })).rejects.toThrow("expiry");
  await expect(backend.open({ ...valid, expiresAt: new Date(now + 24 * 60 * 60 * 1000 + 1) }))
    .rejects.toThrow("expiry");
  expect(calls).toBe(0);
});

test("sandbox preview uses only the approved guest process and a pinned loopback port", async () => {
  const body = Buffer.from(JSON.stringify({ status: 200, headers: [["content-type", "text/plain"], ["set-cookie", "site=ok; Domain=app.example"]],
    body: Buffer.from("guest page").toString("base64") }));
  const calls: Array<Parameters<ProviderSandboxWorkspaceCaller["call"]>[0]> = [];
  const caller: ProviderSandboxWorkspaceCaller = { call: async input => {
    calls.push(input);
    if (input.action === "process.start") return { ok: true, processId: "process-a", bootId: "boot-a" };
    if (input.action === "process.inspect") return { ok: true, process: { state: "succeeded" } };
    if (input.action === "process.readOutput") return { ok: true, chunks: [{ stream: "stdout", dataBase64: body.toString("base64") }], eof: true };
    throw new Error("Unexpected guest action");
  } };
  const backend = new IncusSandboxPreviewBackend(caller);
  const request = new Request("https://preview.example/page?x=1", { headers: {
    Accept: "text/html", Cookie: "app-session=secret", Authorization: "Bearer secret", "X-Forwarded-Host": "attacker.example",
  } });
  const response = await backend.serve(preview(request));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("guest page");
  expect(calls.map(call => call.action)).toEqual(["process.start", "process.inspect", "process.readOutput"]);
  expect(calls.every(call => call.binding === binding)).toBe(true);
  const start = calls[0]!.payload;
  expect(start.argv).toBeArray();
  expect((start.argv as string[])[2]).toContain('HTTPConnection("127.0.0.1"');
  const encoded = (start.env as Array<{ value: string }>)[0]!.value;
  const sent = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  expect(sent).toMatchObject({ port: 3000, method: "GET", path: "/page?x=1", headers: [["accept", "text/html"]] });
  expect(JSON.stringify(sent)).not.toContain("secret");
  expect(JSON.stringify(sent)).not.toContain("attacker.example");
});

test("sandbox preview refuses unsafe ports, methods, expiry, and oversized bodies before guest effects", async () => {
  let calls = 0;
  const backend = new IncusSandboxPreviewBackend({ call: async () => { calls++; return {}; } });
  await expect(backend.serve(preview(new Request("https://preview.example/"), 844))).rejects.toThrow("port");
  await expect(backend.serve(preview(new Request("https://preview.example/", { method: "OPTIONS" })))).rejects.toThrow("unavailable");
  await expect(backend.serve({ ...preview(new Request("https://preview.example/")), expiresAt: new Date(0) })).rejects.toThrow("unavailable");
  await expect(backend.serve(preview(new Request("https://preview.example/", { method: "POST", body: "x".repeat(4097) })))).rejects.toThrow("too large");
  expect(calls).toBe(0);
});

test("sandbox preview rejects truncated guest output and never returns it as a browser response", async () => {
  const backend = new IncusSandboxPreviewBackend({ call: async input => {
    if (input.action === "process.start") return { ok: true, processId: "process-a", bootId: "boot-a" };
    if (input.action === "process.inspect") return { ok: true, process: { state: "succeeded" } };
    return { ok: true, chunks: [], eof: true, gap: { reason: "overflow" } };
  } });
  await expect(backend.serve(preview(new Request("https://preview.example/")))).rejects.toThrow("incomplete");
});

test("fixed guest script makes one real loopback request and does not follow a redirect", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    requests++;
    return new Response("go", { status: 302, headers: { Location: "https://outside.example/" } });
  } });
  try {
    let output = "";
    const caller: ProviderSandboxWorkspaceCaller = { call: async input => {
      if (input.action === "process.start") {
        const argv = input.payload.argv as string[];
        const env = input.payload.env as Array<{ name: string; value: string }>;
        const child = Bun.spawn(argv, { env: { ...process.env, [env[0]!.name]: env[0]!.value }, stdout: "pipe", stderr: "pipe" });
        output = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        return { ok: true, processId: "process-a", bootId: "boot-a" };
      }
      if (input.action === "process.inspect") return { ok: true, process: { state: "succeeded" } };
      return { ok: true, chunks: [{ stream: "stdout", dataBase64: Buffer.from(output).toString("base64") }], eof: true };
    } };
    const response = await new IncusSandboxPreviewBackend(caller).serve(preview(new Request("https://preview.example/"), server.port));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://outside.example/");
    expect(requests).toBe(1);
  } finally { server.stop(true); }
});
