/**
 * What a pass leaves behind for a reader, whatever happened to it.
 *
 * The W19a merge batch lost a failed pass's diagnostics: the harness kept each
 * process's output in memory and deleted the stack directory when the pass
 * stopped, so the pool's and the supervisor's facts were gone. Two things fix
 * that:
 *
 *   - every process's output streams to `<label>.process-<name>.log` in the
 *     pass's output directory as it arrives, between a harness header (the
 *     command and its pid) and an exit line, so even a process that prints
 *     nothing leaves a file that says it ran and how it ended;
 *   - on a failed pass, the stack directory's readiness files and logs are
 *     copied to `<label>.stack/` before the directory is deleted.
 *
 * The stack directory also holds keys and tokens, and a process can print one.
 * Nothing leaves it carrying a secret: every credential under `secrets/` (each
 * non-JSON file's content, and each value under a credential key inside a JSON
 * file) and every extra value the stack names is collected first. A file that contains one is refused, not
 * copied, and the refusal is recorded by path; a streamed log that contains one
 * has each occurrence replaced by `[redacted]`, and the count is recorded.
 * `secrets/` itself is never copied.
 */
import { createWriteStream, type WriteStream } from "node:fs";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export interface PassDiagnostics {
  /** The pass's output directory. */
  readonly dir: string;
  /** The pass's record name, the prefix of every file it writes. */
  readonly label: string;
}

/** The shortest value treated as a secret; shorter strings would redact ordinary words. */
const MIN_SECRET_LENGTH = 12;
/** A file larger than this under `secrets/` is not a credential this harness wrote. */
const MAX_SECRET_FILE_BYTES = 64 * 1024;
/** A stack file larger than this is not copied; its size is recorded instead. */
const MAX_COPY_BYTES = 5 * 1024 * 1024;

export function processLogPath(diagnostics: PassDiagnostics, name: string): string {
  return join(diagnostics.dir, `${diagnostics.label}.process-${name}.log`);
}

export function stackCopyDir(diagnostics: PassDiagnostics): string {
  return join(diagnostics.dir, `${diagnostics.label}.stack`);
}

export interface ProcessLog {
  readonly path: string;
  write(chunk: Buffer | string): void;
  /** Writes the exit line and resolves once every byte is on disk. */
  close(exit: { readonly code: number | null; readonly signal: string | null }): Promise<void>;
}

/** Opens one process's streamed log and writes its header. Paths and a pid only, never an environment. */
export function openProcessLog(diagnostics: PassDiagnostics, name: string, command: string, args: readonly string[], pid: number | undefined, now: () => Date = () => new Date()): ProcessLog {
  const path = processLogPath(diagnostics, name);
  const stream: WriteStream = createWriteStream(path, { flags: "w", mode: 0o600 });
  stream.write(`[w19-harness] ${name} started ${now().toISOString()} pid ${pid ?? "unknown"}: ${[command, ...args].join(" ")}\n`);
  let closed: Promise<void> | undefined;
  return {
    path,
    write(chunk) { if (closed === undefined) stream.write(chunk); },
    close(exit) {
      closed ??= new Promise<void>((resolve, reject) => {
        stream.end(`[w19-harness] ${name} exited ${now().toISOString()} code ${exit.code ?? "none"} signal ${exit.signal ?? "none"}\n`, () => resolve());
        stream.once("error", reject);
      });
      return closed;
    },
  };
}

/**
 * The JSON keys whose values are credentials. `secrets/` also holds each
 * process's configuration document, whose ids, namespaces and paths are not
 * secrets; treating them as secrets refused every readiness file and redacted
 * the Temporal namespace out of its own log (measured on the first W19b run).
 */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set(["accessKey", "secretKey", "accessKeyId", "secretAccessKey", "password", "token", "apiKey", "databaseUrl"]);

function credentialLeaves(value: unknown, key: string | undefined, into: string[]): void {
  if (typeof value === "string") { if (key !== undefined && CREDENTIAL_KEYS.has(key)) into.push(value); }
  else if (Array.isArray(value)) for (const item of value) credentialLeaves(item, key, into);
  else if (value !== null && typeof value === "object") for (const [name, item] of Object.entries(value)) credentialLeaves(item, name, into);
}

/** URL passwords are secrets even inside a longer value, so a database URL yields its password too. */
function urlPasswords(value: string): string[] {
  try {
    const password = decodeURIComponent(new URL(value).password);
    return password ? [password] : [];
  } catch { return []; }
}

/**
 * Every secret value the stack holds: each non-JSON file under `secrets/` (a
 * token, a key, a certificate), each credential inside a JSON file there, any
 * URL password among them, and the extra values the caller names (secrets that
 * live only in a process environment).
 */
export async function collectSecretValues(secretsDir: string, extra: readonly string[] = []): Promise<string[]> {
  const values = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length < MIN_SECRET_LENGTH) return;
    values.add(trimmed);
    for (const password of urlPasswords(trimmed)) if (password.length >= MIN_SECRET_LENGTH) values.add(password);
  };
  for (const value of extra) add(value);
  let names: string[] = [];
  try { names = await readdir(secretsDir); } catch { return [...values]; }
  for (const name of names) {
    const path = join(secretsDir, name);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_SECRET_FILE_BYTES) continue;
    const text = await readFile(path, "utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { add(text); continue; }
    const leaves: string[] = [];
    credentialLeaves(parsed, undefined, leaves);
    for (const leaf of leaves) add(leaf);
  }
  // Longest first, so a value that contains another is redacted whole.
  return [...values].sort((left, right) => right.length - left.length);
}

/** Replaces every secret in each streamed log with `[redacted]`, and says how many per file. */
export async function redactStreamedLogs(paths: readonly string[], secrets: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const path of paths) {
    let text: string;
    try { text = await readFile(path, "utf8"); } catch { continue; }
    let count = 0;
    for (const secret of secrets) {
      const parts = text.split(secret);
      if (parts.length > 1) { count += parts.length - 1; text = parts.join("[redacted]"); }
    }
    if (count > 0) { await writeFile(path, text, { mode: 0o600 }); counts[path] = count; }
  }
  return counts;
}

async function walk(root: string, directory: string, into: string[], unreadable: string[]): Promise<void> {
  let entries: Dirent[];
  // A runner store can hold directories owned by a guest's mapped user; one
  // that cannot be read is named, never allowed to stop the rest of the copy.
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { unreadable.push(relative(root, directory) || "."); return; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Keys and tokens live here; nothing under it ever leaves.
      if (relative(root, path) === "secrets") continue;
      await walk(root, path, into, unreadable);
    } else if (entry.isFile()) {
      into.push(path);
    }
  }
}

export interface PreservedStack {
  readonly copied: readonly string[];
  /** Files that carried a secret, by path relative to the stack root. Never copied. */
  readonly refused: readonly string[];
  /** Files over the size bound, with their size. Not copied. */
  readonly oversize: Readonly<Record<string, number>>;
  /** Directories that could not be read. */
  readonly unreadable: readonly string[];
}

/**
 * Copies the stack's readiness files and logs out before the directory goes.
 *
 * `readiness/*.json` carries each host process's own last word (the pool's and
 * the supervisor's lifecycle and error code); any `*.log` under the stack is
 * copied too. Each file is scanned for every secret value first, and a file
 * that carries one is refused.
 */
export async function preserveStackDiagnostics(root: string, diagnostics: PassDiagnostics, secrets: readonly string[]): Promise<PreservedStack> {
  const files: string[] = [];
  const unreadable: string[] = [];
  await walk(root, root, files, unreadable);
  const wanted = files.filter((path) => (relative(root, path).startsWith("readiness/") && path.endsWith(".json")) || path.endsWith(".log"));
  const copied: string[] = [];
  const refused: string[] = [];
  const oversize: Record<string, number> = {};
  for (const path of wanted) {
    const name = relative(root, path);
    const size = (await stat(path)).size;
    if (size > MAX_COPY_BYTES) { oversize[name] = size; continue; }
    const text = await readFile(path, "utf8");
    if (secrets.some((secret) => text.includes(secret))) { refused.push(name); continue; }
    const destination = join(stackCopyDir(diagnostics), name);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(path, destination);
    copied.push(name);
  }
  return { copied, refused, oversize, unreadable };
}

/** The processes every pass starts, whose streamed logs a failed pass must leave. */
export const PASS_PROCESSES = ["pool", "supervisor", "temporal", "temporal-tls", "gateway-stub", "web", "orchestrator"] as const;
/** The readiness files a failed pass must carry out of its stack. */
export const PASS_READINESS_FILES = ["readiness/pool.json", "readiness/supervisor.json", "readiness/orchestration.json"] as const;

export interface DiagnosticsCheck {
  readonly ok: boolean;
  readonly processLogs: Readonly<Record<string, { readonly bytes: number; readonly exitLine: boolean }>>;
  readonly readiness: Readonly<Record<string, number>>;
  readonly problems: readonly string[];
}

async function size(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return -1; }
}

/**
 * What a failed pass left behind, checked from the files alone: every
 * process's streamed log exists, is non-empty, and ends with its exit line,
 * and every readiness file was carried out of the stack non-empty.
 */
export async function checkPassDiagnostics(diagnostics: PassDiagnostics): Promise<DiagnosticsCheck> {
  const problems: string[] = [];
  const processLogs: Record<string, { bytes: number; exitLine: boolean }> = {};
  for (const name of PASS_PROCESSES) {
    const path = processLogPath(diagnostics, name);
    const bytes = await size(path);
    const exitLine = bytes > 0 && /\[w19-harness\] \S+ exited .*\n$/.test(await readFile(path, "utf8"));
    processLogs[name] = { bytes, exitLine };
    if (bytes <= 0) problems.push(`process log ${name} is ${bytes < 0 ? "missing" : "empty"}`);
    else if (!exitLine) problems.push(`process log ${name} has no exit line`);
  }
  const readiness: Record<string, number> = {};
  for (const name of PASS_READINESS_FILES) {
    readiness[name] = await size(join(stackCopyDir(diagnostics), name));
    if (readiness[name] <= 0) problems.push(`stack file ${name} is ${readiness[name] < 0 ? "missing" : "empty"}`);
  }
  return { ok: problems.length === 0, processLogs, readiness, problems };
}
