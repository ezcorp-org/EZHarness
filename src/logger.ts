export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

// Lazy-loaded error persistence to avoid circular dependency (logger -> DB -> logger)
let _persistError: ((opts: { level: string; message: string; stack?: string | null; metadata?: Record<string, unknown> | null }) => Promise<void>) | null = null;
let _persistingError = false;

async function getPersistError() {
  if (!_persistError) {
    const mod = await import("./db/queries/error-logs");
    _persistError = mod.persistError;
  }
  return _persistError;
}

function getThreshold(): number {
  const env = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVELS[env] ?? LEVELS.info;
}

/**
 * Per-subsystem debug override, independent of the global `LOG_LEVEL`. Lets an
 * operator turn on debug logging for ONE subsystem (e.g. a single extension)
 * without flipping the whole process to the `LOG_LEVEL=debug` firehose.
 *
 * `EZCORP_DEBUG` semantics:
 *   - unset / empty            → no override (global `LOG_LEVEL` applies)
 *   - "1" | "true" | "*" | "all" → debug for EVERY subsystem
 *   - comma list (e.g. "ext,preview.reaper") → debug for any subsystem that
 *     equals, or is namespaced under (`entry + "."`), a listed entry. So
 *     `ext` matches every `ext.*`; `ext.github-projects` matches the whole
 *     feature (`ext.github-projects.daemon`, `.handler`, …).
 *
 * Read per-emit (like `getThreshold`) so flipping the env takes effect without
 * a code change. Only ever RAISES verbosity for matches — never lowers it.
 */
function debugMatches(subsystem: string | undefined): boolean {
  const raw = process.env.EZCORP_DEBUG?.trim();
  if (!raw) return false;
  if (raw === "1" || raw === "true" || raw === "*" || raw === "all") return true;
  if (!subsystem) return false;
  for (const entry of raw.split(",")) {
    const ns = entry.trim();
    if (!ns) continue;
    if (subsystem === ns || subsystem.startsWith(`${ns}.`)) return true;
  }
  return false;
}

/** Effective level threshold for a log line: the global threshold, raised to
 *  `debug` when the line's subsystem is selected by `EZCORP_DEBUG`. */
function thresholdFor(subsystem: string | undefined): number {
  return debugMatches(subsystem) ? LEVELS.debug : getThreshold();
}

interface Logger {
  error(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  debug(msg: string, extra?: Record<string, unknown>): void;
  child(subsystem: string): Logger;
}

function createLogger(fields?: Record<string, unknown>): Logger {
  function emit(level: LogLevel, msg: string, extra?: Record<string, unknown>) {
    if (LEVELS[level] > thresholdFor(fields?.subsystem as string | undefined)) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields, ...extra }) + "\n";
    if (level === "error" || level === "warn") {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }

    // Fire-and-forget error persistence with recursion guard
    if (level === "error" && !_persistingError) {
      _persistingError = true;
      getPersistError()
        .then(fn => fn({ level, message: msg, stack: extra?.stack as string, metadata: { ...fields, ...extra } }))
        .catch(() => {}) // never throw from logger
        .finally(() => { _persistingError = false; });
    }
  }

  return {
    error: (msg, extra?) => emit("error", msg, extra),
    warn: (msg, extra?) => emit("warn", msg, extra),
    info: (msg, extra?) => emit("info", msg, extra),
    debug: (msg, extra?) => emit("debug", msg, extra),
    child: (subsystem: string) => createLogger({ ...fields, subsystem }),
  };
}

export const logger = createLogger();

/**
 * THE EXTENSION LOGGING STANDARD. Every extension / integration host-side
 * module MUST obtain its logger here instead of calling `logger.child(...)`
 * directly, so all extension logs share the `ext.<name>` subsystem namespace.
 * That single convention is what makes the on/off toggle ergonomic:
 *   - `EZCORP_DEBUG=ext`                → debug for ALL extensions
 *   - `EZCORP_DEBUG=ext.github-projects`→ debug for one extension (every
 *                                         component: daemon, handler, spawn, …)
 *
 * `name` is the extension's manifest slug; `component` namespaces a sub-part.
 *   extensionLogger("github-projects", "daemon") → subsystem "ext.github-projects.daemon"
 *   extensionLogger("github-projects")           → subsystem "ext.github-projects"
 *
 * Level guidance + field conventions live in `docs/extensions/logging.md`.
 */
export function extensionLogger(name: string, component?: string): Logger {
  return logger.child(component ? `ext.${name}.${component}` : `ext.${name}`);
}
