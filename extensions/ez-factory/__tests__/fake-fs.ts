/**
 * An in-memory `FactoryFs` for the tool tests.
 *
 * Lives under `__tests__/` deliberately: `NON_SOURCE_GLOBS` in
 * `scripts/coverage-config.ts` excludes `**\/__tests__/**`, so this helper
 * is not product code and does not need (or get) a coverage threshold.
 *
 * ── What it is allowed to fake, and what it is not ─────────────────────
 *
 * The FILESYSTEM only. `ToolDeps` injects `fs` and `projectRoot` and
 * nothing else — in particular the sanitizer is imported directly by
 * `read_files` and cannot be substituted. So every test below exercises
 * the REAL `frameUntrusted` over fake bytes, which is the arrangement that
 * keeps "no untrusted string reaches an agent step except through
 * `read_files`, and `read_files` sanitizes" a property of the shipped code
 * rather than of the test double.
 */
import type { FactoryFs, ToolDeps } from "../lib/tools/shared";

export const PROJECT_ROOT = "/proj";

export interface FakeFsOptions {
  /** The host's conversation coordinate for the call. Inside a workflow
   *  this is `workflow-run:<uuid>`; undefined for a chat-driven call. */
  conversationId?: string;
  /** Absolute directory paths whose `list` throws (a host permission
   *  denial, or a directory that vanished mid-walk). */
  unreadableDirs?: string[];
  /** Absolute file paths whose `read`/`stat` throws. */
  unreadableFiles?: string[];
  /** Dirents that are neither a file nor a directory (sockets, fifos),
   *  keyed by the absolute directory that lists them. */
  otherEntries?: Record<string, string[]>;
  /** Absolute paths whose `write` throws. */
  unwritableFiles?: string[];
}

export interface FakeFs {
  fs: FactoryFs;
  deps: ToolDeps;
  /** Live file contents, including anything written during the test. */
  store: Map<string, string>;
  /** Every `mkdir` argument, in order. */
  mkdirs: string[];
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/** @param files absolute path → contents */
export function makeFakeFs(files: Record<string, string>, opts: FakeFsOptions = {}): FakeFs {
  const store = new Map(Object.entries(files));
  const mkdirs: string[] = [];
  const explicitDirs = new Set<string>();
  const unreadableDirs = new Set(opts.unreadableDirs ?? []);
  const unreadableFiles = new Set(opts.unreadableFiles ?? []);
  const unwritableFiles = new Set(opts.unwritableFiles ?? []);
  const otherEntries = opts.otherEntries ?? {};

  const dirsOf = (): Set<string> => {
    const dirs = new Set<string>(explicitDirs);
    for (const path of store.keys()) {
      let dir = path.slice(0, path.lastIndexOf("/"));
      while (dir.length > 0) {
        dirs.add(dir);
        dir = dir.slice(0, dir.lastIndexOf("/"));
      }
    }
    for (const dir of Object.keys(otherEntries)) dirs.add(dir);
    return dirs;
  };

  const fs: FactoryFs = {
    async list(path) {
      if (unreadableDirs.has(path)) throw new Error(`EACCES: ${path}`);
      if (!dirsOf().has(path)) throw new Error(`ENOENT: ${path}`);
      const prefix = `${path}/`;
      const found = new Map<string, { isFile: boolean; isDirectory: boolean }>();
      for (const filePath of store.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) found.set(rest, { isFile: true, isDirectory: false });
        else found.set(rest.slice(0, slash), { isFile: false, isDirectory: true });
      }
      for (const name of otherEntries[path] ?? []) {
        found.set(name, { isFile: false, isDirectory: false });
      }
      return [...found].map(([name, kind]) => ({ name, ...kind }));
    },
    async stat(path) {
      if (unreadableFiles.has(path)) throw new Error(`EACCES: ${path}`);
      const content = store.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return { size: bytesOf(content) };
    },
    async read(path) {
      if (unreadableFiles.has(path)) throw new Error(`EACCES: ${path}`);
      const content = store.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async write(path, content) {
      if (unwritableFiles.has(path)) throw new Error(`EROFS: ${path}`);
      store.set(path, content);
      return { bytes: bytesOf(content) };
    },
    async mkdir(path) {
      mkdirs.push(path);
      explicitDirs.add(path);
    },
    async exists(path) {
      return store.has(path);
    },
  };

  return {
    fs,
    deps: {
      fs,
      projectRoot: () => PROJECT_ROOT,
      conversationId: () => opts.conversationId,
    },
    store,
    mkdirs,
  };
}

/** Parse a successful tool outcome's JSON payload, failing loudly (rather
 *  than returning `undefined`) if the outcome was an error — a test that
 *  silently read `undefined` off a rejected call would pass vacuously. */
export function payloadOf(outcome: { ok: boolean; text: string }): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`expected a successful outcome, got: ${outcome.text}`);
  return JSON.parse(outcome.text) as Record<string, unknown>;
}
