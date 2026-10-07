import { createHash, randomBytes } from "node:crypto";
import type { IncusTransportRequest } from "../../../extensions/incus-sandbox/transport";
import { sameSandboxWorkspaceBinding, type SandboxWorkspaceBinding } from "../../runtime/workspaces/target";
import { parseGuestExecOperation } from "./guest";
import { MAX_PREVIEW_SESSION_MS, metadata, resourceName, withPreviewSession } from "./lifecycle";
import { openPinnedWebSocket, type PinnedWebSocket } from "./pinned-websocket";
import { encodeMaskedPreviewFrame, MAX_PREVIEW_FRAME_BYTES, readUnmaskedPreviewFrame } from "./preview-websocket-codec";
import { object, verifiedHttpsRequest, type HostConnectionResolver, type HostConnectionScope, type PinnedFetch } from "./transport";

const MAX_TOTAL = 4 * 1024 * 1024;
const MAX_FRAMES = 1024;
const MAX_HEADER = 8 * 1024;
const MAX_CONNECTIONS = 4;
const MAX_ACTIVE = 8;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const connections = new Map<string, number>();
let activeConnections = 0;

// This program only copies bytes between Incus exec channels and the selected
// loopback port. The host constructs and validates the WebSocket wire protocol.
export const PREVIEW_GUEST_RELAY = `import os,select,signal,socket
signal.alarm(int(os.environ["EZH_PREVIEW_LIFETIME_SECONDS"]))
s=socket.create_connection(("127.0.0.1",int(os.environ["EZH_PREVIEW_PORT"])),timeout=3)
try:
 while True:
  ready,_,_=select.select([0,s],[],[],3)
  if not ready: continue
  if 0 in ready:
   data=os.read(0,65536)
   if not data: break
   s.sendall(data)
  if s in ready:
   data=s.recv(65536)
   if not data: break
   while data: data=data[os.write(1,data):]
finally:
 s.close()`;

export interface IncusPreviewDuplexRequest {
  binding: Readonly<SandboxWorkspaceBinding>;
  previewId: string;
  userId: string;
  targetPort: number | null;
  requestPath: string;
  search: string;
  expiresAt: Date;
  signal: AbortSignal;
  subprotocol?: "vite-hmr" | "vite-ping" | null;
}

export interface GuestPreviewDuplex {
  readonly protocol: string | null;
  send(data: string | Uint8Array): Promise<void>;
  readonly messages: AsyncIterable<string | Uint8Array>;
  close(): Promise<void>;
}

/** Created by a host-only authorizer after fresh DB, release, connection and
 * preview-registry checks. It is never constructed from provider input. */
export interface IncusPreviewAuthorization {
  authorizedBinding: Readonly<SandboxWorkspaceBinding>;
  registeredPort: number;
  command: IncusTransportRequest;
  scope: HostConnectionScope;
  connections: HostConnectionResolver;
  revalidate(): Promise<void>;
}

export type IncusPreviewAuthorize = (request: IncusPreviewDuplexRequest) => Promise<IncusPreviewAuthorization>;

export interface IncusPreviewTransportDependencies {
  http?: PinnedFetch;
  websocket?: typeof openPinnedWebSocket;
}

function assertRequest(request: IncusPreviewDuplexRequest): string {
  const now = Date.now();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(request.previewId)
    || !request.userId || request.signal.aborted
    || !Number.isSafeInteger(request.targetPort) || request.targetPort! < 1024 || request.targetPort! > 65535
    || !(request.expiresAt instanceof Date) || !Number.isFinite(request.expiresAt.getTime())
    || request.expiresAt.getTime() <= now || request.expiresAt.getTime() > now + 24 * 60 * 60 * 1000
    || (request.subprotocol != null && request.subprotocol !== "vite-hmr" && request.subprotocol !== "vite-ping")) {
    throw new Error("Invalid Incus preview request");
  }
  const path = `${request.requestPath}${request.search}`;
  if (!request.requestPath.startsWith("/") || request.requestPath.startsWith("//")
    || (request.search !== "" && !request.search.startsWith("?")) || path.length > 2048
    || /[^\x21-\x7e]|#/.test(path)) throw new Error("Invalid Incus preview path");
  return path;
}

function assertAuthority(request: IncusPreviewDuplexRequest, approved: IncusPreviewAuthorization): void {
  const { binding, targetPort } = request;
  const { command, scope } = approved;
  if (!sameSandboxWorkspaceBinding(binding, approved.authorizedBinding) || approved.registeredPort !== targetPort
    || command.action !== "endpoint.open" || command.connectionId !== binding.connectionId
    || command.pins.connectionId !== binding.connectionId || command.tags.connectionId !== binding.connectionId
    || command.tags.sandboxId !== binding.workspaceId
    || command.sandboxName !== resourceName(binding.connectionId, binding.workspaceId)
    || scope.approvedPreset?.presetId !== binding.presetId
    || scope.approvedPreset?.presetDigest !== binding.presetDigest
    || scope.approvedPreset?.effectiveSettingsDigest !== binding.effectiveSettingsDigest
    || scope.approvedPreset?.incusProfile !== command.pins.profile
    || scope.approvedGuest?.user !== command.pins.guestUser
    || !Number.isSafeInteger(scope.approvedGuest?.uid) || !Number.isSafeInteger(scope.approvedGuest?.gid)
    || scope.approvedGuest!.uid < 1 || scope.approvedGuest!.gid < 1
    || command.deadlineMs > Math.min(Date.now() + MAX_PREVIEW_SESSION_MS, request.expiresAt.getTime())
    || command.deadlineMs <= Date.now() || typeof approved.revalidate !== "function") {
    throw new Error("Incus preview authority changed");
  }
}

class GuestBytes {
  #buffer = Buffer.alloc(0);
  constructor(private readonly socket: PinnedWebSocket) {}
  async read(length: number): Promise<Buffer> {
    if (length < 0 || length > MAX_PREVIEW_FRAME_BYTES + MAX_HEADER) throw new Error("Invalid preview read length");
    while (this.#buffer.length < length) {
      const chunk = await this.socket.readChunk?.();
      if (!chunk) throw new Error("Incus preview stream closed");
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      if (this.#buffer.length > MAX_PREVIEW_FRAME_BYTES + MAX_HEADER) throw new Error("Incus preview stream is too large");
    }
    const result = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return result;
  }
  async header(): Promise<string> {
    for (;;) {
      const end = this.#buffer.indexOf("\r\n\r\n");
      if (end >= 0) {
        if (end > MAX_HEADER) throw new Error("Preview response headers are too large");
        return (await this.read(end + 4)).toString("latin1");
      }
      if (this.#buffer.length > MAX_HEADER) throw new Error("Preview response headers are too large");
      const chunk = await this.socket.readChunk?.();
      if (!chunk) throw new Error("Incus preview handshake closed");
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      if (this.#buffer.length > MAX_PREVIEW_FRAME_BYTES + MAX_HEADER) throw new Error("Incus preview stream is too large");
    }
  }
}

function validateHandshake(header: string, key: string, requested: string | null): string | null {
  const lines = header.split("\r\n");
  if (!/^HTTP\/1\.[01] 101(?: |$)/.test(lines.shift() ?? "")) throw new Error("Guest preview WebSocket upgrade denied");
  const fields = new Map<string, string>();
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("Invalid guest preview upgrade header");
    const name = line.slice(0, colon).toLowerCase();
    if (fields.has(name)) throw new Error("Duplicate guest preview upgrade header");
    fields.set(name, line.slice(colon + 1).trim());
  }
  if (fields.get("sec-websocket-accept") !== createHash("sha1").update(key + GUID).digest("base64")
    || fields.get("upgrade")?.toLowerCase() !== "websocket"
    || !fields.get("connection")?.toLowerCase().split(",").map(value => value.trim()).includes("upgrade")
    || fields.has("sec-websocket-extensions")) throw new Error("Invalid guest preview WebSocket upgrade");
  const selected = fields.get("sec-websocket-protocol") ?? null;
  if (selected !== requested) throw new Error("Guest preview WebSocket protocol changed");
  return selected;
}

function reserve(binding: SandboxWorkspaceBinding, previewId: string): () => void {
  const key = `${binding.workspaceId}\0${previewId}`;
  const count = connections.get(key) ?? 0;
  if (count >= MAX_CONNECTIONS || activeConnections >= MAX_ACTIVE) throw new Error("Preview connection limit reached");
  connections.set(key, count + 1);
  activeConnections++;
  return () => {
    activeConnections--;
    const current = connections.get(key) ?? 0;
    if (current <= 1) connections.delete(key);
    else connections.set(key, current - 1);
  };
}

/** Fixed guest-loopback WebSocket relay over a freshly authorized, pinned
 * Incus exec. The caller cannot select an address, executable or guest UID. */
export async function connectIncusPreviewDuplex(request: IncusPreviewDuplexRequest,
  authorize: IncusPreviewAuthorize, dependencies: IncusPreviewTransportDependencies = {}): Promise<GuestPreviewDuplex> {
  const path = assertRequest(request);
  const release = reserve(request.binding, request.previewId);
  let readyResolve!: (value: GuestPreviewDuplex) => void;
  let readyReject!: (reason: unknown) => void;
  let delivered = false;
  const ready = new Promise<GuestPreviewDuplex>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let output: PinnedWebSocket | undefined;
  let input: PinnedWebSocket | undefined;
  let totalOut = 0;
  let totalIn = 0;
  let framesOut = 0;
  let framesIn = 0;
  let closed = false;
  let settled!: Promise<void>;
  const close = async () => {
    if (!closed) {
      closed = true;
      try { input?.send(encodeMaskedPreviewFrame(8, new Uint8Array())); input?.finish(); } catch { /* channel may already be closed */ }
      finish();
    }
    await settled;
  };
  settled = (async () => {
    try {
      const approved = await authorize(request);
      assertAuthority(request, approved);
      await approved.revalidate();
      const signal = AbortSignal.any([request.signal, approved.scope.signal ?? request.signal]);
      await withPreviewSession(approved.connections, { ...approved.scope, signal }, dependencies.http ?? verifiedHttpsRequest,
        approved.command, async session => {
          const project = encodeURIComponent(session.connection.project);
          const instancePath = `/1.0/instances/${approved.command.sandboxName}`;
          const instance = object(metadata(await session.request("GET", `${instancePath}?project=${project}`)));
          const config = object(instance.config);
          if (instance.name !== approved.command.sandboxName || instance.status !== "Running"
            || config["user.ezharness.managed_by"] !== "ezharness-incus-sandbox"
            || config["user.ezharness.connection_id"] !== request.binding.connectionId
            || config["user.ezharness.sandbox_id"] !== request.binding.workspaceId
            || config["user.ezharness.generation"] !== String(request.binding.generation)
            || config["user.ezharness.profile"] !== approved.scope.approvedPreset?.profile
            || config["user.ezharness.preset_id"] !== request.binding.presetId
            || config["volatile.base_image"] !== approved.scope.approvedPreset?.imageFingerprint
            || !Array.isArray(instance.profiles) || instance.profiles.length !== 1
            || instance.profiles[0] !== approved.scope.approvedPreset?.incusProfile) {
            throw new Error("Incus preview instance changed");
          }
          await approved.revalidate();
          const guest = approved.scope.approvedGuest!;
          const lifetimeSeconds = Math.min(900, Math.max(1, Math.ceil((approved.command.deadlineMs - Date.now()) / 1_000)));
          const posted = await session.request("POST", `${instancePath}/exec?project=${project}`, {
            command: ["/usr/bin/python3", "-I", "-S", "-u", "-c", PREVIEW_GUEST_RELAY],
            user: guest.uid, group: guest.gid, cwd: "/workspace",
            environment: { HOME: "/workspace", PATH: "/usr/local/bin:/usr/bin:/bin", EZH_PREVIEW_PORT: String(approved.registeredPort),
              EZH_PREVIEW_LIFETIME_SECONDS: String(lifetimeSeconds) },
            "wait-for-websocket": true, interactive: false, "record-output": false,
          });
          if (posted.status !== 202 || posted.envelope.type !== "async") throw new Error("Incus preview exec was denied");
          const exec = parseGuestExecOperation(posted.envelope, approved.command.sandboxName!);
          const open = dependencies.websocket ?? openPinnedWebSocket;
          const sockets: PinnedWebSocket[] = [];
          try {
            for (const channel of ["0", "1", "2", "control"]) sockets.push(await open(session, exec.id, exec.fds[channel]!));
            [input, output] = sockets;
            const stderr = sockets[2]!;
            void stderr.readAll().catch(() => undefined);
            const bytes = new GuestBytes(output!);
            const key = randomBytes(16).toString("base64");
            const protocol = request.subprotocol ?? null;
            const handshake = `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${approved.registeredPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ""}\r\n`;
            await (input!.sendBounded?.(Buffer.from(handshake)) ?? Promise.resolve(input!.send(Buffer.from(handshake))));
            const selected = validateHandshake(await bytes.header(), key, protocol);
            const duplex: GuestPreviewDuplex = {
              protocol: selected,
              async send(data) {
                if (closed || session.signal.aborted) throw new Error("Incus preview stream closed");
                try {
                  if (Date.now() >= request.expiresAt.getTime()) throw new Error("Incus preview expired");
                  await approved.revalidate();
                  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
                  totalOut += payload.length + 8;
                  framesOut++;
                  if (payload.length > MAX_PREVIEW_FRAME_BYTES || totalOut > MAX_TOTAL || framesOut > MAX_FRAMES) throw new Error("Preview output limit reached");
                  const frame = encodeMaskedPreviewFrame(typeof data === "string" ? 1 : 2, payload);
                  await (input!.sendBounded?.(frame) ?? Promise.resolve(input!.send(frame)));
                } catch (error) { await close(); throw error; }
              },
              messages: {
                async *[Symbol.asyncIterator]() {
                  let fragmentedOpcode: 1 | 2 | null = null;
                  let fragments: Buffer[] = [];
                  let fragmentBytes = 0;
                  try {
                    while (!closed && !session.signal.aborted) {
                      const frame = await readUnmaskedPreviewFrame(bytes);
                      totalIn += frame.data.length + 8;
                      framesIn++;
                      if (totalIn > MAX_TOTAL || framesIn > MAX_FRAMES) throw new Error("Preview input limit reached");
                      if (Date.now() >= request.expiresAt.getTime()) throw new Error("Incus preview expired");
                      await approved.revalidate();
                      if (frame.opcode === 8) { await close(); return; }
                      if (frame.opcode === 9) {
                        const pong = encodeMaskedPreviewFrame(10, frame.data);
                        await (input!.sendBounded?.(pong) ?? Promise.resolve(input!.send(pong)));
                        continue;
                      }
                      if (frame.opcode === 10) continue;
                      if (frame.opcode === 0) {
                        if (fragmentedOpcode === null) throw new Error("Unexpected preview continuation frame");
                      } else {
                        if (fragmentedOpcode !== null) throw new Error("Incomplete preview fragmented message");
                        fragmentedOpcode = frame.opcode as 1 | 2;
                      }
                      fragments.push(frame.data);
                      fragmentBytes += frame.data.length;
                      if (fragmentBytes > MAX_PREVIEW_FRAME_BYTES) throw new Error("Preview message is too large");
                      if (!frame.final) continue;
                      const message = Buffer.concat(fragments, fragmentBytes);
                      const opcode = fragmentedOpcode;
                      fragmentedOpcode = null;
                      fragments = [];
                      fragmentBytes = 0;
                      yield opcode === 1 ? new TextDecoder("utf-8", { fatal: true }).decode(message) : Uint8Array.from(message);
                    }
                  } finally { await close(); }
                },
              },
              close,
            };
            delivered = true;
            readyResolve(duplex);
            let checking = false;
            const guard = setInterval(() => {
              if (checking || closed) return;
              checking = true;
              void approved.revalidate().catch(() => close()).finally(() => { checking = false; });
            }, 2_000);
            try {
              await Promise.race([finished, new Promise<void>(resolve => session.signal.addEventListener("abort", () => resolve(), { once: true }))]);
            } finally { clearInterval(guard); }
          } finally {
            for (const socket of sockets) socket.close();
          }
        });
    } catch (error) {
      if (!delivered) readyReject(error);
    } finally {
      closed = true;
      release();
      finish();
    }
  })();
  return ready;
}
