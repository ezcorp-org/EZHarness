/**
 * The value shapes a factory startup document is made of, shared by the
 * startup parser and by every section another module owns (the key service).
 * No imports: the Node orchestration process loads this file as it is.
 */

export type FieldKind = "identity" | "path" | "port" | "interval" | "url" | "roots" | "statement" | "count";

/** Exactly these keys, no more and no fewer. */
export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

export function wellFormed(kind: FieldKind, value: unknown): boolean {
  switch (kind) {
    case "identity":
      return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
    case "path":
      return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\0");
    case "port":
      return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
    case "interval":
      return Number.isSafeInteger(value) && (value as number) >= 10 && (value as number) <= 600_000;
    case "count":
      return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1_024;
    case "statement":
      return typeof value === "string" && value.length >= 1 && value.length <= 512 && !value.includes("\0");
    case "roots":
      return Array.isArray(value) && value.length >= 1 && value.length <= 32
        && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 4_096 && !item.includes("\0"));
    default:
      return httpsUrl(value);
  }
}

export function httpsUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}
