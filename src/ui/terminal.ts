import type { AgentLog, AgentEvents, LogLevel } from "../types";
import type { EventBus } from "../runtime/events";

// ── ANSI helpers (private) ──────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const _DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const GRAY = "\x1b[90m";

const CLEAR_LINE = "\x1b[2K";
const CURSOR_LEFT = "\x1b[G";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  debug: GRAY,
  info: "",
  warn: YELLOW,
  error: RED,
};

// ── Spinner ─────────────────────────────────────────────────────────

export interface Spinner {
  update(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
  stop(): void;
}

export function createSpinner(label: string): Spinner {
  let frame = 0;
  let text = label;
  let stopped = false;

  const write = (s: string) => process.stderr.write(s);

  write(HIDE_CURSOR);

  const timer = setInterval(() => {
    if (stopped) return;
    const spinner = `${BLUE}${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}${RESET}`;
    write(`${CLEAR_LINE}${CURSOR_LEFT}${spinner} ${text}`);
    frame++;
  }, 80);

  const finish = (icon: string, msg: string) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    write(`${CLEAR_LINE}${CURSOR_LEFT}${icon} ${msg}${SHOW_CURSOR}\n`);
  };

  return {
    update(newText: string) {
      text = newText;
    },
    succeed(msg: string) {
      finish(`${GREEN}✔${RESET}`, msg);
    },
    fail(msg: string) {
      finish(`${RED}✖${RESET}`, msg);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      write(`${CLEAR_LINE}${CURSOR_LEFT}${SHOW_CURSOR}`);
    },
  };
}

// ── Log line formatting ─────────────────────────────────────────────

export function formatLogLine(agentName: string, log: AgentLog): string {
  const d = new Date(log.timestamp);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const time = `${GRAY}[${hh}:${mm}:${ss}]${RESET}`;
  const name = `${BLUE}[${agentName}]${RESET}`;
  const color = LOG_LEVEL_COLORS[log.level];
  const message = color ? `${color}${log.message}${RESET}` : log.message;
  return `${time} ${name} ${message}`;
}

// ── Event bus connection ────────────────────────────────────────────

export function connectToEventBus(eventBus: EventBus<AgentEvents>): () => void {
  const spinners = new Map<string, Spinner>();

  const unsubs = [
    eventBus.on("run:start", ({ run }) => {
      const spinner = createSpinner(`${BOLD}${run.agentName}${RESET} running...`);
      spinners.set(run.id, spinner);
    }),

    eventBus.on("run:log", ({ runId, log }) => {
      // Temporarily clear spinner line, print log, spinner resumes on next tick
      const spinner = spinners.get(runId);
      if (spinner) {
        process.stderr.write(`${CLEAR_LINE}${CURSOR_LEFT}`);
      }
      process.stderr.write(formatLogLine("agent", log) + "\n");
    }),

    eventBus.on("run:complete", ({ run }) => {
      const spinner = spinners.get(run.id);
      const duration = run.finishedAt ? run.finishedAt - run.startedAt : 0;
      const durationStr = formatDurationShort(duration);
      spinner?.succeed(`${BOLD}${run.agentName}${RESET} done ${GRAY}(${durationStr})${RESET}`);
      spinners.delete(run.id);
    }),

    eventBus.on("run:error", ({ run, error }) => {
      const spinner = spinners.get(run.id);
      spinner?.fail(`${BOLD}${run.agentName}${RESET} ${RED}${error}${RESET}`);
      spinners.delete(run.id);
    }),

    eventBus.on("run:cancel", ({ run }) => {
      const spinner = spinners.get(run.id);
      spinner?.stop();
      spinners.delete(run.id);
    }),
  ];

  return () => {
    for (const unsub of unsubs) unsub();
    for (const spinner of spinners.values()) spinner.stop();
    spinners.clear();
  };
}

// Inline duration helper to avoid circular dependency with format.ts
function formatDurationShort(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
