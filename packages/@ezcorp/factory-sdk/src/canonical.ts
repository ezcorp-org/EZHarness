import { FACTORY_LIMITS, type JsonValue, type ValidationResult } from "./types.js";

function issue(code: string, message: string, path: readonly (string | number)[]): ValidationResult {
  return { ok: false, issues: [{ code, message, path }] };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function validate(value: unknown, path: readonly (string | number)[], ancestors: ReadonlySet<object>, depth: number): ValidationResult {
  if (depth > FACTORY_LIMITS.maxJsonDepth) return issue("IJSON_DEPTH", "I-JSON value exceeds the nesting limit.", path);
  if (value === null || typeof value === "boolean") return { ok: true };
  if (typeof value === "string") return hasUnpairedSurrogate(value) ? issue("IJSON_SURROGATE", "Strings cannot contain unpaired Unicode surrogates.", path) : { ok: true };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return issue("IJSON_NONFINITE", "Numbers must be finite.", path);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return issue("IJSON_UNSAFE_INTEGER", "Integers must be safe I-JSON integers.", path);
    return { ok: true };
  }
  if (!value || typeof value !== "object") return issue("IJSON_TYPE", "Value is not valid I-JSON.", path);
  if (ancestors.has(value)) return issue("IJSON_CYCLE", "I-JSON values cannot contain cycles.", path);
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) return issue("IJSON_SPARSE_ARRAY", "I-JSON arrays cannot be sparse.", [...path, index]);
      const result = validate(value[index], [...path, index], next, depth + 1);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return issue("IJSON_OBJECT", "I-JSON objects must be plain records.", path);
  for (const key of Object.keys(value)) {
    if (hasUnpairedSurrogate(key)) return issue("IJSON_SURROGATE", "Object keys cannot contain unpaired Unicode surrogates.", [...path, key]);
    const result = validate((value as Record<string, unknown>)[key], [...path, key], next, depth + 1);
    if (!result.ok) return result;
  }
  return { ok: true };
}

export function validateIJson(value: unknown): ValidationResult {
  return validate(value, [], new Set(), 1);
}

export function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => jsonEqual(item, right[index] as JsonValue));
  const leftRecord = left as Record<string, JsonValue>;
  const rightRecord = right as Record<string, JsonValue>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length && keys.every((key) => Object.hasOwn(rightRecord, key) && jsonEqual(leftRecord[key] as JsonValue, rightRecord[key] as JsonValue));
}

export function unicodeLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

function serialize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  const record = value as Record<string, JsonValue>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key] as JsonValue)}`).join(",")}}`;
}

export function canonicalizeJson(value: JsonValue): string {
  const result = validateIJson(value);
  if (!result.ok) throw new TypeError(result.issues[0]?.message ?? "Invalid I-JSON value.");
  return serialize(value);
}

export function isUnsignedDecimal(value: string): boolean {
  if (value.length === 0 || (value.length > 1 && value.charCodeAt(0) === 48)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

const SHA256_INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19] as const;
const SHA256_ROUNDS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, places: number): number {
  return (value >>> places) | (value << (32 - places));
}

/** Pure deterministic SHA-256 for workflow-safe canonical payload verification. */
export function sha256Hex(value: string | Uint8Array): string {
  const input = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const padded = new Uint8Array(Math.ceil((input.byteLength + 9) / 64) * 64);
  padded.set(input);
  padded[input.byteLength] = 0x80;
  const bitLength = input.byteLength * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.byteLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(padded.byteLength - 4, bitLength >>> 0);
  const hash: number[] = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.byteLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const prior = words[index - 15] as number;
      const second = words[index - 2] as number;
      const sigma0 = rotateRight(prior, 7) ^ rotateRight(prior, 18) ^ (prior >>> 3);
      const sigma1 = rotateRight(second, 17) ^ rotateRight(second, 19) ^ (second >>> 10);
      words[index] = ((words[index - 16] as number) + sigma0 + (words[index - 7] as number) + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const choice = ((e as number) & (f as number)) ^ (~(e as number) & (g as number));
      const majority = ((a as number) & (b as number)) ^ ((a as number) & (c as number)) ^ ((b as number) & (c as number));
      const sum0 = rotateRight(a as number, 2) ^ rotateRight(a as number, 13) ^ rotateRight(a as number, 22);
      const sum1 = rotateRight(e as number, 6) ^ rotateRight(e as number, 11) ^ rotateRight(e as number, 25);
      const first = ((h as number) + sum1 + choice + (SHA256_ROUNDS[index] as number) + (words[index] as number)) >>> 0;
      const second = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = ((d as number) + first) >>> 0; d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    hash[0] = (hash[0]! + (a as number)) >>> 0;
    hash[1] = (hash[1]! + (b as number)) >>> 0;
    hash[2] = (hash[2]! + (c as number)) >>> 0;
    hash[3] = (hash[3]! + (d as number)) >>> 0;
    hash[4] = (hash[4]! + (e as number)) >>> 0;
    hash[5] = (hash[5]! + (f as number)) >>> 0;
    hash[6] = (hash[6]! + (g as number)) >>> 0;
    hash[7] = (hash[7]! + (h as number)) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}
