import { normalizePoolResourceVector, type PoolResourceVector } from "./ledger";

export const POOL_HTTP_BYTES_LIMIT = 16 * 1024;
export const POOL_WIRE_MAX_TIMESTAMP_MS = 253_402_300_799_999;

export function wireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Pool ${label} is malformed.`);
  return value as Record<string, unknown>;
}

export function wireExact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const names = new Set(allowed);
  if (Object.keys(value).some(key => !names.has(key))) throw new Error(`Pool ${label} has unsupported fields.`);
}

export function wireText(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || [...value].some(character => character.codePointAt(0)! < 32)) throw new Error(`Pool ${label} is malformed.`);
  return value;
}

export function wireCounter(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Pool ${label} is malformed.`);
  return value;
}

export function wireResources(value: unknown): PoolResourceVector {
  return normalizePoolResourceVector(value as PoolResourceVector);
}

export function wireIsoDate(value: unknown, label: string): Date {
  if (typeof value !== "string") throw new Error(`Pool ${label} is malformed.`);
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > POOL_WIRE_MAX_TIMESTAMP_MS || new Date(timestamp).toISOString() !== value) throw new Error(`Pool ${label} is malformed.`);
  return new Date(timestamp);
}

export function parseWireJson(bytes: Uint8Array, label: string): unknown {
  if (bytes.byteLength > POOL_HTTP_BYTES_LIMIT) throw new Error(`Pool ${label} exceeds the byte limit.`);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function encodeWireJson(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.byteLength > POOL_HTTP_BYTES_LIMIT) throw new Error("Pool response exceeds the byte limit.");
  return bytes;
}

export function decodeReservationPath(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); }
  catch { throw new Error("Pool reservation path is malformed."); }
  if (encodeURIComponent(decoded) !== value) throw new Error("Pool reservation path is not canonical.");
  return wireText(decoded, "reservation id");
}
