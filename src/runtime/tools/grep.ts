import { Type } from "@earendil-works/pi-ai";
import { validatePath } from "./validate";
import type { BuiltinToolDef } from "./types";
import { getToolOutputLimit, truncateText } from "./output-limits";

/**
 * Directories GNU grep must not descend into. ripgrep gets this for free by
 * honouring .gitignore; plain `grep -r` does not, so a recursive search from
 * the project root walks `node_modules` (often >1 GB), `.git`, and build
 * output — minutes of single-threaded I/O that trips the executor watchdog
 * and kills the whole run. This is the per-flag list because we spawn the
 * argv directly (no shell) so brace expansion is unavailable.
 */
const GREP_EXCLUDE_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".ezcorp",
  ".svelte-kit",
  ".next",
];

/**
 * Pure parser for the grep soft-timeout (ms). Mirrors
 * `parseMaxToolCallsPerTurn` so the env contract is unit-testable without
 * mutating `process.env`:
 *   - `undefined` (env unset)      → 30000 default
 *   - finite, strictly-positive    → `Math.floor`, clamped to [1000, 600000]
 *   - NaN / Infinity / non-numeric → 30000 default
 *   - zero or negative             → 30000 default
 */
export function parseGrepTimeoutMs(raw: string | undefined): number {
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      return Math.min(Math.max(Math.floor(n), 1000), 600000);
    }
  }
  return 30000;
}

export type SearchBackend = "rg" | "grep";

/**
 * Choose the search backend. ripgrep is preferred because it respects
 * `.gitignore` (skipping `node_modules` / build output for free) and runs
 * in parallel; GNU grep is the always-present POSIX fallback.
 * `EZCORP_GREP_BACKEND` forces a backend (debugging / tests). Pure +
 * unit-testable: callers pass the resolved `rg` path so this never touches
 * the filesystem.
 */
export function resolveBackend(
  rgPath: string | null,
  override: string | undefined,
): SearchBackend {
  if (override === "grep") return "grep";
  if (override === "rg") return "rg";
  return rgPath ? "rg" : "grep";
}

export interface GrepParams {
  pattern: string;
  path?: string;
  include?: string;
  caseSensitive?: boolean;
  contextLines?: number;
  maxResults?: number;
  noIgnore?: boolean;
}

/**
 * Build the argv for the chosen backend. Pure so the flag translation is
 * unit-testable without spawning. `searchPath` must already be the
 * symlink-validated absolute path. The pattern and path are passed after a
 * `--` / `-e` guard so a pattern beginning with `-` can't be parsed as a
 * flag (both an ergonomic and a small injection-hardening win).
 */
export function buildSearchArgs(
  backend: SearchBackend,
  params: GrepParams,
  searchPath: string,
): string[] {
  const contextLines = Math.min(Math.max(params.contextLines || 0, 0), 5);
  const maxResults = params.maxResults || 100;
  const args: string[] = [];

  if (backend === "rg") {
    // --with-filename forces a `path:line:` prefix even for a single-file
    // target so the matchCount regex + search-results card stay consistent
    // with the recursive (directory) case.
    args.push("--line-number", "--no-heading", "--color=never", "--with-filename");
    if (!params.caseSensitive) args.push("-i");
    if (contextLines > 0) args.push(`-C${contextLines}`);
    if (params.include) args.push("-g", params.include);
    if (params.noIgnore) args.push("--no-ignore");
    args.push(`--max-count=${maxResults}`);
    args.push("--", params.pattern, searchPath);
    return args;
  }

  args.push("-rn", "--color=never", "-I");
  if (!params.caseSensitive) args.push("-i");
  if (contextLines > 0) args.push(`-C${contextLines}`);
  if (params.include) args.push(`--include=${params.include}`);
  if (!params.noIgnore) {
    for (const d of GREP_EXCLUDE_DIRS) args.push(`--exclude-dir=${d}`);
  }
  args.push(`-m${maxResults}`);
  args.push("-e", params.pattern, searchPath);
  return args;
}

const RG_PATH = Bun.which("rg");

/**
 * Read a child stream fully but bounded to `maxBytes`. Returning early when
 * the cap is hit closes the reader, which SIGPIPEs the child on its next
 * write — so a runaway match set can't OOM us. Crucially, callers drain
 * stdout AND stderr concurrently: `grep -r` over a large tree emits a lot
 * of stderr (permission-denied, broken symlinks), and the old
 * read-stdout-then-stderr ordering let a full 64 KB stderr pipe buffer
 * block grep's write, stalling stdout into a deadlock until the 90 s
 * watchdog fired.
 */
async function drainBounded(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length >= maxBytes) break;
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

export function createGrepTool(projectPath: string): BuiltinToolDef {
  const softTimeoutMs = parseGrepTimeoutMs(process.env.EZCORP_GREP_TIMEOUT_MS);
  return {
    name: "grep",
    label: "grep",
    description:
      "Search for a pattern in files within the project. Returns matching lines with file paths and line numbers. Uses ripgrep (honours .gitignore) when available; set noIgnore to also search ignored files like node_modules.",
    category: "read",
    cardType: "search-results",
    // The tool owns its own soft timeout and always returns a graceful
    // result on expiry. Pin the watchdog deferral a margin above that soft
    // timeout so the watchdog can never preempt the tool's own clean
    // return — letting it preempt is exactly what turned a slow grep into
    // a whole-run kill ("Tool grep exceeded its 90000ms call timeout").
    callTimeoutMs: softTimeoutMs + 15000,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (regex)" },
        path: { type: "string", description: "Relative path to search in (default: project root)", default: "." },
        include: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts')" },
        caseSensitive: { type: "boolean", description: "Case sensitive search (default: true)", default: true },
        contextLines: { type: "number", description: "Lines of context around matches (0-5, default: 0)", default: 0 },
        maxResults: { type: "number", description: "Maximum matches per file (default: 100)", default: 100 },
        noIgnore: { type: "boolean", description: "Also search .gitignored files (node_modules, build output). Default: false", default: false },
      },
      required: ["pattern"],
    }),
    execute: async (_toolCallId, params: any, signal?: AbortSignal) => {
      try {
        const searchPath = validatePath(projectPath, params.path || ".");
        const backend = resolveBackend(RG_PATH, process.env.EZCORP_GREP_BACKEND);
        const cmd = backend === "rg" ? (RG_PATH as string) : "grep";
        const args = buildSearchArgs(backend, params, searchPath);
        const cap = getToolOutputLimit("grep");

        const proc = Bun.spawn([cmd, ...args], {
          cwd: projectPath,
          stdout: "pipe",
          stderr: "pipe",
        });

        const outcome = await Promise.race([
          (async () => {
            const [stdout, stderr] = await Promise.all([
              drainBounded(proc.stdout, cap),
              drainBounded(proc.stderr, cap),
            ]);
            const exitCode = await proc.exited;
            return { type: "done" as const, stdout, stderr, exitCode };
          })(),
          new Promise<{ type: "timeout" }>((r) =>
            setTimeout(() => r({ type: "timeout" }), softTimeoutMs),
          ),
          ...(signal
            ? [
                new Promise<{ type: "aborted" }>((r) =>
                  signal.addEventListener("abort", () => r({ type: "aborted" }), { once: true }),
                ),
              ]
            : []),
        ]);

        if (outcome.type === "timeout") {
          proc.kill();
          return {
            content: [
              {
                type: "text" as const,
                text: `Search timed out after ${softTimeoutMs}ms — narrow the pattern, or restrict 'path'/'include' to a subdirectory.`,
              },
            ],
            details: { isError: true, matchCount: 0, pattern: params.pattern, timeout: true },
          };
        }

        if (outcome.type === "aborted") {
          proc.kill();
          return {
            content: [{ type: "text" as const, text: "Search aborted." }],
            details: { isError: true, matchCount: 0, pattern: params.pattern, aborted: true },
          };
        }

        const { stdout, stderr, exitCode } = outcome;
        const trimmed = stdout.trim();

        // Exit 2 = a real error (bad regex, unreadable root). Check this
        // BEFORE the no-match case: both tools can also exit 2 from a
        // single unreadable file deep in the tree while still having
        // produced useful matches above it, so only treat exit 2 as fatal
        // when there is no output to salvage. (Ordering matters — the
        // `!trimmed` no-match check below would otherwise mask a genuine
        // error as a bland "No matches found.")
        if (exitCode === 2 && !trimmed) {
          return {
            content: [{ type: "text" as const, text: `Error: ${stderr.trim() || "search error"}` }],
            details: { isError: true, matchCount: 0 },
          };
        }

        // Exit 1 = "no matches" for both grep and ripgrep.
        if (exitCode === 1 || !trimmed) {
          return {
            content: [{ type: "text" as const, text: "No matches found." }],
            details: { matchCount: 0, pattern: params.pattern },
          };
        }

        // Count match lines only (filename:lineno:). Context lines use a
        // `filename-lineno-` separator and group breaks are `--`, so this
        // regex naturally excludes them.
        const matchCount = trimmed.split("\n").filter((l) => /^.+:\d+:/.test(l)).length;

        const { text, truncated, originalBytes } = truncateText(trimmed, cap, "grep");
        return {
          content: [{ type: "text" as const, text }],
          details: {
            matchCount,
            pattern: params.pattern,
            backend,
            ...(truncated ? { truncated: true, originalBytes } : {}),
          },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e.message}` }],
          details: { isError: true, matchCount: 0 },
        };
      }
    },
  };
}
