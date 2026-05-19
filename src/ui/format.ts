import type { AgentStatus, AgentDefinition } from "../types";

// ── ANSI helpers ────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const UNDERLINE = "\x1b[4m";

// ── Duration formatting ─────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (ms < 3_600_000) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(ms / 3_600_000);
  const remainMinutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${remainMinutes}m`;
}

// ── Status formatting ───────────────────────────────────────────────

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: DIM,
  running: BLUE,
  success: GREEN,
  error: RED,
  cancelled: YELLOW,
};

export function formatStatus(status: AgentStatus): string {
  const color = STATUS_COLORS[status];
  return `${color}\u2022${RESET} ${color}${status}${RESET}`;
}

// ── Agent list formatting ───────────────────────────────────────────

export function formatAgentList(agents: AgentDefinition[]): string {
  if (agents.length === 0) return "No agents registered.";

  const nameWidth = Math.max(
    "Name".length,
    ...agents.map((a) => a.name.length),
  );
  const descWidth = Math.max(
    "Description".length,
    ...agents.map((a) => a.description.length),
  );

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));

  const header = `${pad("Name", nameWidth)}  ${pad("Description", descWidth)}  Capabilities`;
  const separator = `${UNDERLINE}${header}${RESET}`;

  const rows = agents.map((a) => {
    const caps = a.capabilities.join(", ");
    return `${pad(a.name, nameWidth)}  ${pad(a.description, descWidth)}  ${caps}`;
  });

  return [separator, ...rows].join("\n");
}
