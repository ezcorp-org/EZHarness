/**
 * Single redaction boundary for ALL audit-write call sites.
 *
 * Wraps `insertAuditEntry` (`src/db/queries/audit-log.ts`) so every
 * existing call site (18+) plus every future capability handler runs
 * its metadata through this function before the JSONB hits Postgres.
 *
 * Threat model (Phase 50): credential leakage. The closed set of
 * patterns below targets the credentials EZCorp's tool/extension surface
 * can reasonably emit — provider API keys, JWTs, bearer tokens, env-style
 * key names. This is NOT a 500-pattern PII redactor; libraries like
 * `redact-pii` are a wrong-shape fit for this threat surface.
 *
 * Invariants:
 *   1. Pure function, no side effects.
 *   2. Never throws — on internal failure returns
 *      `{ redacted: "[REDACTION_FAILED]", redactedFields: [], truncated: false }`
 *      so the calling audit insert still has a payload to write.
 *   3. Defensive against circular references via a WeakSet visited set.
 *   4. 8 KB serialized JSON cap; over-cap stores first 4 KB plus a sha256
 *      of the original-after-redaction so forensic analysis is still
 *      possible without storing the secret-bearing bulk.
 *   5. Recursive descent — patterns apply to strings at ANY depth, in
 *      object values, array items, and nested `Error.message` bodies
 *      (Pitfall #1 in `.planning/research/PITFALLS.md`).
 *
 * Style precedent: `sanitizeEnv` in `src/runtime/tools/shell.ts:14-24`
 * for the env-name regex. We extend that key-match shape with a closed
 * set of value-pattern regexes for credential-shaped strings.
 *
 * Open-question resolutions for this module (per Phase 50 spec):
 *   - SHA-256 hashing: mirror `src/runtime/lessons/distiller.ts:505-517`
 *     — Bun.CryptoHasher fast path; node:crypto fallback for non-Bun
 *     test runners (Vitest in `web/`).
 */

// CR-5: ESM import (project standard for src/extensions/). The logger
// module is side-effect-free at top level and exports a lazily-
// initialized child binding, so the previous require()-with-fallback
// dance was unnecessary defensive code. The node:crypto require()s
// further down stay — they're documented Bun fallbacks for a different
// purpose (Bun.CryptoHasher fast path).
import { logger } from "../logger";

const log = logger.child("audit-redaction");

export interface RedactionResult {
  /** The redacted payload — same shape as input, with secrets replaced
   *  by the literal string `"[REDACTED]"`. May be a truncation marker
   *  (`{ __truncated: true, … }`) when the input exceeded `maxBytes`. */
  redacted: unknown;
  /** JSON paths of every redacted location. Examples: `"headers.authorization"`,
   *  `"messages[2].error.cause.message"`, `"$"` (root primitive). */
  redactedFields: string[];
  /** True when the serialized JSON exceeded `maxBytes`. The result then
   *  carries a sha256 of the post-redaction original for forensic anchor. */
  truncated: boolean;
  /** SHA-256 hex of the post-redaction full JSON when truncated. */
  sha256?: string;
}

export interface RedactionOptions {
  /** Default 8192 (8 KB). */
  maxBytes?: number;
}

const REDACTED = "[REDACTED]";
const FAILURE_MARKER = "[REDACTION_FAILED]";
const DEFAULT_MAX_BYTES = 8192;
const TRUNCATION_KEEP_BYTES = 4096;

// ── Value-pattern regexes ─────────────────────────────────────────────
//
// Each regex is intentionally narrow to avoid false positives on
// adjacent text. The closed set:
//   - OpenAI keys: `sk-`, `sk-live-`, `sk-test-`, `sk-proj-`
//   - Anthropic keys: `sk-ant-`
//   - Google keys: `AIza...` (39 chars total)
//   - AWS access keys: `AKIA[0-9A-Z]{16}`
//   - GitHub PAT (modern): `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` + 36
//   - Bearer tokens: `Bearer <opaque>` (with a length floor so it
//     doesn't match the literal word "Bearer" alone)
//   - JWT compact form: three base64url segments separated by dots,
//     starting with `eyJ` (`{"alg":...`-prefix base64-encoded)
const VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  // OpenAI keys, all variants. Matches:
  //   sk-<20+ chars>           (legacy)
  //   sk-live_<20+>            (rotated, underscore separator)
  //   sk-test-<20+>            (test, dash separator)
  //   sk-proj-<20+> / sk-proj_<20+>
  // The optional `(?:live|test|proj)[-_]` group sits before the bulk
  // body so plain `sk-...` matches without requiring a second separator.
  /sk-(?:(?:live|test|proj)[-_])?[A-Za-z0-9_-]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{32,}/g,
  // Google API keys: `AIza` + 35 base64-url chars; published format is
  // 39 chars total. Some real-world keys are slightly longer; we accept
  // 35–40 trailing chars to avoid false negatives.
  /\bAIza[0-9A-Za-z_-]{35,40}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

// ── Key-pattern regex (case-insensitive, applied to property names) ──
//
// Mirrors `SENSITIVE_ENV_PATTERNS` at `src/runtime/tools/shell.ts:14`
// plus the canonical credential-bearing HTTP header names.
const SENSITIVE_KEY_PATTERN =
  /^(?:authorization|x-api-key|openai-organization|openai-project|cookie|set-cookie|proxy-authorization)$/i;
const SENSITIVE_ENV_KEY_PATTERN = /SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || SENSITIVE_ENV_KEY_PATTERN.test(key);
}

/**
 * Redact a single string value. Returns either the original string (no
 * matches) or a fully-replaced `[REDACTED]` marker when ANY pattern
 * matched. Whole-string replacement keeps the contract stable
 * (callers can rely on `=== REDACTED` to detect a match downstream)
 * and prevents partial-secret leaks where a regex consumed only part
 * of a long token.
 */
function redactString(value: string): { value: string; matched: boolean } {
  for (const re of VALUE_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(value)) {
      return { value: REDACTED, matched: true };
    }
  }
  return { value, matched: false };
}

/**
 * Recursively walk a payload, returning a deep clone with sensitive
 * values replaced. Path tracking uses dot/bracket notation so the
 * caller can see exactly where redactions happened.
 */
function walk(
  node: unknown,
  path: string,
  fields: string[],
  visited: WeakSet<object>,
): unknown {
  // Primitives.
  if (node === null || node === undefined) return node;
  if (typeof node === "string") {
    const { value, matched } = redactString(node);
    if (matched) fields.push(path || "$");
    return value;
  }
  if (typeof node === "number" || typeof node === "boolean" || typeof node === "bigint") {
    return typeof node === "bigint" ? node.toString() : node;
  }
  if (typeof node === "function" || typeof node === "symbol") {
    // Drop these — not JSON-serializable anyway.
    return undefined;
  }

  // Buffers / typed arrays — coerce to base64 placeholder. We cannot
  // pattern-match raw bytes meaningfully; the safest move is to elide
  // them with a length marker.
  if (node instanceof Uint8Array) {
    return `[binary ${node.byteLength}B]`;
  }

  // Errors — preserve `.message` (which may itself contain a Bearer
  // token nested in the string body) and `.cause` recursively.
  if (node instanceof Error) {
    const errObj: Record<string, unknown> = {
      name: node.name,
      message: node.message,
    };
    // Include `cause` if present (ES2022).
    if ((node as { cause?: unknown }).cause !== undefined) {
      errObj.cause = (node as { cause?: unknown }).cause;
    }
    // Include any enumerable own props (e.g. status, code).
    for (const [k, v] of Object.entries(node)) {
      if (!(k in errObj)) errObj[k] = v;
    }
    return walk(errObj, path, fields, visited);
  }

  // Objects + arrays — circular guard.
  if (typeof node === "object") {
    if (visited.has(node as object)) {
      return "[Circular]";
    }
    visited.add(node as object);

    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (let i = 0; i < node.length; i++) {
        out.push(walk(node[i], `${path}[${i}]`, fields, visited));
      }
      return out;
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${k}` : k;
      if (isSensitiveKey(k)) {
        // Whole-value redact regardless of shape — string, object, etc.
        // Exception: strings already get the regex pass via `walk`, but
        // a sensitive key signals "redact even non-matching strings".
        if (v !== null && v !== undefined) {
          fields.push(childPath);
          out[k] = REDACTED;
        } else {
          out[k] = v;
        }
        continue;
      }
      out[k] = walk(v, childPath, fields, visited);
    }
    return out;
  }

  return node;
}

function sha256Hex(input: string): string {
  // Bun fast path; node:crypto fallback. Mirrors the pattern at
  // `src/runtime/lessons/distiller.ts:505-517`.
  const BunGlobal = (globalThis as unknown as {
    Bun?: { CryptoHasher: new (algo: string) => { update(s: string): void; digest(enc: string): string } };
  }).Bun;
  if (BunGlobal?.CryptoHasher) {
    const h = new BunGlobal.CryptoHasher("sha256");
    h.update(input);
    return h.digest("hex");
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Defensive serialization. JSON.stringify with a replacer so circular
 * refs that slipped past `walk` (shouldn't happen, but defense-in-depth)
 * don't blow up the redactor.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function") return undefined;
    if (typeof v === "symbol") return undefined;
    return v;
  });
}

export function redactForAudit(
  payload: unknown,
  opts: RedactionOptions = {},
): RedactionResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  try {
    const fields: string[] = [];
    const visited = new WeakSet<object>();
    const redacted = walk(payload, "", fields, visited);

    let serialized: string;
    try {
      serialized = safeStringify(redacted);
    } catch (e) {
      log.warn("audit-redaction stringify failed", { error: String(e) });
      return { redacted: FAILURE_MARKER, redactedFields: [], truncated: false };
    }

    // `serialized` may be `undefined` when the top-level value is a
    // bare function/symbol. Coerce to "null" so byte-length math works.
    const bytes = serialized ? Buffer.byteLength(serialized, "utf8") : 4;

    if (bytes <= maxBytes) {
      return { redacted, redactedFields: fields, truncated: false };
    }

    // Truncate. Keep first 4 KB of the redacted serialization (so a
    // human reader can still get the gist) plus a sha256 of the FULL
    // post-redaction string for forensic comparison.
    const truncatedBody = serialized.slice(0, TRUNCATION_KEEP_BYTES);
    return {
      redacted: {
        __truncated: true,
        bodyPreview: truncatedBody,
        originalBytes: bytes,
      },
      redactedFields: fields,
      truncated: true,
      sha256: sha256Hex(serialized),
    };
  } catch (e) {
    log.error("audit-redaction failed", { error: String(e) });
    return { redacted: FAILURE_MARKER, redactedFields: [], truncated: false };
  }
}
