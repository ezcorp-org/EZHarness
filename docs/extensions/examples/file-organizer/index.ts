#!/usr/bin/env bun
// file-organizer — the sandboxed subprocess.
//
// Two responsibilities:
//   1. Render the 3 Hub pages (`definePage` × overview/review/folders),
//      reading the file-based state (proposals.json / config.json /
//      badge.json / .trash/manifest.json) via the HOST-MEDIATED SDK fs
//      helpers (raw node:fs is poisoned in the sandbox). Page-tree
//      building is delegated to the pure `lib/page.ts` builders.
//   2. Serve the File Organizer chat agent's tools (`createToolDispatcher`)
//      — workflow onboarding + config editing. Mutating tools write
//      config.json via host-mediated fs; the host daemon + Hub reflect it
//      on the next tick/render.
//
// ARCHITECTURE SPINE: this subprocess NEVER touches host folders
// (Desktop/Downloads/…) — its fs grant is `$CWD`-only. Accept/Reject that
// move/delete real files run HOST-SIDE in the events route; the daemon
// does the watching. Here we only read state for display + write config.

import { join } from "node:path";
import {
  getChannel,
  definePage,
  createToolDispatcher,
  toolResult,
  toolError,
  fsRead,
  fsWrite,
  fsList,
  fsExists,
  type ToolHandler,
  type HubPageTree,
  type PageActionEvent,
} from "@ezcorp/sdk/runtime";

import {
  buildOverview,
  buildReview,
  buildFolders,
  type OverviewView,
  type ReviewView,
  type FoldersView,
  type ReviewSegment,
} from "./lib/page";
import {
  emptyProposalsFile,
  type ProposalsFile,
} from "./lib/proposals";
import {
  validateConfig,
  addFolder,
  setFolderMode,
  toggleFolderPreset,
  addFolderRule,
  emptyConfig,
  type Config,
  type Mode,
  type BacklogPolicy,
} from "./lib/config";
import { parseDsl, PRESET_NAMES } from "./lib/rules";
import type { QuarantineEntry } from "./lib/quarantine";

// ── Data-dir resolution ─────────────────────────────────────────────
//
// The host injects EZCORP_PROJECT_ROOT; the canonical store is
// `<root>/.ezcorp/extension-data/file-organizer/`. We do NOT mkdir here
// (postinstall + the daemon own that); we only read/write existing files
// through the host-mediated fs helpers.

const PROJECT_ROOT = process.env.EZCORP_PROJECT_ROOT ?? process.cwd();
const DATA_DIR = join(PROJECT_ROOT, ".ezcorp", "extension-data", "file-organizer");

const PATHS = {
  proposals: join(DATA_DIR, "proposals.json"),
  config: join(DATA_DIR, "config.json"),
  badge: join(DATA_DIR, "badge.json"),
  manifest: join(DATA_DIR, ".trash", "manifest.json"),
  pidLock: join(DATA_DIR, ".daemon.pid"),
};

// ── Test seam: override the fs layer so render/tool tests don't need a
// live host channel. ────────────────────────────────────────────────

export interface FsLayer {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>;
}

const hostFs: FsLayer = {
  read: async (path) => {
    try {
      const r = await fsRead(path, { encoding: "utf-8" });
      return typeof r === "string" ? r : new TextDecoder().decode(r);
    } catch {
      return null;
    }
  },
  write: async (path, content) => {
    await fsWrite(path, content);
  },
  exists: async (path) => {
    try {
      return await fsExists(path);
    } catch {
      return false;
    }
  },
  list: async (path) => {
    try {
      return (await fsList(path)).map((e) => e.name);
    } catch {
      return [];
    }
  },
};

let fs: FsLayer = hostFs;
export function _setFsForTests(layer: FsLayer | null): void {
  fs = layer ?? hostFs;
}

// ── State readers ───────────────────────────────────────────────────

async function readProposals(): Promise<ProposalsFile> {
  const text = await fs.read(PATHS.proposals);
  if (text === null) return emptyProposalsFile();
  try {
    const parsed = JSON.parse(text) as Partial<ProposalsFile>;
    if (!parsed || !Array.isArray(parsed.proposals) || !Array.isArray(parsed.suppressed)) {
      return emptyProposalsFile();
    }
    return { proposals: parsed.proposals, suppressed: parsed.suppressed, schemaVersion: parsed.schemaVersion ?? 1 };
  } catch {
    return emptyProposalsFile();
  }
}

async function readConfig(): Promise<Config> {
  const text = await fs.read(PATHS.config);
  if (text === null) return emptyConfig();
  try {
    return validateConfig(JSON.parse(text));
  } catch {
    return emptyConfig();
  }
}

async function readBadge(): Promise<{ pending: number; unclassified: number; lastScanAt: string | null }> {
  const text = await fs.read(PATHS.badge);
  if (text === null) return { pending: 0, unclassified: 0, lastScanAt: null };
  try {
    const b = JSON.parse(text);
    return { pending: Number(b.pending) || 0, unclassified: Number(b.unclassified) || 0, lastScanAt: b.lastScanAt ?? null };
  } catch {
    return { pending: 0, unclassified: 0, lastScanAt: null };
  }
}

async function readQuarantine(): Promise<QuarantineEntry[]> {
  const text = await fs.read(PATHS.manifest);
  if (text === null) return [];
  try {
    const m = JSON.parse(text);
    return Array.isArray(m.entries) ? (m.entries as QuarantineEntry[]) : [];
  } catch {
    return [];
  }
}

/** The daemon is "running" iff its PID lockfile exists. */
async function daemonRunning(): Promise<boolean> {
  return fs.exists(PATHS.pidLock);
}

async function writeConfig(config: Config): Promise<void> {
  await fs.write(PATHS.config, JSON.stringify(config, null, 2));
}

// ── Page renders ────────────────────────────────────────────────────

export async function renderOverview(): Promise<HubPageTree> {
  try {
    const [proposals, config, badge, quarantine, running] = await Promise.all([
      readProposals(),
      readConfig(),
      readBadge(),
      readQuarantine(),
      daemonRunning(),
    ]);
    const pending = proposals.proposals.filter((p) => p.status === "pending");
    const unclassified = pending.filter((p) => p.kind === "unclassified");
    const mode = config.folders[0]?.mode ?? "ask-everything";
    const appliedToday = proposals.proposals.filter((p) => p.status === "applied" && isToday(p.resolvedAt)).length;
    const view: OverviewView = {
      state: "populated",
      daemonRunning: running,
      lastScanAt: badge.lastScanAt,
      mode,
      folderCount: config.folders.length,
      pending: pending.length,
      unclassified: unclassified.length,
      quarantined: quarantine.length,
      appliedToday,
      unclassifiedSamples: unclassified.slice(0, 10).map((p) => ({ proposalId: p.id, src: p.src })),
    };
    return buildOverview(view);
  } catch (err) {
    return buildOverview({ state: "error", errorMessage: String(err), daemonRunning: false, lastScanAt: null, mode: "ask-everything", folderCount: 0, pending: 0, unclassified: 0, quarantined: 0, appliedToday: 0, unclassifiedSamples: [] });
  }
}

let reviewSegment: ReviewSegment = "all";
let reviewOffset = 0;

export async function renderReview(): Promise<HubPageTree> {
  try {
    const [proposals, quarantine, running] = await Promise.all([readProposals(), readQuarantine(), daemonRunning()]);
    const autoBatch = computeAutoBatch(quarantine);
    const view: ReviewView = {
      state: "populated",
      daemonRunning: running,
      segment: reviewSegment,
      offset: reviewOffset,
      proposals: proposals.proposals,
      quarantine,
      now: Date.now(),
      ...(autoBatch ? { autoBatch } : {}),
    };
    return buildReview(view);
  } catch (err) {
    return buildReview({ state: "error", errorMessage: String(err), daemonRunning: false, segment: "all", offset: 0, proposals: [], quarantine: [], now: Date.now() });
  }
}

let foldersOffset = 0;

export async function renderFolders(): Promise<HubPageTree> {
  try {
    const [config, running] = await Promise.all([readConfig(), daemonRunning()]);
    const view: FoldersView = { state: "populated", daemonRunning: running, config, offset: foldersOffset };
    return buildFolders(view);
  } catch (err) {
    return buildFolders({ state: "error", errorMessage: String(err), daemonRunning: false, config: emptyConfig(), offset: 0 });
  }
}

// The most-recent auto-applied batch (fully-auto) → the undo affordance.
function computeAutoBatch(quarantine: QuarantineEntry[]): { batchId: string; moved: number; quarantined: number } | undefined {
  const batched = quarantine.filter((e) => e.batchId);
  if (batched.length === 0) return undefined;
  // Newest batch by deletedAt.
  const newest = batched.reduce((a, b) => (new Date(a.deletedAt) > new Date(b.deletedAt) ? a : b));
  const batchId = newest.batchId!;
  const inBatch = quarantine.filter((e) => e.batchId === batchId);
  return { batchId, moved: 0, quarantined: inBatch.length };
}

function isToday(iso: string | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth() && d.getUTCDate() === now.getUTCDate();
}

// ── Page action handlers ────────────────────────────────────────────
//
// The host events route does the heavy lifting (apply/reject/config) for
// mutating actions in-process; the subprocess action handlers here only
// own the PURE-VIEW state (segment selection / windowing) so the next
// render reflects the user's navigation. Mutating events that reach the
// subprocess (fall-through cases) are forwarded back via the events flow
// by the host; we simply no-op + let the next render pull fresh state.

const noopAction = async (_e: PageActionEvent): Promise<void> => {};

function selectSegmentAction(e: PageActionEvent): void {
  const seg = (e.payload?.segment as ReviewSegment | undefined);
  if (seg) { reviewSegment = seg; reviewOffset = 0; }
}
function pageWindowAction(e: PageActionEvent): void {
  const seg = e.payload?.segment as ReviewSegment | undefined;
  const offset = Number(e.payload?.offset);
  if (seg) reviewSegment = seg;
  if (Number.isFinite(offset) && offset >= 0) reviewOffset = offset;
}

// ── Tools (chat agent) ──────────────────────────────────────────────

interface WorkflowFolder {
  path: string;
  mode?: string;
  presets?: string[];
  backlogPolicy?: string;
}

const tools: Record<string, ToolHandler> = {
  describe_current_workflow: async (args) => {
    const notes = typeof args.notes === "string" ? args.notes : "";
    return toolResult(
      [
        "Captured your current habits:",
        notes ? `> ${notes}` : "> (no notes yet)",
        "",
        "Next, I'll propose a target workflow (folders + modes + presets) for you to confirm.",
      ].join("\n"),
    );
  },

  propose_target_workflow: async (args) => {
    const folders = Array.isArray(args.folders) ? (args.folders as WorkflowFolder[]) : [];
    if (folders.length === 0) return toolError("Provide at least one proposed folder");
    const rows = folders.map((f) => `| \`${f.path}\` | ${f.mode ?? "ask-everything"} | ${(f.presets ?? []).join(", ") || "none"} | ${f.backlogPolicy ?? "new-only"} |`);
    return toolResult(
      [
        "Here's a proposed workflow — confirm and I'll write it:",
        "",
        "| Folder | Mode | Presets | Backlog |",
        "|---|---|---|---|",
        ...rows,
      ].join("\n"),
    );
  },

  apply_workflow_config: async (args) => {
    const folders = Array.isArray(args.folders) ? (args.folders as WorkflowFolder[]) : [];
    if (folders.length === 0) return toolError("Provide at least one folder to apply");
    let config = await readConfig();
    const applied: string[] = [];
    const refused: string[] = [];
    let counter = 0;
    for (const f of folders) {
      const result = addFolder(config, {
        path: f.path,
        ...(isMode(f.mode) ? { mode: f.mode } : {}),
        presets: (f.presets ?? []).filter((p) => PRESET_NAMES.includes(p)),
        backlogPolicy: isBacklog(f.backlogPolicy) ? f.backlogPolicy : "new-only",
        now: Date.now(),
        idGen: () => `f-${Date.now()}-${counter++}`,
      });
      if (result.ok) { config = result.config; applied.push(f.path); }
      else refused.push(`${f.path} (${result.error})`);
    }
    await writeConfig(config);
    const lines = [`Applied ${applied.length} folder(s).`];
    if (refused.length > 0) lines.push(`Refused: ${refused.join("; ")}`);
    return toolResult(lines.join("\n"));
  },

  set_folder_rules: async (args) => {
    const folderId = typeof args.folderId === "string" ? args.folderId : "";
    if (!folderId) return toolError("folderId is required");
    let config = await readConfig();
    if (!config.folders.some((f) => f.id === folderId)) return toolError(`Unknown folder: ${folderId}`);
    if (isMode(args.mode)) config = setFolderMode(config, folderId, args.mode);
    if (Array.isArray(args.presets)) {
      const wanted = (args.presets as string[]).filter((p) => PRESET_NAMES.includes(p));
      // Toggle to exactly the wanted set.
      const folder = config.folders.find((f) => f.id === folderId)!;
      for (const p of PRESET_NAMES) {
        const has = folder.presets.includes(p);
        const want = wanted.includes(p);
        if (has !== want) config = toggleFolderPreset(config, folderId, p);
      }
    }
    await writeConfig(config);
    return toolResult(`Updated rules for folder ${folderId}.`);
  },

  teach_rule: async (args) => {
    const folderId = typeof args.folderId === "string" ? args.folderId : "";
    const ruleLine = typeof args.rule === "string" ? args.rule : "";
    if (!folderId || !ruleLine) return toolError("folderId and rule are required");
    const parsed = parseDsl(ruleLine);
    if (!parsed.ok) return toolError(`Invalid rule: ${parsed.error}`);
    let config = await readConfig();
    if (!config.folders.some((f) => f.id === folderId)) return toolError(`Unknown folder: ${folderId}`);
    config = addFolderRule(config, folderId, parsed.rule);
    await writeConfig(config);
    return toolResult(`Added rule: \`${parsed.rule.label}\` → ${parsed.rule.action}${parsed.rule.dest ? ` ${parsed.rule.dest}` : ""}.`);
  },

  propose_moves: async (args) => {
    const moves = Array.isArray(args.moves) ? (args.moves as Array<{ src: string; dst?: string; reason: string }>) : [];
    if (moves.length === 0) return toolError("Provide at least one move");
    // Agent-driven proposals are queued by appending to proposals.json so
    // they appear in the Hub Review page for the user to accept/reject.
    const file = await readProposals();
    const config = await readConfig();
    let added = 0;
    for (const m of moves) {
      if (!m.src || !m.reason) continue;
      const folder = config.folders.find((f) => m.src.startsWith(f.path + "/") || m.src === f.path);
      file.proposals.push({
        id: `agent-${Date.now()}-${added}`,
        kind: m.dst ? "move" : "unclassified",
        src: m.src,
        dst: m.dst ?? null,
        reason: m.reason,
        ruleId: null,
        ruleLabel: "agent",
        folderId: folder?.id ?? "",
        snapshot: { size: 0, mtimeMs: 0, isSymlink: false, dev: 0, ino: 0, nlink: 1 },
        status: "pending",
        dedupeKey: `agent|${m.src}|${m.dst ?? ""}`,
        createdAt: new Date().toISOString(),
        version: 0,
      });
      added++;
    }
    await fs.write(PATHS.proposals, JSON.stringify(file, null, 2));
    return toolResult(`Queued ${added} proposal(s) for review in the Hub.`);
  },

  organize_backlog: async (args) => {
    const folderId = typeof args.folderId === "string" ? args.folderId : "";
    if (!folderId) return toolError("folderId is required");
    const config = await readConfig();
    const folder = config.folders.find((f) => f.id === folderId);
    if (!folder) return toolError(`Unknown folder: ${folderId}`);
    // Switch the folder to include-existing so the daemon sweeps the
    // backlog on its next tick.
    const next: Config = {
      ...config,
      folders: config.folders.map((f) => (f.id === folderId ? { ...f, backlogPolicy: "include-existing" as BacklogPolicy, epochMs: undefined } : f)),
    };
    await writeConfig(next);
    return toolResult(`Backlog sweep enabled for \`${folder.path}\` — the watcher will process existing files on its next scan.`);
  },
};

function isMode(v: unknown): v is Mode {
  return v === "ask-everything" || v === "approve-non-destructive-only" || v === "fully-auto";
}
function isBacklog(v: unknown): v is BacklogPolicy {
  return v === "new-only" || v === "include-existing";
}

// ── Wiring ──────────────────────────────────────────────────────────

import { EVENTS } from "./lib/page";

export function register(): void {
  definePage({
    id: "overview",
    render: renderOverview,
    actions: { [EVENTS.reloadConfig]: noopAction },
  });
  definePage({
    id: "review",
    render: renderReview,
    actions: {
      [EVENTS.selectSegment]: (e) => { selectSegmentAction(e); },
      [EVENTS.pageWindow]: (e) => { pageWindowAction(e); },
      [EVENTS.focus]: noopAction,
    },
  });
  definePage({
    id: "folders",
    render: renderFolders,
    actions: { [EVENTS.reloadConfig]: noopAction },
  });
  createToolDispatcher(tools);
}

export function start(): void {
  register();
  getChannel().start();
}

export { tools };

// Production wiring — gated on import.meta.main so test imports don't open
// stdin (same pattern as the other examples).
if (import.meta.main) start();
