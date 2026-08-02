/**
 * The ez-factory prompt-hygiene chokepoint (invariants 12 + 13).
 *
 * ── Why this module is where the invariant lives ───────────────────────
 *
 * `configToAgent` (`src/runtime/config-to-agent.ts`) builds a workflow
 * `agent` step's call RAW: the seeded config's `prompt` becomes the system
 * message and the step's resolved input — including `$steps.<name>.output`,
 * which is how one step's result feeds the next — is spliced into the user
 * message as bare `key: value` lines. No framing, no redaction, no
 * delimiter stripping, no length bound. The extension does not build those
 * prompts and cannot fix that from its side.
 *
 * So the invariant is stated the only way that is grep-provable:
 *
 *   **No untrusted string reaches an agent step except through
 *   `read_files`, and `read_files` sanitizes.**
 *
 * That makes this module the single boundary every repository byte crosses
 * on its way to a model. It is PURE — no IO, no config, no injectable
 * behaviour — so it is exercised directly and cannot be routed around: a
 * caller that wants unsanitized content has to not call `read_files`, and
 * `read_files` is the only reader the extension ships.
 *
 * ── The pipeline, in the reference's exact order ───────────────────────
 *
 * Ported from the audited reference at
 * `docs/extensions/examples/ez-code-factory/lib/prompts.ts`, whose
 * `cleanedUserIntent` composes them as
 * `redactSecrets(stripAdversarial(sanitizePromptMultilineText(raw)))`.
 * That order is preserved verbatim and pinned by a named test — see
 * {@link sanitizeUntrusted} for what each step buys and why swapping two
 * of them changes the output.
 *
 * ── One addition the reference does not need ───────────────────────────
 *
 * {@link frameUntrusted} wraps sanitized text in the BEGIN/END markers the
 * seeded agent prompts name, and {@link neutralizeMarkers} makes that
 * wrapper un-escapable. The reference never needed this because its
 * markers are emitted by a prompt builder it owns end to end; here the
 * text is handed to a host builder that will not re-check anything, so a
 * file whose contents contain the END marker would otherwise close the
 * data region and have everything after it read as prompt.
 *
 * ── Stricter than the reference, deliberately ──────────────────────────
 *
 * In the reference, `redactSecrets` has exactly one caller
 * (`cleanedUserIntent`) and is applied to operator-authored intent text
 * only — never to file contents, shell output or diffs. Here it runs over
 * every byte `read_files` returns. A repository is not a trusted authoring
 * surface: a checked-in `.env.example` with a real key in it is the
 * ordinary case, not the adversarial one, and the run trace persists
 * whatever a step returned.
 */

/**
 * The markers the seeded agent prompts tell the model to honour.
 *
 * These MUST stay byte-identical to `UNTRUSTED_BEGIN_MARKER` /
 * `UNTRUSTED_END_MARKER` in `src/extensions/ez-factory-agents.ts`. A
 * mismatch does not fail — it silently turns the framing off, because the
 * prompt would be naming a delimiter that never appears in the input.
 *
 * They are RESTATED here rather than imported, and that is forced, not
 * lazy: this module runs inside the extension subprocess, whose sandbox
 * grants read-only access to the extension's own code directory,
 * `node_modules` and `packages` — `<projectRoot>/src` is TRAVERSE-only
 * (`src/extensions/subprocess.ts`, the `roPaths` / `traversePaths` split).
 * A value import of `../../../src/extensions/ez-factory-agents` would fail
 * at module load under the landlock and bwrap tiers (the "Transport
 * closed" bringup failure that file's own header describes), and it would
 * also drag `src/db/queries/agent-configs` — Drizzle plus PGlite — into a
 * process whose `node:fs` is poisoned.
 *
 * The guarantee is preserved by `sanitize.test.ts`, which imports the host
 * module (host-side, no sandbox) and asserts byte equality. A drift is
 * therefore a named red test, not a silent no-op. The HOST copy is
 * authoritative: if the two disagree, change this file.
 */
export const UNTRUSTED_BEGIN_MARKER = "-----BEGIN UNTRUSTED INPUT-----";
export const UNTRUSTED_END_MARKER = "-----END UNTRUSTED INPUT-----";

/**
 * Neuter prompt-control delimiters an attacker might embed in
 * user-controlled text (ChatML tokens, role tags, Llama/Mistral
 * instruction markers). A stop-gap, not a real defence — the real defence
 * is the "data, not instructions" framing around the wrapped text.
 *
 * Verbatim port of `stripAdversarial`
 * (`docs/extensions/examples/ez-code-factory/lib/prompts.ts`), itself
 * verbatim from the upstream `internal/intent/redact.go StripAdversarial`.
 */
export function stripAdversarial(text: string): string {
  return text
    .replaceAll("<|", "<<|")
    .replaceAll("|>", "|>>")
    .replaceAll("<system>", "<sys>")
    .replaceAll("</system>", "</sys>")
    .replaceAll("[INST]", "[inst]")
    .replaceAll("[/INST]", "[/inst]");
}

/**
 * Credential shapes redacted before untrusted text reaches an agent
 * prompt. From the reference's `SECRET_PATTERNS`, itself verbatim from
 * `internal/intent/redact.go secretPatterns`.
 *
 * ONE deviation, and it is semantically inert: the reference writes `\-`
 * inside its character classes, which biome flags as a useless escape
 * (`docs/extensions/examples/**` is outside the lint surface, so it never
 * fired there). The hyphens below sit LAST in their classes, where they
 * are literal without an escape. The matched language is unchanged, and
 * `sanitize.test.ts` covers every pattern with a live sample.
 */
const SECRET_PATTERNS: RegExp[] = [
  /(api[_-]?key|access[_-]?token|secret[_-]?(?:key|token)?|password|passwd|bearer|authorization)\s*[:=]\s*['"]?([A-Za-z0-9_./+=-]{12,})/gi,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

/** Replacement token. Named because two tests and `read_files`'s
 *  redaction-survives-a-write case all assert on it. */
export const REDACTED = "[REDACTED]";

/**
 * Replace likely credentials with `[REDACTED]`. Loose on purpose — we
 * would rather redact an innocent string than leak a real key. Verbatim
 * port of the reference's `redactSecrets`.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pat of SECRET_PATTERNS) out = out.replace(pat, REDACTED);
  return out;
}

/**
 * Collapse runs of whitespace within each line and strip conflict-marker
 * lookalikes (`<<<<<<<`, `=======`, `>>>>>>>`), normalizing CRLF/CR to LF.
 * Verbatim port of the reference's `sanitizePromptMultilineText`, itself
 * verbatim from `review.go`.
 *
 * NOTE FOR CALLERS: the whitespace collapse is per-line and includes
 * LEADING whitespace, so source indentation does not survive. That is the
 * reference's behaviour and it is kept — the collapse is what stops a
 * marker or a conflict delimiter being smuggled in split by whitespace
 * (see {@link frameUntrusted}) — but it means `read_files` returns code
 * whose indentation has been flattened. Fine for extraction and prose;
 * a caller that needs byte-exact source must not get it from here.
 */
export function sanitizePromptMultilineText(text: string): string {
  let t = text.replaceAll("<<<<<<<", " ").replaceAll("=======", " ").replaceAll(">>>>>>>", " ");
  t = t.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return t
    .split("\n")
    .map((line) => line.split(/\s+/).filter(Boolean).join(" "))
    .join("\n")
    .trim();
}

/**
 * The composed pipeline, in the reference's exact order.
 *
 * Order is load-bearing in both directions and `sanitize.test.ts` pins it
 * with a probe that distinguishes the two arrangements:
 *
 *   - `sanitizePromptMultilineText` FIRST, so conflict-marker lookalikes
 *     and CRLF are gone before anything else looks at the text, and so
 *     whitespace-split evasions (`s k - …` style) are collapsed into the
 *     single-spaced form the later patterns can see.
 *   - `stripAdversarial` SECOND. Running it first would let it MANUFACTURE
 *     a conflict marker that the already-finished whitespace pass can no
 *     longer remove: `"<<<<<<|"` has six `<` and no marker, but `<|` →
 *     `<<|` turns it into `"<<<<<<<|"`, which does.
 *   - `redactSecrets` LAST, so it sees the normalized single-spaced text
 *     rather than a key split across a line break.
 *
 * @param text raw untrusted text — file contents, operator notes, anything
 *             that did not come from this extension's own code.
 */
export function sanitizeUntrusted(text: string): string {
  return redactSecrets(stripAdversarial(sanitizePromptMultilineText(text)));
}

/**
 * Make the BEGIN/END data region un-escapable.
 *
 * Any occurrence of either marker inside the payload is broken by
 * inserting a zero-width-free, visually obvious separator, so the only
 * unbroken markers in the final string are the ones this module emitted.
 * Without it, a file containing the END marker closes the data region and
 * everything after it reads as prompt — which is precisely the attack the
 * framing exists to stop.
 *
 * MUST run AFTER {@link sanitizeUntrusted}, never before: the whitespace
 * collapse can CREATE a marker that was not in the input. `"-----BEGIN
 * \t UNTRUSTED\n INPUT-----"` is not a marker until
 * `sanitizePromptMultilineText` normalizes it into one, so neutralizing
 * first would let it through. Pinned by a named test.
 */
export function neutralizeMarkers(text: string): string {
  return text
    .replaceAll(UNTRUSTED_BEGIN_MARKER, "----- BEGIN-UNTRUSTED-INPUT -----")
    .replaceAll(UNTRUSTED_END_MARKER, "----- END-UNTRUSTED-INPUT -----");
}

/**
 * Sanitize, then wrap in the markers the seeded agent prompts name.
 *
 * This is what `read_files` returns for every file's `content`. The agent
 * prompts (`src/extensions/ez-factory-agents.ts`) tell the model that text
 * between these markers is data and that the rule holds for the whole
 * input whether or not the markers are present — so the framing is a
 * legibility aid layered on a rule that does not depend on it.
 */
export function frameUntrusted(text: string): string {
  const body = neutralizeMarkers(sanitizeUntrusted(text));
  return `${UNTRUSTED_BEGIN_MARKER}\n${body}\n${UNTRUSTED_END_MARKER}`;
}
