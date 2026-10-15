export const FACTORY_PAGE_BYTES_LIMIT = 32 * 1024;

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const MAX_BASE64_LENGTH = Math.ceil(FACTORY_PAGE_BYTES_LIMIT / 3) * 4;

function requirePageSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 1 || size > FACTORY_PAGE_BYTES_LIMIT) throw new Error(`factory page must contain 1 to ${FACTORY_PAGE_BYTES_LIMIT} bytes`);
}

/** Canonical base64 for a bounded immutable page crossing a JSON activity boundary. */
export function encodeFactoryPageBase64(bytes: Uint8Array): string {
  requirePageSize(bytes.byteLength);
  let encoded = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const remaining = bytes.byteLength - offset;
    const bits = (bytes[offset]! << 16) | ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset + 2] ?? 0);
    encoded += BASE64[(bits >> 18) & 63]! + BASE64[(bits >> 12) & 63]!;
    encoded += remaining > 1 ? BASE64[(bits >> 6) & 63]! : "=";
    encoded += remaining > 2 ? BASE64[bits & 63]! : "=";
  }
  return encoded;
}

/** Strict decoder shared by Node, Bun, and deterministic workflow code. */
export function decodeFactoryPageBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length < 4 || value.length > MAX_BASE64_LENGTH || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("factory page is not canonical base64");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const size = (value.length / 4) * 3 - padding;
  requirePageSize(size);
  const bytes = new Uint8Array(size);
  let output = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const a = BASE64.indexOf(value[offset]!);
    const b = BASE64.indexOf(value[offset + 1]!);
    const c = value[offset + 2] === "=" ? 0 : BASE64.indexOf(value[offset + 2]!);
    const d = value[offset + 3] === "=" ? 0 : BASE64.indexOf(value[offset + 3]!);
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    if (output < size) bytes[output++] = bits >> 16;
    if (output < size) bytes[output++] = bits >> 8;
    if (output < size) bytes[output++] = bits;
  }
  const trailingBits = padding === 2 ? BASE64.indexOf(value[value.length - 3]!) & 15 : padding === 1 ? BASE64.indexOf(value[value.length - 2]!) & 3 : 0;
  if (trailingBits !== 0) throw new Error("factory page is not canonical base64");
  return bytes;
}
