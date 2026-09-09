import type { JsonValue } from "@ezcorp/extension-contract/types";

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_JSON_DEPTH = 32;
const encoder = new TextEncoder();
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export function isForbiddenJsonKey(key: string): boolean { return forbidden.has(key); }

export class ContractError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, message: string, path = "$") {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.path = path;
  }
}

export function assertJson(value: unknown, maxBytes = MAX_FRAME_BYTES): asserts value is JsonValue {
  const seen = new Set<object>();
  let nodes = 0;
  function visit(entry: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > MAX_JSON_DEPTH) throw new ContractError("DATA_LIMIT", "JSON structure exceeds limits");
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return;
    if (typeof entry === "number" && Number.isFinite(entry)) return;
    if (typeof entry !== "object" || !entry) throw new ContractError("INVALID_JSON", "Only JSON data is accepted");
    if (seen.has(entry)) throw new ContractError("INVALID_JSON", "Cyclic data is forbidden");
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
        if (!descriptor || !("value" in descriptor)) throw new ContractError("INVALID_JSON", "Sparse arrays and accessors are forbidden");
        visit(descriptor.value, depth + 1);
      }
      if (Reflect.ownKeys(entry).length !== entry.length + 1) throw new ContractError("INVALID_JSON", "Array properties are forbidden");
    } else {
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) throw new ContractError("INVALID_JSON", "Only plain objects are accepted");
      for (const key of Reflect.ownKeys(entry)) {
        if (typeof key !== "string" || isForbiddenJsonKey(key)) throw new ContractError("INVALID_JSON", "Unsafe object key");
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new ContractError("INVALID_JSON", "Accessors and hidden fields are forbidden");
        visit(descriptor.value, depth + 1);
      }
    }
    seen.delete(entry);
  }
  visit(value, 0);
  if (encoder.encode(JSON.stringify(value)).byteLength > maxBytes) throw new ContractError("DATA_LIMIT", "JSON bytes exceed limit");
}

export function parseJson(text: string, maxBytes = MAX_FRAME_BYTES): JsonValue {
  if (encoder.encode(text).byteLength > maxBytes) throw new ContractError("DATA_LIMIT", "Frame exceeds limit");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ContractError("INVALID_JSON", "Invalid JSON frame"); }
  assertJson(value, maxBytes);
  return value;
}
