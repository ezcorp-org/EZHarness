import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { createConnection, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { isValidPreviewId } from "../db/queries/preview-sessions";
import { resolvePreviewAppHost } from "../runtime/preview/preview-proxy";
import { encodeMaskedPreviewFrame, readUnmaskedPreviewFrame } from "./incus-transport/preview-websocket-codec";

const MAX_HTTP_BYTES = 512 * 1024;
const MAX_REPLY_BYTES = 8 * 1024;
const MAX_CHALLENGE_BYTES = 256;
const MAX_WS_FRAMES = 32;
const TIMEOUT_MS = 8_000;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type Origin = { address: string; family: number; protocol: "http:" | "https:"; port: number;
  portSuffix: string; appHost: string; previewBaseHost: string };

export interface IncusPreviewTrafficDriver {
  ready(): Promise<void>;
  handoff(input: { previewId: string; code: string }): Promise<{ status: number; cookie: string }>;
  http(input: { previewId: string; cookie: string | null; path: string; wrongHost?: boolean; malformedHost?: boolean }): Promise<{
    status: number; body: Uint8Array; location: string | null }>;
  webSocket(input: { previewId: string; cookie: string; path: string; subprotocol: "vite-hmr";
    challenge: string; wrongOrigin?: boolean }): Promise<{ status: number; subprotocol: string | null; reply: string }>;
}

function boundedPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 2048
    || [...path].some(character => character.charCodeAt(0) < 33 || character.charCodeAt(0) > 126 || character === "#")) {
    throw new Error("Invalid preview request path");
  }
  return path;
}

function previewCookie(cookie: string): string {
  if (!/^__ezpreview=[A-Za-z0-9._-]{1,4096}$/.test(cookie)) throw new Error("Invalid preview cookie");
  return cookie;
}

function previewIdentity(origin: Origin, previewId: string): { host: string; origin: string } {
  if (!isValidPreviewId(previewId)) throw new Error("Invalid preview identity");
  const host = `${previewId}.preview.${origin.previewBaseHost}${origin.portSuffix}`;
  return { host, origin: `${origin.protocol}//${host}` };
}

function requestOptions(origin: Origin, host: string, path: string, headers: Record<string, string> = {}): http.RequestOptions {
  return { protocol: origin.protocol, hostname: origin.address, family: origin.family, port: origin.port,
    path, method: "GET", agent: false, timeout: TIMEOUT_MS,
    ...(origin.protocol === "https:" ? { servername: host.split(":")[0], rejectUnauthorized: true } : {}),
    headers: { Host: host, ...headers } };
}

function clientFor(origin: Origin): typeof http | typeof https {
  return origin.protocol === "https:" ? https : http;
}

async function boundedGet(origin: Origin, host: string, path: string, limit: number,
  headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let exceeded = false;
    const request = clientFor(origin).request(requestOptions(origin, host, path, headers), response => {
      const declared = response.headers["content-length"];
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
        exceeded = true;
        response.destroy();
        reject(new Error("Preview response exceeded its limit"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) { exceeded = true; request.destroy(); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers,
        body: Buffer.concat(chunks, size) }));
      response.on("error", () => reject(new Error(exceeded ? "Preview response exceeded its limit" : "Preview response failed")));
    });
    const deadline = setTimeout(() => request.destroy(new Error("Preview request timed out")), TIMEOUT_MS);
    request.once("close", () => clearTimeout(deadline));
    request.on("error", () => reject(new Error(exceeded ? "Preview response exceeded its limit" : "Preview request failed")));
    request.on("timeout", () => request.destroy(new Error("Preview request timed out")));
    request.end();
  });
}

class SocketBytes {
  #buffer = Buffer.alloc(0);
  #waiting: (() => void) | undefined;
  #closed = false;
  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      if (this.#buffer.length > 2 * 262_144) socket.destroy();
      this.#waiting?.();
    });
    socket.on("close", () => { this.#closed = true; this.#waiting?.(); });
    socket.on("error", () => { this.#closed = true; this.#waiting?.(); });
  }
  async read(length: number): Promise<Buffer> {
    while (this.#buffer.length < length) {
      if (this.#closed) throw new Error("Preview WebSocket closed early");
      await new Promise<void>(resolve => { this.#waiting = resolve; });
      this.#waiting = undefined;
    }
    const value = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return value;
  }
  async until(marker: string, limit: number): Promise<Buffer> {
    for (;;) {
      const end = this.#buffer.indexOf(marker);
      if (end >= 0) {
        if (end > limit) throw new Error("Preview WebSocket headers exceeded their limit");
        return this.read(end + marker.length);
      }
      if (this.#buffer.length > limit || this.#closed) throw new Error("Preview WebSocket headers are incomplete");
      await new Promise<void>(resolve => { this.#waiting = resolve; });
      this.#waiting = undefined;
    }
  }
}

async function readReply(socket: Socket, bytes: SocketBytes): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let started = false;
  for (let index = 0; index < MAX_WS_FRAMES; index++) {
    const frame = await readUnmaskedPreviewFrame(bytes);
    if (frame.opcode === 9) { socket.write(encodeMaskedPreviewFrame(10, frame.data)); continue; }
    if (frame.opcode === 10) continue;
    if (frame.opcode !== (started ? 0 : 1)) throw new Error("Invalid preview WebSocket reply");
    started = true;
    size += frame.data.length;
    if (size > MAX_REPLY_BYTES) throw new Error("Preview WebSocket reply exceeded its limit");
    chunks.push(frame.data);
    if (frame.final) return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
  }
  throw new Error("Preview WebSocket reply exceeded its frame limit");
}

async function connectPinnedSocket(origin: Origin, previewHost: string): Promise<Socket> {
  const host = previewHost.split(":")[0]!;
  const socket = origin.protocol === "https:"
    ? connectTls({ host: origin.address, port: origin.port,
      servername: host, rejectUnauthorized: true })
    : createConnection({ host: origin.address, family: origin.family, port: origin.port });
  socket.setTimeout(TIMEOUT_MS, () => socket.destroy());
  const deadline = setTimeout(() => socket.destroy(), TIMEOUT_MS);
  socket.once("close", () => clearTimeout(deadline));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once(origin.protocol === "https:" ? "secureConnect" : "connect", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Preview WebSocket connection closed")));
    });
    return socket;
  } catch {
    socket.destroy();
    throw new Error("Preview WebSocket connection failed");
  }
}

function upgradeHeaders(header: string): { status: number; headers: Map<string, string> } {
  const lines = header.split("\r\n");
  const status = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: |$)/.exec(lines.shift() ?? "");
  if (!status) throw new Error("Invalid preview WebSocket response");
  const headers = new Map<string, string>();
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("Invalid preview WebSocket response");
    const name = line.slice(0, colon).toLowerCase();
    if (headers.has(name)) throw new Error("Duplicate preview WebSocket header");
    headers.set(name, line.slice(colon + 1).trim());
  }
  return { status: Number(status[1]), headers };
}

export function createIncusPreviewTrafficDriver(config: { env?: Record<string, string | undefined> } = {}): IncusPreviewTrafficDriver {
  const env = config.env ?? process.env;
  let pinned: Origin | undefined;
  const current = (): Origin => {
    if (!pinned) throw new Error("Preview traffic origin is not ready");
    return pinned;
  };
  return {
    async ready() {
      pinned = undefined;
      const raw = env.EZCORP_PUBLIC_URL?.trim();
      const previewBase = resolvePreviewAppHost(env);
      if (!raw || !previewBase) throw new Error("Preview traffic origin is not configured");
      let url: URL;
      let previewUrl: URL;
      try { url = new URL(raw); previewUrl = new URL(`http://${previewBase}`); }
      catch { throw new Error("Preview traffic origin is invalid"); }
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password
        || url.pathname !== "/" || url.search || url.hash || !url.hostname
        || previewUrl.pathname !== "/" || previewUrl.username || previewUrl.password
        || !/^[A-Za-z0-9.-]+$/.test(previewUrl.hostname)
        || (previewUrl.port && previewUrl.port !== url.port)) throw new Error("Preview traffic origin is invalid");
      const resolved = await lookup(url.hostname);
      const origin: Origin = { address: resolved.address, family: resolved.family,
        protocol: url.protocol, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
        portSuffix: url.port ? `:${url.port}` : "", appHost: url.host,
        previewBaseHost: previewUrl.hostname };
      const health = await boundedGet(origin, origin.appHost, "/api/ready", 16 * 1024);
      if (health.status !== 200) throw new Error("Preview traffic app is not ready");
      pinned = origin;
    },
    async handoff({ previewId, code }) {
      const origin = current();
      const target = previewIdentity(origin, previewId);
      if (!/^[a-f0-9]{64}$/.test(code)) throw new Error("Invalid preview handoff code");
      const response = await boundedGet(origin, target.host, `/__open?c=${code}`, 16 * 1024);
      if (response.status !== 302) return { status: response.status, cookie: "" };
      const setCookies = response.headers["set-cookie"] ?? [];
      const selected = setCookies.find(value => value.startsWith("__ezpreview="));
      const cookie = selected?.split(";")[0] ?? "";
      if (!selected || !/;\s*HttpOnly(?:;|$)/i.test(selected) || /;\s*Domain=/i.test(selected)
        || response.headers.location !== "/") throw new Error("Invalid preview handoff response");
      return { status: response.status, cookie: previewCookie(cookie) };
    },
    async http({ previewId, cookie, path, wrongHost = false, malformedHost = false }) {
      const origin = current();
      const target = previewIdentity(origin, previewId);
      if (wrongHost && malformedHost) throw new Error("Invalid preview Host mode");
      const host = wrongHost ? `invalid.preview.invalid${origin.portSuffix}`
        : malformedHost ? `invalid!.preview.${origin.previewBaseHost}${origin.portSuffix}` : target.host;
      const response = await boundedGet(origin, host, boundedPath(path), MAX_HTTP_BYTES,
        cookie === null ? {} : { Cookie: previewCookie(cookie) });
      return { status: response.status, body: response.body,
        location: typeof response.headers.location === "string" ? response.headers.location : null };
    },
    async webSocket({ previewId, cookie, path, subprotocol, challenge, wrongOrigin = false }) {
      const origin = current();
      const target = previewIdentity(origin, previewId);
      const requestPath = boundedPath(path);
      const cookieValue = previewCookie(cookie);
      if (subprotocol !== "vite-hmr" || !challenge || Buffer.byteLength(challenge) > MAX_CHALLENGE_BYTES) {
        throw new Error("Invalid preview WebSocket challenge");
      }
      const key = randomBytes(16).toString("base64");
      const expectedAccept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
      const socket = await connectPinnedSocket(origin, target.host);
      try {
        const bytes = new SocketBytes(socket);
        socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Protocol: ${subprotocol}\r\nOrigin: ${wrongOrigin ? "https://invalid.invalid" : target.origin}\r\nCookie: ${cookieValue}\r\n\r\n`);
        const response = upgradeHeaders((await bytes.until("\r\n\r\n", 8 * 1024)).toString("latin1"));
        if (response.status !== 101) return { status: response.status, subprotocol: null, reply: "" };
        if (response.headers.get("upgrade")?.toLowerCase() !== "websocket"
          || !response.headers.get("connection")?.toLowerCase().split(",").some(value => value.trim() === "upgrade")
          || response.headers.get("sec-websocket-accept") !== expectedAccept
          || response.headers.get("sec-websocket-protocol") !== subprotocol) {
          throw new Error("Invalid preview WebSocket upgrade");
        }
        socket.write(encodeMaskedPreviewFrame(1, Buffer.from(challenge)));
        return { status: 101, subprotocol, reply: await readReply(socket, bytes) };
      } finally { socket.destroy(); }
    },
  };
}
