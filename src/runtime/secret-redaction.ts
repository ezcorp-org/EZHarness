/**
 * Credential redaction for values on their way into durable storage.
 *
 * Ported into core from the reference extension's prompt hygiene
 * (`docs/extensions/examples/ez-code-factory/lib/prompts.ts` —
 * `SECRET_PATTERNS` / `redactSecrets`), which in turn took the patterns
 * verbatim from `internal/intent/redact.go`. The patterns are reproduced
 * unchanged so the two implementations cannot drift into disagreeing
 * about what counts as a secret.
 *
 * **Deliberately loose.** We would rather redact an innocent string than
 * leak a real key. A false positive costs an operator one confusing
 * `[REDACTED]` in a trace; a false negative writes a live credential into
 * a table that the run history UI renders.
 *
 * Used by `workflow_step_runs.output` (and, later, the rest of the run
 * trace): a step's result carries whatever an extension tool returned,
 * which is exactly the untrusted surface this exists for.
 */

/** Credential shapes replaced with `[REDACTED]`. Verbatim from the port. */
const SECRET_PATTERNS: RegExp[] = [
  /(api[_-]?key|access[_-]?token|secret[_-]?(?:key|token)?|password|passwd|bearer|authorization)\s*[:=]\s*['"]?([A-Za-z0-9_\-./+=]{12,})/gi,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  // `-` is last in each class, so it is a literal without escaping; the
  // port writes it `\-`, which biome flags as redundant. Same language.
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

/**
 * Replace likely credentials in one string with `[REDACTED]`.
 *
 * Only ever calls `String.replace`, never `RegExp.test`/`exec`: the
 * patterns carry the `g` flag, and `replace` resets `lastIndex` while the
 * stateful methods do not — a shared global regex driven by `test` would
 * skip every other match.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pat of SECRET_PATTERNS) out = out.replace(pat, "[REDACTED]");
  return out;
}

/**
 * Redact every string ANYWHERE in a JSON-shaped value.
 *
 * Object KEYS are left alone — a key is a field name chosen by the
 * workflow author, not untrusted content, and rewriting one would change
 * the shape a later `$steps.<name>.<field>` ref addresses. Only values
 * are scrubbed.
 *
 * Non-string primitives pass through untouched, so a redaction pass never
 * changes a value's TYPE — an `eq` condition against a number keeps
 * working.
 */
export function redactSecretsDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactSecretsDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactSecretsDeep(v);
    return out;
  }
  return value;
}
