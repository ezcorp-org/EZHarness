import { createHash, randomBytes } from "node:crypto";
import type { TLSSocket } from "node:tls";
import type { Session } from "./lifecycle";
import { connectPinnedTls } from "./transport";

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class SocketBytes {
  #buffer = Buffer.alloc(0);
  #pending: (() => void) | undefined;
  #error: Error | undefined;
  constructor(readonly socket: TLSSocket) {
    socket.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      if (this.#buffer.length > MAX_FRAME_BYTES + MAX_HEADER_BYTES) socket.destroy(new Error("Incus WebSocket response is too large"));
      this.#pending?.();
    });
    socket.on("error", () => { this.#error = new Error("Incus WebSocket failed"); this.#pending?.(); });
    socket.on("close", () => { this.#error ??= new Error("Incus WebSocket closed"); this.#pending?.(); });
  }
  async #changed(): Promise<void> {
    if (this.#error) throw this.#error;
    await new Promise<void>(resolve => { this.#pending = resolve; });
    this.#pending = undefined;
  }
  async read(length: number): Promise<Buffer> {
    while (this.#buffer.length < length) await this.#changed();
    const value = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return value;
  }
  async until(marker: string, limit: number): Promise<Buffer> {
    for (;;) {
      const end = this.#buffer.indexOf(marker);
      if (end >= 0) {
        if (end > limit) throw new Error("Incus WebSocket headers are too large");
        return this.read(end + marker.length);
      }
      if (this.#buffer.length > limit) throw new Error("Incus WebSocket headers are too large");
      await this.#changed();
    }
  }
}

function maskedFrame(opcode: number, data: Uint8Array = new Uint8Array()): Buffer {
  if (data.length > MAX_FRAME_BYTES) throw new Error("Incus WebSocket request is too large");
  const mask = randomBytes(4);
  const length = data.length;
  const size = length < 126 ? 2 : length <= 65535 ? 4 : 10;
  const frame = Buffer.alloc(size + 4 + length);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | (length < 126 ? length : length <= 65535 ? 126 : 127);
  if (size === 4) frame.writeUInt16BE(length, 2);
  if (size === 10) frame.writeBigUInt64BE(BigInt(length), 2);
  mask.copy(frame, size);
  for (let i = 0; i < length; i++) frame[size + 4 + i] = data[i]! ^ mask[i % 4]!;
  return frame;
}

export interface PinnedWebSocket {
  send(data: Buffer): void;
  finish(): void;
  readAll(): Promise<Buffer>;
  close(): void;
}

/** Opens a WebSocket only after exact TLS peer verification, on a pinned Incus operation route. */
export async function openPinnedWebSocket(session: Session, operationId: string, secret: string): Promise<PinnedWebSocket> {
  if (!/^[a-f0-9-]{36}$/.test(operationId) || !/^[a-f0-9]{64}$/.test(secret)) throw new Error("Invalid Incus WebSocket identity");
  const host = session.origin.hostname.replace(/^\[|\]$/g, "");
  const socket = await connectPinnedTls(host, Number(session.origin.port || 443), session.tls, session.signal);
  try {
    const bytes = new SocketBytes(socket);
    const key = randomBytes(16).toString("base64");
    const project = encodeURIComponent(session.connection.project);
    if (session.signal.aborted || socket.destroyed) throw new Error("Incus WebSocket deadline exceeded");
    socket.write(`GET /1.0/operations/${operationId}/websocket?secret=${secret}&project=${project} HTTP/1.1\r\nHost: ${session.origin.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`);
    const header = (await bytes.until("\r\n\r\n", MAX_HEADER_BYTES)).toString("latin1");
    if (!/^HTTP\/1\.[01] 101(?: |\r\n)/.test(header)) throw new Error("Incus WebSocket upgrade denied");
    const accept = /^sec-websocket-accept:\s*(\S+)\s*$/im.exec(header)?.[1];
    const expected = createHash("sha1").update(key + GUID).digest("base64");
    if (accept !== expected) throw new Error("Incus WebSocket upgrade invalid");
    const readAll = async (): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const head = await bytes.read(2);
        const opcode = head[0]! & 15;
        if (head[1]! & 0x80) throw new Error("Masked Incus WebSocket response");
        let length = head[1]! & 127;
        if (length === 126) length = (await bytes.read(2)).readUInt16BE(0);
        if (length === 127) {
          const large = (await bytes.read(8)).readBigUInt64BE(0);
          if (large > BigInt(MAX_FRAME_BYTES)) throw new Error("Incus WebSocket response is too large");
          length = Number(large);
        }
        if ((opcode === 8 || opcode === 9 || opcode === 10) && length > 125) throw new Error("Invalid Incus WebSocket control frame");
        const frame = await bytes.read(length);
        if (opcode === 8) throw new Error("Incus WebSocket closed before stream EOF");
        if (opcode === 9) { socket.write(maskedFrame(10, frame)); continue; }
        if (opcode === 10) continue;
        if (opcode !== 0 && opcode !== 1 && opcode !== 2) throw new Error("Invalid Incus WebSocket frame");
        if (opcode === 1) {
          if (head[0] !== 0x81 || length !== 0) throw new Error("Invalid Incus WebSocket stream EOF");
          return Buffer.concat(chunks, total);
        }
        total += length;
        if (total > MAX_FRAME_BYTES) throw new Error("Incus WebSocket response is too large");
        chunks.push(frame);
      }
    };
    return { send(data) { socket.write(maskedFrame(2, data)); }, finish() { socket.write(maskedFrame(1)); }, readAll, close() { socket.destroy(); } };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
