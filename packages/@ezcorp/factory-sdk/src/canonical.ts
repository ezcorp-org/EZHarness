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
