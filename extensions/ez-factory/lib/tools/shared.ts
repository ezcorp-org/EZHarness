/**
 * Bounds, input validation and the small primitives the three ez-factory
 * tools share.
 *
 * ── Invariant E: over-cap or malformed input is REJECTED, never truncated
 *
 * Ported from the audited reference at `ez-code-factory/lib/runs.ts`
 * (retired 2026-08-03 in phase 9; read it in git history)
 * (`parseRespondPayload` and the `MAX_*` block above it), whose comment
 * states the reason: *"a silently truncated findingIds/addedFindings list
 * could drop the very finding a user meant to fix, which is worse than a
 * rejected respond they can re-issue."*
 *
 * It applies here for a sharper reason than it does there. A workflow
 * `tool` step's `input` is ref-resolved from earlier steps' output
 * (`resolveMapping` in `src/runtime/workflow-executor.ts`), and for
 * ez-factory those earlier steps are AGENTS. So every one of these fields
 * can carry a value a model produced from a repository it was pointed at.
 * Clamping an over-long path or truncating over-cap content would mean the
 * artifact a run emits is quietly not the artifact the pipeline computed,
 * and nothing anywhere would say so.
 *
 * The distinction that matters, and the reason both halves of the tool
 * contract can be true at once:
 *
 *   - Malformed or over-cap **input** → REJECTED. The tool returns an
 *     error result; inside a workflow that fails the step loudly.
 *   - Too much **data discovered on disk** → recorded in `skipped[]`. That
 *     is not a caller error, it is the world being bigger than the budget,
 *     and `read_files` reports it rather than throwing.
 */
import { dirname, join, normalize } from "node:path";

// ── Bounds ────────────────────────────────────────────────────────────

/**
 * Serialized-output ceiling for any single tool, in bytes of UTF-8 JSON.
 *
 * **This is the number the design doc gets wrong, and it fails late.**
 * `MAX_STEP_OUTPUT_BYTES = 256 * 1024` (`src/runtime/workflow-step-output.ts`)
 * caps what a workflow step may persist; over it, the row stores an
 * overflow SENTINEL instead of the value. On resume, `loadStepResults`
 * fails closed on that sentinel (`src/db/queries/workflow-runs.ts`) and
 * `resumeWorkflow` turns it into `refuseTerminal("step-output-unavailable")`.
 *
 * A run only meets that on RESUME — which means: it runs, spends its whole
 * LLM budget, parks on an approval gate, waits for a human, gets approved,
 * and is terminally refused at that moment. The design doc's 4 MB budget
 * for `read_files` is 16× over the cap, so that is not a tail case, it is
 * the default path.
 *
 * 200 KB leaves ~56 KB of headroom under the host cap for the
 * `{"success":true,"output":…}` wrapper `runToolStep` builds and for the
 * JSON escaping the host applies on top. Every tool's serialized output is
 * asserted under `MAX_STEP_OUTPUT_BYTES` by a named per-tool test.
 */
export const MAX_TOOL_OUTPUT_BYTES = 200 * 1024;

/** Default `read_files` budget. Well under the ceiling so an ordinary
 *  call leaves room for a later step's output in the same run. */
export const DEFAULT_READ_TOTAL_BYTES = 128 * 1024;

/** Per-file ceiling for `read_files`. A file over this is `skipped[]`. */
export const MAX_FILE_BYTES = 256 * 1024;

/** Directory-recursion depth ceiling for `read_files`. */
export const MAX_DEPTH = 8;

/** Directories `read_files` will list before it stops descending. */
export const MAX_DIRS = 500;

/** Files `read_files` will return. */
export const MAX_FILES = 100;

/** Glob patterns accepted per `read_files` call, and each one's length. */
export const MAX_GLOBS = 20;
export const MAX_GLOB_LEN = 200;

/** Longest relative path any tool accepts or emits. */
export const MAX_PATH_LEN = 1024;

/**
 * Content ceiling for `write_file` / `emit_artifact`, in UTF-8 bytes.
 *
 * 4 MB is safe on the WRITE side where the read side's 200 KB is not,
 * because these tools' step OUTPUT is `{path, bytes, sha256}` — a few
 * dozen bytes regardless of payload size. Only the `resolved_input`
 * telemetry column sees the big value, and truncating that costs an
 * operator some trace detail and costs correctness nothing
 * (`MAX_RESOLVED_INPUT_BYTES`'s own doc comment says exactly this).
 */
export const MAX_WRITE_BYTES = 4 * 1024 * 1024;

/** Artifact `name` length bound for `emit_artifact`. */
export const MAX_ARTIFACT_NAME_LEN = 128;

/** Run-id length bound for `emit_artifact`. */
export const MAX_RUN_ID_LEN = 128;

/** Extension-data subtree `emit_artifact` writes under, relative to the
 *  project root. `.ezcorp/extension-data/<name>/` is the binding location
 *  for extension state (`src/extensions/CLAUDE.md`), and the subprocess
 *  sandbox grants exactly that directory read-write. */
export const ARTIFACT_DIR_SEGMENTS = [".ezcorp", "extension-data", "ez-factory", "artifacts"];

// ── Rejection ─────────────────────────────────────────────────────────

/**
 * A rejected call. Carries a stable `code` so a workflow author can tell a
 * bad ref from a real failure without string-matching the message.
 *
 * Thrown by the validators below and converted to a tool error result by
 * {@link runTool}; never caught to "fix up" a value.
 */
export class ToolInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolInputError";
    this.code = code;
  }
}

// ── Validators ────────────────────────────────────────────────────────

/** The tool `input` object itself. A workflow ref that resolved to a
 *  scalar or null lands here. */
export function requireObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolInputError("invalid-input", "input must be an object");
  }
  return input as Record<string, unknown>;
}

/** A required string field, non-empty after trimming. */
export function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string") {
    throw new ToolInputError("invalid-input", `"${field}" must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new ToolInputError("invalid-input", `"${field}" must not be empty`);
  }
  return trimmed;
}

/** An optional string field. Absent/undefined/null → `undefined`; present
 *  but not a string → rejected (never coerced). */
export function optionalString(
  input: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ToolInputError("invalid-input", `"${field}" must be a string when present`);
  }
  return value.trim();
}

/**
 * An optional positive integer bounded by `max`.
 *
 * Over `max` is REJECTED rather than clamped — invariant E. A caller that
 * asked for a 4 MB read budget has a mistaken model of what will happen,
 * and silently handing back 200 KB would confirm it.
 *
 * A NUMERIC STRING is accepted, and that is a workflow requirement rather
 * than laxity: `validateWorkflow` rejects any step `input` mapping value
 * that is not a string (`src/runtime/workflow-validator.ts`), so a
 * template literally cannot write `maxFiles: 40` — only `maxFiles: "40"`.
 * Nothing applies `inputSchema.default` at run time either, so an unset
 * `$input.x` arrives as `undefined` with its key present; that is the
 * `undefined` branch above.
 *
 * The coercion is STRICT: only a canonical base-10 integer. `"1.5"`,
 * `"0x10"`, `"40abc"`, `" "` and `""` are rejected, so a mis-typed ref
 * fails loudly instead of silently becoming `NaN` or `0`.
 */
export function optionalBoundedInt(
  input: Record<string, unknown>,
  field: string,
  max: number,
): number | undefined {
  const raw = input[field];
  if (raw === undefined || raw === null) return undefined;
  let value: number;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string" && /^[0-9]+$/.test(raw.trim())) {
    value = Number(raw.trim());
  } else {
    throw new ToolInputError(
      "invalid-input",
      `"${field}" must be a positive integer, or a string holding one`,
    );
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new ToolInputError("invalid-input", `"${field}" must be a positive integer`);
  }
  if (value > max) {
    throw new ToolInputError(
      "over-cap",
      `"${field}" is ${value}, over the ${max} ceiling — rejected, not clamped`,
    );
  }
  return value;
}

/**
 * A non-empty list of bounded strings, given EITHER as an array or as a
 * newline-separated string.
 *
 * Both forms exist for the same reason the numeric coercion does: a
 * workflow step's `input` mapping values must be strings, so a template
 * can only write a literal list as one string. A `$input.x` /
 * `$steps.x.output.y` ref can still deliver a real array, so both are
 * accepted and normalized here.
 *
 * NEWLINE, not comma: a glob may legitimately contain a comma inside a
 * brace expansion (`src/**\/*.{ts,tsx}`), and splitting on it would
 * silently turn one correct pattern into two broken ones.
 *
 * Over the count cap or the per-entry length cap is REJECTED, not sliced.
 */
export function requireStringList(
  input: Record<string, unknown>,
  field: string,
  maxCount: number,
  maxLen: number,
): string[] {
  const raw = input[field];
  let entries: unknown[];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (typeof raw === "string") {
    entries = raw.split("\n").filter((line) => line.trim() !== "");
  } else {
    throw new ToolInputError(
      "invalid-input",
      `"${field}" must be an array of strings, or a newline-separated string`,
    );
  }
  if (entries.length === 0) {
    throw new ToolInputError("invalid-input", `"${field}" must not be empty`);
  }
  if (entries.length > maxCount) {
    throw new ToolInputError(
      "over-cap",
      `"${field}" has ${entries.length} entries, over the ${maxCount} cap — rejected, not truncated`,
    );
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ToolInputError("invalid-input", `every "${field}" entry must be a non-empty string`);
    }
    if (entry.length > maxLen) {
      throw new ToolInputError(
        "over-cap",
        `a "${field}" entry is ${entry.length} chars, over the ${maxLen} cap — rejected, not truncated`,
      );
    }
    out.push(entry.trim());
  }
  return out;
}

/**
 * Required file content, size-capped in UTF-8 BYTES (not UTF-16 code
 * units — a multi-byte payload must be measured the way the host measures
 * it).
 *
 * An OBJECT or ARRAY is accepted and pretty-printed as JSON. A workflow
 * threading a previous step's whole result into an artifact
 * (`content: "$steps.write.output"`) is the ordinary case, and the ref
 * language hands that over as a real object — rejecting it would force
 * every template to add a `transform` step whose only job is
 * `JSON.stringify`.
 *
 * A bare number, boolean or null is REJECTED. Those are what a mis-typed
 * ref produces, and writing `"null"` into an artifact a human will later
 * read is exactly the silent-wrong-output failure invariant E exists to
 * prevent. The cap applies to the SERIALIZED bytes, and over it is
 * rejected, never truncated.
 */
export function requireContent(input: Record<string, unknown>, field: string): string {
  const raw = input[field];
  let value: string;
  if (typeof raw === "string") {
    value = raw;
  } else if (typeof raw === "object" && raw !== null) {
    value = JSON.stringify(raw, null, 2);
  } else {
    throw new ToolInputError(
      "invalid-input",
      `"${field}" must be a string, or an object/array to serialize as JSON`,
    );
  }
  const bytes = utf8Bytes(value);
  if (bytes > MAX_WRITE_BYTES) {
    throw new ToolInputError(
      "over-cap",
      `"${field}" is ${bytes} bytes, over the ${MAX_WRITE_BYTES}-byte cap — rejected, not truncated`,
    );
  }
  return value;
}

/**
 * A relative path that stays inside `root`.
 *
 * Rejects absolute paths, NUL bytes, `..` in any position, and anything
 * whose normalized form escapes the root. The HOST is the enforcement —
 * the fs reverse-RPC realpaths before the PDP authorizes against the
 * `$CWD` grant, so a bypass here still hits a deny. This is defence in
 * depth AND a better error: a workflow author sees "path escapes the
 * project root" instead of an opaque permission denial three layers down.
 */
export function resolveWithinRoot(root: string, relPath: string, field: string): string {
  if (relPath.length > MAX_PATH_LEN) {
    throw new ToolInputError(
      "over-cap",
      `"${field}" is ${relPath.length} chars, over the ${MAX_PATH_LEN} cap — rejected, not truncated`,
    );
  }
  if (relPath.includes("\0")) {
    throw new ToolInputError("invalid-path", `"${field}" must not contain a NUL byte`);
  }
  if (relPath.startsWith("/")) {
    throw new ToolInputError("invalid-path", `"${field}" must be relative to the project root`);
  }
  if (relPath.split(/[\\/]/).includes("..")) {
    throw new ToolInputError("invalid-path", `"${field}" must not contain ".." segments`);
  }
  const abs = normalize(join(root, relPath));
  const base = normalize(root);
  if (abs !== base && !abs.startsWith(base.endsWith("/") ? base : `${base}/`)) {
    throw new ToolInputError("invalid-path", `"${field}" escapes the project root`);
  }
  return abs;
}

/**
 * A single filename slug: letters, digits, `.`, `_`, `-`. No separator of
 * any kind, so a traversal attempt is not merely normalized away — it is
 * unrepresentable, which is a stronger property than being rejected by a
 * check somebody could later reorder.
 *
 * `.` and `..` are rejected explicitly: both match the character class and
 * neither is a filename.
 */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function requireSlug(
  input: Record<string, unknown>,
  field: string,
  maxLen: number,
): string {
  return assertSlug(requireString(input, field), field, maxLen);
}

/** {@link requireSlug} for a value that did not come from the input bag —
 *  the run id derived from the host's conversation coordinate. Host-supplied
 *  or not, it is validated identically before it becomes a path segment. */
export function assertSlug(value: string, field: string, maxLen: number): string {
  if (value.length > maxLen) {
    throw new ToolInputError(
      "over-cap",
      `"${field}" is ${value.length} chars, over the ${maxLen} cap — rejected, not truncated`,
    );
  }
  if (value === "." || value === "..") {
    throw new ToolInputError("invalid-name", `"${field}" must be a filename, not "${value}"`);
  }
  if (!SLUG_RE.test(value)) {
    throw new ToolInputError(
      "invalid-name",
      `"${field}" must match ${SLUG_RE.source} — no path separators, no leading dot`,
    );
  }
  return value;
}

// ── Primitives ────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * UTF-8 byte length of a value's JSON form — what the host actually
 * measures against `MAX_STEP_OUTPUT_BYTES`. `read_files` budgets against
 * this rather than raw content length because JSON escaping inflates:
 * a quote costs two bytes, a control character costs six, so 200 KB of
 * raw text can serialize well past the cap.
 */
export function serializedBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : encoder.encode(json).length;
}

/**
 * Lowercase hex SHA-256, via WebCrypto.
 *
 * `crypto.subtle` is used rather than `node:crypto` or `Bun.CryptoHasher`
 * because it is a standard global that the sandbox preload does not touch,
 * so the same code runs in the subprocess and in tests.
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── The filesystem seam ───────────────────────────────────────────────

/**
 * The host-mediated fs surface the tools use, named as an interface so
 * `index.ts` can bind the real `@ezcorp/sdk/runtime` helpers and tests can
 * bind an in-memory tree.
 *
 * This is deliberately the ONLY injected dependency. The sanitizer is
 * hard-wired into `read_files` and cannot be substituted, because a seam
 * there would leave the real path unpinned: a test that swapped in a
 * pass-through would prove nothing about what ships, and the "no untrusted
 * string reaches an agent step except through `read_files`, and
 * `read_files` sanitizes" claim would stop being grep-provable.
 */
export interface FactoryFs {
  list(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>>;
  /** Size in bytes, so `read_files` can enforce its per-file cap WITHOUT
   *  pulling a multi-megabyte file across the reverse-RPC to discard it. */
  stat(path: string): Promise<{ size: number }>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<{ bytes: number }>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** What every tool factory needs: the fs surface, the project root the
 *  `$CWD` grant resolves to, and the host's conversation coordinate. */
export interface ToolDeps {
  fs: FactoryFs;
  /** Absolute path of the active project. Resolved per call by `index.ts`
   *  from the host-supplied tool context; the host's `$CWD` grant is what
   *  actually bounds writes, so a wrong value here denies rather than
   *  escapes. */
  projectRoot(): string;
  /** The host's conversation coordinate for THIS call, forwarded on
   *  `_meta.ezConversationId`. Inside a workflow it is the synthetic
   *  `workflow-run:<uuid>` scope key — see {@link runIdFromConversation}. */
  conversationId(): string | undefined;
}

/** Prefix the workflow executor puts on its synthetic conversation key
 *  (`workflowScopeKey` in `src/runtime/workflow-executor.ts`). */
export const WORKFLOW_SCOPE_PREFIX = "workflow-run:";

/**
 * The workflow run id for the current call, or `undefined` outside a
 * workflow.
 *
 * **This is why `emit_artifact` has no required `runId` argument.** There
 * is no `$run.*` root in the ref language — `resolveInputRef` handles
 * `$input.`, `$loop.`, `$prev`, `$steps.` and `$result`, and nothing else
 * — so a workflow template has no way to name its own run id. A required
 * argument would have made the tool uncallable from the templates it
 * exists to serve.
 *
 * Deriving it here is also strictly safer than taking it as input: the
 * value comes from the HOST (`executeToolCall` sets
 * `_meta.ezConversationId` from the scope key it was dispatched with), so
 * a run cannot claim another run's artifact directory. An explicit
 * `runId` still overrides, for chat-driven calls that have no workflow.
 */
export function runIdFromConversation(conversationId: string | undefined): string | undefined {
  if (conversationId === undefined || !conversationId.startsWith(WORKFLOW_SCOPE_PREFIX)) {
    return undefined;
  }
  const runId = conversationId.slice(WORKFLOW_SCOPE_PREFIX.length).trim();
  return runId === "" ? undefined : runId;
}

/**
 * Create the parent directory, write, and describe the result.
 *
 * Shared by `write_file` and `emit_artifact` so there is exactly one
 * write path and exactly one output shape. That shape —
 * `{path, bytes, sha256}` — is what keeps both tools' step output tiny
 * regardless of payload size, which is why their 4 MB content cap is safe
 * where `read_files`'s would not be.
 *
 * `bytes` is what the HOST reports having written, not what we computed
 * locally: if the two ever disagree, the caller should learn the host's
 * number. `sha256` is over the content as sent, so it is directly usable
 * as the next call's `ifMatch`.
 */
export async function writeAndDescribe(
  deps: ToolDeps,
  absPath: string,
  relPath: string,
  content: string,
): Promise<{ path: string; bytes: number; sha256: string }> {
  await deps.fs.mkdir(dirname(absPath));
  const { bytes } = await deps.fs.write(absPath, content);
  return { path: relPath, bytes, sha256: await sha256Hex(content) };
}

// ── Result plumbing ───────────────────────────────────────────────────

/** The shape every ez-factory tool returns on success. Serialized once,
 *  by {@link runTool}, so no tool can forget the size assertion. */
export type ToolPayload = Record<string, unknown>;

/**
 * A discriminated union rather than `{text, isError, code?}` on purpose:
 * an error outcome ALWAYS carries a code, so the wire adapter in
 * `./index.ts` has two reachable branches instead of three, one of which
 * could never happen and could never be tested.
 */
export type ToolOutcome =
  | { ok: true; text: string }
  | { ok: false; text: string; code: string };

/**
 * Serialize a tool's payload, enforcing the output ceiling, and convert a
 * {@link ToolInputError} into an error outcome.
 *
 * The size check is HERE rather than in each tool so it cannot be skipped.
 * If a payload somehow exceeds the ceiling the call fails loudly at the
 * source instead of persisting an overflow sentinel that only fails on a
 * resume, hours later, after a human has approved the run.
 */
export async function runTool(
  name: string,
  build: () => Promise<ToolPayload>,
): Promise<ToolOutcome> {
  let payload: ToolPayload;
  try {
    payload = await build();
  } catch (err) {
    if (err instanceof ToolInputError) {
      return { ok: false, text: `${name}: ${err.message}`, code: err.code };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, text: `${name}: ${message}`, code: "failed" };
  }
  const text = JSON.stringify(payload);
  const bytes = utf8Bytes(text);
  if (bytes > MAX_TOOL_OUTPUT_BYTES) {
    return {
      ok: false,
      text:
        `${name}: result is ${bytes} bytes, over the ${MAX_TOOL_OUTPUT_BYTES}-byte ceiling. ` +
        "A workflow step cannot persist this and would fail closed on resume.",
      code: "output-too-large",
    };
  }
  return { ok: true, text };
}
