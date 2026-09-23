import { afterAll, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import type { IncusTransportRequest } from "../../../extensions/incus-sandbox/transport";
import { guestHelperSha256, GUEST_HELPER_VERSION } from "../incus-guest/protocol";
import { HostIncusGuestTransport } from "./guest";
import { resourceName, type Session } from "./lifecycle";
import type { PinnedWebSocket } from "./pinned-websocket";
import { makeTestCertificates } from "./test-certificates";

const certificates = makeTestCertificates();
afterAll(() => certificates.dispose());
const cert = certificates.read("server-cert.pem");
const fingerprint = createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
const sandboxId = "sandbox-a";
const sandboxName = resourceName("connection-a", sandboxId);
const scope = { providerInstallationId: "installation-a", providerReleaseId: "release-a", revision: 1,
  approvedPreset: { profile: "linux-exec.v1", incusProfile: "ezharness", presetId: "incus-linux-exec-v1", presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64), imageFingerprint: "c".repeat(64), limits: { memoryBytes: 4_294_967_296, cpuMillis: 2_000, pids: 1024, diskBytes: 21_474_836_480 } },
  approvedGuest: { user: "sandbox", uid: 1000, gid: 1000, helperSha256: guestHelperSha256() } };
const connection = { endpoint: "https://127.0.0.1:8443", project: "sandbox", serverCertificatePem: cert, clientCertificatePem: "client", privateKeyPem: "private" };
const command: IncusTransportRequest = { action: "helper.file.stat", connectionId: "connection-a", deadlineMs: Date.now() + 30_000,
  pins: { connectionId: "connection-a", serverCertificateSha256: fingerprint, project: "sandbox", profile: "ezharness", helperVersion: GUEST_HELPER_VERSION, guestUser: "sandbox" },
  tags: { managedBy: "ezharness-incus-sandbox", connectionId: "connection-a", sandboxId }, sandboxName,
  payload: { path: "src/app.ts", user: "root", sandboxId: "forged" } };
const opId = "11111111-1111-1111-1111-111111111111";
const token = "a".repeat(64);
const envelope = (metadata: unknown, status = 200) => Response.json({ type: status === 202 ? "async" : "sync", metadata, status_code: status }, { status });
const instance = { name: sandboxName, status: "Running", profiles: ["ezharness"], config: { "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": "connection-a", "user.ezharness.sandbox_id": sandboxId, "volatile.base_image": "c".repeat(64) } };
function execResponse() { return envelope({ id: opId, resources: { instances: [`/1.0/instances/${sandboxName}`] }, metadata: { fds: { "0": token, "1": token, "2": token, control: token } } }, 202); }
function fixture(output: unknown = { version: GUEST_HELPER_VERSION, ok: true, file: { path: "src/app.ts", kind: "file", revision: "rev", sizeBytes: 1, executable: false } }) {
  const routes: string[] = [];
  let requestBytes: Buffer | undefined;
  const http = async (url: string, init: RequestInit) => {
    routes.push(`${init.method} ${new URL(url).pathname}`);
    if (new URL(url).pathname.endsWith("/exec")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.command).toEqual(["/usr/local/libexec/ezharness-helper"]);
      expect(body.user).toBe(1000);
      expect(body["record-output"]).toBe(false);
      return execResponse();
    }
    if (new URL(url).pathname.endsWith("/wait")) return envelope({ id: opId, status: "Success", metadata: { return: 0 } });
    return envelope(instance);
  };
  let channel = 0;
  const websocket = async (_session: Session, id: string, secret: string): Promise<PinnedWebSocket> => {
    expect(id).toBe(opId);
    expect(secret).toBe(token);
    const index = channel++ % 4;
    return { send(data) { requestBytes = data; }, finish() {}, readAll: async () => index === 1 ? Buffer.from(JSON.stringify(output)) : Buffer.alloc(0), close() {} };
  };
  const transport = new HostIncusGuestTransport({ resolveForHost: async () => connection }, scope, http as never, websocket);
  return { transport, routes, request: () => requestBytes };
}

test("helper invocation fixes path, UID, guest user, and sandbox ID", async () => {
  const { transport, routes, request } = fixture();
  const result = await transport.request(command) as Record<string, unknown>;
  expect(result.ok).toBe(true);
  expect(routes).toEqual([`GET /1.0/instances/${sandboxName}`, `POST /1.0/instances/${sandboxName}/exec`, `GET /1.0/operations/${opId}/wait`]);
  expect(JSON.parse(request()!.toString())).toMatchObject({ action: "file.stat", user: "sandbox", sandboxId });
});

test("missing helper approval, wrong version, and forged sandbox name fail before HTTP", async () => {
  for (const changed of [
    { scope: { ...scope, approvedGuest: undefined }, command },
    { scope, command: { ...command, pins: { ...command.pins, helperVersion: "changed" } } },
    { scope, command: { ...command, sandboxName: "forged" } },
  ]) {
    let calls = 0;
    const transport = new HostIncusGuestTransport({ resolveForHost: async () => connection }, changed.scope,
      (async () => { calls++; return envelope(instance); }) as never);
    await expect(transport.request(changed.command)).rejects.toMatchObject({ kind: "permission", effect: "none" });
    expect(calls).toBe(0);
  }
});

test("helper version mismatch and oversized response fail closed", async () => {
  for (const output of [{ version: "other", ok: true }, Buffer.alloc(2 * 1024 * 1024 + 1)]) {
    const { transport } = fixture(output);
    await expect(transport.request(command)).rejects.toMatchObject({ kind: output instanceof Buffer ? "resource_exhausted" : "unsupported" });
  }
});

test("stopped or replaced image never executes helper", async () => {
  for (const value of [{ ...instance, status: "Stopped" }, { ...instance, config: { ...instance.config, "volatile.base_image": "d".repeat(64) } }]) {
    let requests = 0;
    const transport = new HostIncusGuestTransport({ resolveForHost: async () => connection }, scope,
      (async () => { requests++; return envelope(value); }) as never);
    await expect(transport.request(command)).rejects.toMatchObject({ kind: "permission" });
    expect(requests).toBe(1);
  }
});

test("missing helper executable fails closed after fixed exec", async () => {
  const http = async (url: string) => {
    const route = new URL(url).pathname;
    if (route.endsWith("/exec")) return execResponse();
    if (route.endsWith("/wait")) return envelope({ id: opId, status: "Failure", metadata: { return: 127 } });
    return envelope(instance);
  };
  const websocket = async (_session: Session, _id: string, _secret: string): Promise<PinnedWebSocket> => ({
    send() {}, finish() {}, readAll: async () => Buffer.alloc(0), close() {},
  });
  const transport = new HostIncusGuestTransport({ resolveForHost: async () => connection }, scope, http as never, websocket);
  await expect(transport.request(command)).rejects.toMatchObject({ kind: "unsupported" });
});

test("guest mutation timeout has stable unknown identity", async () => {
  let execCalls = 0;
  const http = async (url: string) => {
    if (new URL(url).pathname.endsWith("/exec")) { execCalls++; return new Promise<Response>(() => undefined); }
    return envelope(instance);
  };
  const transport = new HostIncusGuestTransport({ resolveForHost: async () => connection }, scope, http as never);
  const failure = await transport.request({ ...command, action: "helper.process.start", deadlineMs: Date.now() + 50,
    idempotency: { requestId: "request-a", key: "key-a" }, payload: { argv: ["bun", "test"], cwd: ".", env: [], processDeadlineMs: Date.now() + 1000 } })
    .catch((error: unknown) => error) as { kind: string; effect: string; operationId: string };
  expect(failure).toMatchObject({ kind: "deadline", effect: "unknown" });
  expect(failure.operationId).toMatch(/^ezh-guest-/);
  expect(execCalls).toBe(1);
}, 2_000);

test("file removal returns a scoped provider receipt", async () => {
  const { transport, request } = fixture({ version: GUEST_HELPER_VERSION, ok: true, removedRevision: "old-revision" });
  const result = await transport.request({ ...command, action: "helper.file.remove", idempotency: { requestId: "request-a", key: "key-a" },
    payload: { path: "src/app.ts", expectedRevision: "old-revision", recursive: false } }) as { receipt: Record<string, unknown> };
  expect(result.receipt).toMatchObject({ kind: "fileRemove", sandboxId, requestId: "request-a", idempotencyKey: "key-a" });
  expect(JSON.parse(request()!.toString())).toMatchObject({ requestId: "request-a", idempotencyKey: "key-a", sandboxId });
});

test("malformed process start response after exec acceptance remains unknown", async () => {
  const { transport } = fixture({ version: "wrong", ok: true, processId: "untrusted" });
  const failure = await transport.request({ ...command, action: "helper.process.start", idempotency: { requestId: "request-a", key: "key-a" },
    payload: { argv: ["bun", "test"], cwd: ".", env: [], processDeadlineMs: Date.now() + 60_000 } })
    .catch((error: unknown) => error) as { kind: string; effect: string; operationId: string };
  expect(failure).toMatchObject({ kind: "unsupported", effect: "unknown" });
  expect(failure.operationId).toMatch(/^ezh-guest-/);
});
