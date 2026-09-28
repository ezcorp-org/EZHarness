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
 * Nothing leaves it carrying a secret. Every secret is collected first: each
 * text file's content under `secrets/`, the hex and base64 forms of each binary
 * file there, every string inside a JSON file there except the values of an
 * explicit list of configuration keys, and every extra value the stack names.
 * The rule fails closed: a new JSON field is a secret until it is put on the
 * list. A file that contains a secret is refused, not copied, and the refusal
 * is recorded by path. A streamed log that contains one has each occurrence
 * replaced by `[redacted]`, and the count is recorded. The stack runs that
 * redaction on a timer while the pass runs, and once more after every process
 * has exited. `secrets/` itself is never copied.
 */
import { closeSync, openSync, readFileSync, writeFileSync, writeSync, type Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
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

/**
 * Opens one process's streamed log and writes its header. Paths and a pid
 * only, never an environment.
 *
 * Every write is synchronous and appends, so each chunk is on disk when the
 * call returns, and `redactStreamedLogs` can rewrite the file between two
 * chunks without losing one.
 */
export function openProcessLog(diagnostics: PassDiagnostics, name: string, command: string, args: readonly string[], pid: number | undefined, now: () => Date = () => new Date()): ProcessLog {
  const path = processLogPath(diagnostics, name);
  writeFileSync(path, `[w19-harness] ${name} started ${now().toISOString()} pid ${pid ?? "unknown"}: ${[command, ...args].join(" ")}\n`, { mode: 0o600 });
  const fd = openSync(path, "a");
  let closed: Promise<void> | undefined;
  return {
    path,
    write(chunk) { if (closed === undefined) writeSync(fd, typeof chunk === "string" ? Buffer.from(chunk) : chunk); },
    close(exit) {
      if (closed === undefined) {
        writeSync(fd, `[w19-harness] ${name} exited ${now().toISOString()} code ${exit.code ?? "none"} signal ${exit.signal ?? "none"}\n`);
        closeSync(fd);
        closed = Promise.resolve();
      }
      return closed;
    },
  };
}

/**
 * JSON keys whose string values are configuration, never credentials: ids,
 * names, addresses, digests and the like. `secrets/` holds each process's
 * configuration document next to its keys; treating these as secrets refused
 * every readiness file and redacted the Temporal namespace out of its own log
 * (measured on the first W19b run). Every other string in a JSON file under
 * `secrets/` is a secret, so a new field is redacted and refused until someone
 * puts its key here. `src/factory/graph-proof-diagnostics.test.ts` walks every
 * document the stack writes and fails on a field that is on neither side.
 */
export const CONFIGURATION_KEYS: ReadonlySet<string> = new Set([
  // Identity: which installation, tenant, pool, host and subject.
  "schemaVersion", "installationId", "tenantId", "poolId", "hostId", "hostIds", "hosts", "supervisorId", "tokenSubject",
  "hostKeyId", "masterKeyId", "certificateIdentity", "peerTenants", "issuer", "audience", "brokerAudience",
  // Where things are.
  "hostname", "serverName", "baseUrl", "endpoint", "address", "namespace", "temporalNamespace", "runnerRoot",
  "grantableRoots", "expectedDatabase", "expectedRole", "bucket", "prefix", "credentialSet",
  // Runner profiles and the model pin.
  "package", "manifestName", "version", "digest", "export", "resourceClass", "costMicros", "provider", "model", "configurationDigest", "policyDigest", "reasoningEffort",
  // Shared object store identities: the identity's name and its allowed actions.
  "name", "actions",
]);
/**
 * Keys whose object maps data (a subject, a key name) to a value. A string
 * directly under one is judged by the container's key, never by its own name.
 */
const DATA_MAP_KEYS: ReadonlySet<string> = new Set(["hosts", "peerTenants", "publicKeyPaths"]);

/** A key that names a file path: `*Path` or `*Paths`. The file's content is judged on its own. */
const isPathKey = (key: string) => /[a-z]Paths?$/.test(key);

export interface JsonStringLeaf {
  /** Where the string is, as `$.a.b[0]`. */
  readonly at: string;
  /** The key the string is judged by: its own, its array's, or its data map's. */
  readonly key: string | undefined;
  readonly value: string;
  readonly secret: boolean;
}

/** Every string in a JSON value, each judged secret unless its key is configuration or a path. */
export function jsonStringLeaves(value: unknown, key: string | undefined = undefined, at = "$", into: JsonStringLeaf[] = []): JsonStringLeaf[] {
  if (typeof value === "string") into.push({ at, key, value, secret: key === undefined || !(CONFIGURATION_KEYS.has(key) || isPathKey(key)) });
  else if (Array.isArray(value)) for (const [index, item] of value.entries()) jsonStringLeaves(item, key, `${at}[${index}]`, into);
  else if (value !== null && typeof value === "object") {
    const dataMap = key !== undefined && DATA_MAP_KEYS.has(key);
    for (const [name, item] of Object.entries(value)) jsonStringLeaves(item, dataMap && typeof item === "string" ? key : name, `${at}.${name}`, into);
  }
  return into;
}

/** Is this file's content text? Valid UTF-8 with no control character other than tab, line feed and carriage return. */
function isText(bytes: Buffer): boolean {
  if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) return false;
  return bytes.every((byte) => byte >= 0x20 ? byte !== 0x7f : byte === 0x09 || byte === 0x0a || byte === 0x0d);
}

/**
 * The forms a binary secret takes when a process prints it: hex in either
 * case, base64 with and without padding, and base64url.
 */
export function binaryForms(bytes: Buffer): string[] {
  const hex = bytes.toString("hex");
  const base64 = bytes.toString("base64");
  return [hex, hex.toUpperCase(), base64, base64.replace(/=+$/, ""), bytes.toString("base64url")];
}

/** URL passwords are secrets even inside a longer value, so a database URL yields its password too. */
function urlPasswords(value: string): string[] {
  try {
    const password = decodeURIComponent(new URL(value).password);
    return password ? [password] : [];
  } catch { return []; }
}

/**
 * Every secret value the stack holds: each text file under `secrets/` (a
 * token, a key, a certificate) whole, the printed forms of each binary file
 * there (the master key), each string inside a JSON file there that is not
 * configuration, the password of any URL anywhere among them (a configuration
 * string included), and the extra values the caller
 * names (secrets that live only in a process environment).
 */
export async function collectSecretValues(secretsDir: string, extra: readonly string[] = []): Promise<string[]> {
  const values = new Set<string>();
  const keep = (value: string) => { if (value.length >= MIN_SECRET_LENGTH) values.add(value); };
  // A URL's password is a secret wherever the URL sits, even under a configuration key.
  const addUrlPasswords = (value: string) => { for (const password of urlPasswords(value.trim())) keep(password); };
  const add = (value: string) => { keep(value.trim()); addUrlPasswords(value); };
  for (const value of extra) add(value);
  let names: string[] = [];
  try { names = await readdir(secretsDir); } catch { return [...values]; }
  for (const name of names) {
    const path = join(secretsDir, name);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_SECRET_FILE_BYTES) continue;
    const bytes = await readFile(path);
    if (!isText(bytes)) { for (const form of binaryForms(bytes)) add(form); continue; }
    const text = bytes.toString("utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { add(text); continue; }
    for (const leaf of jsonStringLeaves(parsed)) (leaf.secret ? add : addUrlPasswords)(leaf.value);
  }
  // Longest first, so a value that contains another is redacted whole.
  return [...values].sort((left, right) => right.length - left.length);
}

/**
 * Replaces every secret in each streamed log with `[redacted]`, and says how
 * many per file. Synchronous on purpose: no chunk from a running process can
 * land between the read and the rewrite, so a pass may call this at any time.
 */
export function redactStreamedLogs(paths: readonly string[], secrets: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const path of paths) {
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    let count = 0;
    for (const secret of secrets) {
      const parts = text.split(secret);
      if (parts.length > 1) { count += parts.length - 1; text = parts.join("[redacted]"); }
    }
    if (count > 0) { writeFileSync(path, text, { mode: 0o600 }); counts[path] = count; }
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

/** A refusal the product itself logged while the pass ran: which background role, and the error it named. */
export interface ProductRefusal { readonly role: string; readonly error: string }

/**
 * Every "[factory] background role failed" block in a pass's web log, in order. A pass that fails must name
 * what the product refused, not only its own teardown error (W02d P2: "Unable to connect" hid an admission
 * refused factory_budget_exhausted).
 */
export function backgroundRefusals(webLog: string): ProductRefusal[] {
  const refusals: ProductRefusal[] = [];
  for (const match of webLog.matchAll(/\[factory\] background role failed \{\s*role: "([^"]*)",\s*error: "([^"]*)",?\s*\}/g)) refusals.push({ role: match[1]!, error: match[2]! });
  return refusals;
}

const DETAIL_LIMIT = 300;

/** One clause per failing check: its name, what it expected when it says so, and what the pass saw, bounded. */
export function describeFailedChecks(checks: ReadonlyArray<{ readonly check: string; readonly ok: boolean; readonly expected?: unknown; readonly detail?: unknown }>): string {
  const shown = (value: unknown) => {
    const text = JSON.stringify(value) ?? String(value);
    return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
  };
  return checks.filter((entry) => !entry.ok).map((entry) => {
    const parts = [...(entry.expected === undefined ? [] : [`expected ${shown(entry.expected)}`]), ...("detail" in entry ? [`saw ${shown(entry.detail)}`] : [])];
    return parts.length === 0 ? entry.check : `${entry.check} (${parts.join(", ")})`;
  }).join("; ");
}
