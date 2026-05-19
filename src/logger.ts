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

interface Logger {
  error(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  debug(msg: string, extra?: Record<string, unknown>): void;
  child(subsystem: string): Logger;
}

function createLogger(fields?: Record<string, unknown>): Logger {
  function emit(level: LogLevel, msg: string, extra?: Record<string, unknown>) {
    if (LEVELS[level] > getThreshold()) return;
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
