import { randomBytes } from "node:crypto";

export const MAX_PREVIEW_FRAME_BYTES = 256 * 1024;
export type PreviewClientOpcode = 1 | 2 | 8 | 9 | 10;

/** RFC 6455 client frame. The transport and qualification witness use this
 * same bounded encoder; neither sends an unmasked frame to the guest server. */
export function encodeMaskedPreviewFrame(opcode: PreviewClientOpcode, payload: Uint8Array): Buffer {
  if (payload.byteLength > MAX_PREVIEW_FRAME_BYTES || ([8, 9, 10].includes(opcode) && payload.byteLength > 125)) {
    throw new Error("Preview frame is too large");
  }
  const mask = randomBytes(4);
  const head = payload.byteLength < 126 ? 2 : payload.byteLength <= 65535 ? 4 : 10;
  const result = Buffer.alloc(head + 4 + payload.byteLength);
  result[0] = 0x80 | opcode;
  result[1] = 0x80 | (head === 2 ? payload.byteLength : head === 4 ? 126 : 127);
  if (head === 4) result.writeUInt16BE(payload.byteLength, 2);
  if (head === 10) result.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  mask.copy(result, head);
  for (let index = 0; index < payload.byteLength; index++) result[head + 4 + index] = payload[index]! ^ mask[index % 4]!;
  return result;
}

/** Read one server frame from any exact-byte reader. The caller owns message
 * assembly, per-connection quotas, and deadlines. */
export async function readUnmaskedPreviewFrame(bytes: { read(length: number): Promise<Buffer> }):
  Promise<{ opcode: number; data: Buffer; final: boolean }> {
  const head = await bytes.read(2);
  if ((head[0]! & 0x70) !== 0 || (head[1]! & 0x80) !== 0) throw new Error("Invalid preview WebSocket frame");
  const opcode = head[0]! & 15;
  let length = head[1]! & 127;
  if (length === 126) length = (await bytes.read(2)).readUInt16BE(0);
  if (length === 127) {
    const long = (await bytes.read(8)).readBigUInt64BE(0);
    if (long > BigInt(MAX_PREVIEW_FRAME_BYTES)) throw new Error("Preview frame is too large");
    length = Number(long);
  }
  const final = (head[0]! & 0x80) !== 0;
  if (length > MAX_PREVIEW_FRAME_BYTES || ([8, 9, 10].includes(opcode) && (length > 125 || !final))
    || ![0, 1, 2, 8, 9, 10].includes(opcode)) throw new Error("Invalid preview WebSocket frame");
  return { opcode, data: await bytes.read(length), final };
}
