// ── page.ts — pure Hub page-tree builders for all 3 pages ───────────
//
// Every page is built from a plain `PageView` snapshot (no IO) so each
// state is unit-testable: empty / loading / populated / daemon-off /
// error / stale-source / overflow / unclassified-alert /
// last-action-result / quarantine-segment / auto-batch-undo.
//
// Constraints honored (verified against page-schema.ts):
//   - tree ≤ 64KB / ≤ 500 nodes / ≤ 100 table rows
//   - ONE action per table row → dual-mode render (sections ≤12 items,
//     else table + focus)
//   - only input = a button/row action with a single-field prompt
//   - segment selection + 50-row windows + offset payload (pagination)
//   - "Last action" status section as the toast substitute
//
// All action `event` strings MUST be members of EVENTS (which mirrors
// the manifest `eventSubscriptions`), or the host validator drops them.

import { PageBuilder, type HubPageTree } from "@ezcorp/sdk/runtime";
import type { Proposal, ProposalKind } from "./proposals";
import type { Config, FolderConfig, Mode } from "./config";
import type { QuarantineEntry } from "./quarantine";
import { PRESET_NAMES } from "./rules";

// ── Event names (mirror manifest eventSubscriptions) ────────────────

export const EVENTS = {
  selectSegment: "file-organizer:select-segment",
  pageWindow: "file-organizer:page-window",
  focus: "file-organizer:focus",
  accept: "file-organizer:accept",
  reject: "file-organizer:reject",
  confirmDeletes: "file-organizer:confirm-deletes",
  rejectSegment: "file-organizer:reject-segment",
  undoBatch: "file-organizer:undo-batch",
  dismissStale: "file-organizer:dismiss-stale",
  retryFailed: "file-organizer:retry-failed",
  scanNow: "file-organizer:scan-now",
  organizeBacklog: "file-organizer:organize-backlog",
  enableDaemon: "file-organizer:enable-daemon",
  setMode: "file-organizer:set-mode",
  togglePreset: "file-organizer:toggle-preset",
  addFolder: "file-organizer:add-folder",
  setBacklogPolicy: "file-organizer:set-backlog-policy",
  removeFolder: "file-organizer:remove-folder",
  addIgnore: "file-organizer:add-ignore",
  addRule: "file-organizer:add-rule",
  classifyMove: "file-organizer:classify-move",
  teachRule: "file-organizer:teach-rule",
  ignoreFile: "file-organizer:ignore-file",
  restore: "file-organizer:restore",
  purge: "file-organizer:purge",
  emptyQuarantine: "file-organizer:empty-quarantine",
  purgeExpired: "file-organizer:purge-expired",
  reloadConfig: "file-organizer:reload-config",
} as const;

/** Flat list of every action event — mirrors manifest eventSubscriptions. */
export const ALL_EVENTS: string[] = Object.values(EVENTS);

// ── Render limits ───────────────────────────────────────────────────

/** Rows shown per windowed segment. Bulk actions still hit the full set. */
export const WINDOW_SIZE = 50;
/** ≤ this many items in a segment → one section per item (dual-mode). */
export const SECTION_MODE_MAX = 12;

// ── View snapshots ──────────────────────────────────────────────────

export interface LastAction {
  status: "success" | "partial" | "fail";
  message: string;
  /** Rows that failed to apply (for the retry table). */
  failed?: Array<{ proposalId: string; src: string; error: string }>;
}

export interface OverviewView {
  state: "loading" | "error" | "populated";
  errorMessage?: string;
  daemonRunning: boolean;
  lastScanAt: string | null;
  mode: Mode;
  folderCount: number;
  pending: number;
  unclassified: number;
  quarantined: number;
  appliedToday: number;
  /** Up to a few unclassified files to surface as alerts. */
  unclassifiedSamples: Array<{ proposalId: string; src: string }>;
}

export type ReviewSegment =
  | "all"
  | "moves"
  | "renames"
  | "deletes"
  | "unclassified"
  | "quarantine";

export interface ReviewView {
  state: "loading" | "error" | "populated";
  errorMessage?: string;
  daemonRunning: boolean;
  segment: ReviewSegment;
  offset: number;
  /** All non-quarantine proposals (the builder filters per segment). */
  proposals: Proposal[];
  quarantine: QuarantineEntry[];
  now: number;
  lastAction?: LastAction;
  /** When the daemon auto-applied a batch (fully-auto): the last batch. */
  autoBatch?: { batchId: string; moved: number; quarantined: number };
}

export interface FoldersView {
  state: "loading" | "error" | "populated";
  errorMessage?: string;
  daemonRunning: boolean;
  config: Config;
  offset: number;
}

// ── Shared fragments ────────────────────────────────────────────────

function daemonStatus(page: PageBuilder, running: boolean): void {
  page.section(undefined, (s) => {
    s.status(running ? "Watcher running" : "Watcher stopped", running ? "success" : "warning");
    if (!running) {
      s.button("Enable watcher", { event: EVENTS.enableDaemon }, "primary");
    }
  });
}

function lastActionSection(page: PageBuilder, last: LastAction | undefined): void {
  if (!last) return;
  page.section("Last action", (s) => {
    const state = last.status === "success" ? "success" : last.status === "partial" ? "warning" : "error";
    s.status(last.message, state);
    if (last.failed && last.failed.length > 0) {
      s.table(
        ["File", "Error"],
        last.failed.slice(0, WINDOW_SIZE).map((f) => ({ cells: [f.src, f.error] })),
      );
      s.button("Retry failed", { event: EVENTS.retryFailed }, "secondary");
    }
  });
}

/** A fenced `mv`/`quarantine` command preview for a proposal. */
export function commandPreview(p: Proposal): string {
  if (p.kind === "delete-quarantine") {
    return ["```sh", `quarantine "${p.src}"`, "```"].join("\n");
  }
  if (p.dst) {
    return ["```sh", `mv "${p.src}" "${p.dst}"`, "```"].join("\n");
  }
  return ["```sh", `# ${p.reason}`, "```"].join("\n");
}

// ── Page 1: overview ────────────────────────────────────────────────

export function buildOverview(v: OverviewView): HubPageTree {
  const page = new PageBuilder("File Organizer");

  if (v.state === "loading") {
    page.emptyState("Loading…", "Reading the watcher status.");
    return page.build();
  }
  if (v.state === "error") {
    page.section(undefined, (s) => {
      s.status(v.errorMessage ?? "Could not read state", "error");
      s.button("Retry", { event: EVENTS.reloadConfig }, "secondary");
    });
    return page.build();
  }

  daemonStatus(page, v.daemonRunning);

  page.section(undefined, (s) => {
    s.kv([
      { key: "Last scan", value: v.lastScanAt ?? "never" },
      { key: "Default mode", value: v.mode },
      { key: "Watched folders", value: String(v.folderCount) },
    ]);
  });

  page.stats([
    { label: "Pending review", value: String(v.pending) },
    { label: "Unclassified", value: String(v.unclassified) },
    { label: "Quarantined", value: String(v.quarantined) },
    { label: "Applied today", value: String(v.appliedToday) },
  ]);
  page.link("Open review", "/hub/ext:file-organizer:review");

  // Onboarding entry — prominent when nothing is configured.
  if (v.folderCount === 0) {
    page.section("Get started", (s) => {
      s.markdownBlock(
        "No folders are being watched yet. Co-design a file workflow with the agent, then add folders on the **Folders & Rules** page.",
      );
      s.link("Co-design my file workflow in chat", "/?ext=file-organizer&intent=onboard");
    });
  }

  // Alerts: files that fall outside the workflow.
  if (v.unclassified > 0) {
    page.section("Needs your attention", (s) => {
      s.markdownBlock(`${v.unclassified} file(s) don't match any rule.`);
      s.table(
        ["File"],
        v.unclassifiedSamples.slice(0, WINDOW_SIZE).map((u) => ({
          cells: [u.src],
          action: { event: EVENTS.focus, payload: { proposalId: u.proposalId } },
        })),
      );
      s.link("Ask the agent to help", "/?ext=file-organizer&intent=classify");
    });
  }

  return page.build();
}

// ── Page 2: review ──────────────────────────────────────────────────

const SEGMENTS: ReviewSegment[] = ["all", "moves", "renames", "deletes", "unclassified", "quarantine"];

function kindForSegment(seg: ReviewSegment): ProposalKind | null {
  switch (seg) {
    case "moves": return "move";
    case "renames": return "rename";
    case "deletes": return "delete-quarantine";
    case "unclassified": return "unclassified";
    default: return null;
  }
}

/** Pending proposals visible in a segment (excludes quarantine segment). */
export function proposalsForSegment(proposals: Proposal[], seg: ReviewSegment): Proposal[] {
  const pending = proposals.filter((p) => p.status === "pending" || p.status === "stale-source");
  if (seg === "all") return pending;
  const kind = kindForSegment(seg);
  return kind ? pending.filter((p) => p.kind === kind) : pending;
}

function segmentSelector(page: PageBuilder, active: ReviewSegment, counts: Record<ReviewSegment, number>): void {
  page.section(undefined, (s) => {
    for (const seg of SEGMENTS) {
      const label = `${seg[0]!.toUpperCase()}${seg.slice(1)} (${counts[seg]})`;
      s.button(
        label,
        { event: EVENTS.selectSegment, payload: { segment: seg } },
        seg === active ? "primary" : "secondary",
      );
    }
  });
}

function renderProposalItem(s: PageBuilder, p: Proposal): void {
  if (p.status === "stale-source") {
    s.section(undefined, (sec) => {
      sec.status(`⚠ Source gone: ${p.src}`, "warning");
      sec.button("Dismiss", { event: EVENTS.dismissStale, payload: { proposalId: p.id } }, "secondary");
    });
    return;
  }
  s.section(p.reason, (sec) => {
    sec.kv([
      { key: "From", value: p.src },
      ...(p.dst ? [{ key: "To", value: p.dst }] : []),
      ...(p.ruleLabel ? [{ key: "Rule", value: p.ruleLabel }] : []),
    ]);
    sec.markdownBlock(commandPreview(p));
    sec.button("Accept", { event: EVENTS.accept, payload: { proposalId: p.id } }, "primary");
    sec.button("Reject", { event: EVENTS.reject, payload: { proposalId: p.id } }, "secondary");
  });
}

export function buildReview(v: ReviewView): HubPageTree {
  const page = new PageBuilder("Review");

  if (v.state === "loading") {
    page.emptyState("Loading…", "Reading proposals.");
    return page.build();
  }
  if (v.state === "error") {
    page.section(undefined, (s) => {
      s.status(v.errorMessage ?? "Could not read proposals", "error");
      s.button("Retry", { event: EVENTS.reloadConfig }, "secondary");
    });
    return page.build();
  }

  // Auto-batch undo affordance (fully-auto).
  if (v.autoBatch) {
    page.section(undefined, (s) => {
      s.status(
        `Auto-organized ${v.autoBatch!.moved} file(s), quarantined ${v.autoBatch!.quarantined}`,
        "success",
      );
      s.button(
        "Undo last auto-batch",
        { event: EVENTS.undoBatch, payload: { batchId: v.autoBatch!.batchId } },
        "danger",
      );
    });
  }

  lastActionSection(page, v.lastAction);

  // Segment counts.
  const counts = {} as Record<ReviewSegment, number>;
  for (const seg of SEGMENTS) {
    counts[seg] = seg === "quarantine" ? v.quarantine.length : proposalsForSegment(v.proposals, seg).length;
  }
  page.stats([
    { label: "Pending", value: String(proposalsForSegment(v.proposals, "all").length) },
    { label: "Quarantined", value: String(v.quarantine.length) },
  ]);
  segmentSelector(page, v.segment, counts);

  if (v.segment === "quarantine") {
    buildQuarantineSegment(page, v);
    return page.build();
  }

  const all = proposalsForSegment(v.proposals, v.segment);
  const windowed = all.slice(v.offset, v.offset + WINDOW_SIZE);

  if (all.length === 0) {
    page.emptyState("Nothing here", "No pending items in this segment.");
    return page.build();
  }

  // Deletes are batched: a single confirm gate, not per-file accept.
  if (v.segment === "deletes") {
    page.section("Pending deletes", (s) => {
      s.table(
        ["File", "Reason"],
        windowed.map((p) => ({ cells: [p.src, p.reason] })),
      );
      s.button(
        `Confirm these ${all.length} deletes`,
        {
          event: EVENTS.confirmDeletes,
          confirm: `Move ${all.length} file(s) to quarantine (restorable)?`,
        },
        "primary",
      );
      s.button("Reject all in segment", { event: EVENTS.rejectSegment, payload: { segment: "deletes" } }, "danger");
    });
    windowFooter(page, v.segment, v.offset, all.length);
    return page.build();
  }

  // Dual-mode render: ≤12 items → one section each (each carries
  // Accept/Reject); more → table + focus.
  if (windowed.length <= SECTION_MODE_MAX) {
    page.section(undefined, (s) => {
      for (const p of windowed) renderProposalItem(s, p);
    });
  } else {
    page.table(
      ["From", "To", "Reason"],
      windowed.map((p) => ({
        cells: [p.src, p.dst ?? "—", p.reason],
        action: { event: EVENTS.focus, payload: { proposalId: p.id } },
      })),
    );
  }
  page.button("Reject all in segment", { event: EVENTS.rejectSegment, payload: { segment: v.segment } }, "danger");
  windowFooter(page, v.segment, v.offset, all.length);
  return page.build();
}

function windowFooter(page: PageBuilder, segment: ReviewSegment, offset: number, total: number): void {
  if (total <= WINDOW_SIZE) return;
  page.section(undefined, (s) => {
    s.markdownBlock(`Showing ${offset + 1}–${Math.min(offset + WINDOW_SIZE, total)} of ${total}`);
    if (offset > 0) {
      s.button("Previous", { event: EVENTS.pageWindow, payload: { segment, offset: Math.max(0, offset - WINDOW_SIZE) } }, "secondary");
    }
    if (offset + WINDOW_SIZE < total) {
      s.button("Next", { event: EVENTS.pageWindow, payload: { segment, offset: offset + WINDOW_SIZE } }, "secondary");
    }
  });
}

function buildQuarantineSegment(page: PageBuilder, v: ReviewView): void {
  if (v.quarantine.length === 0) {
    page.emptyState("Quarantine is empty", "Deleted files land here, restorable until they expire.");
    return;
  }
  const windowed = v.quarantine.slice(v.offset, v.offset + WINDOW_SIZE);
  page.section("Quarantine", (s) => {
    s.table(
      ["Original", "Expires in", "Size"],
      windowed.map((e) => ({
        cells: [e.originalPath, expiresIn(e.expiresAtMs, v.now), `${e.size} B`],
        action: { event: EVENTS.focus, payload: { quarantineId: e.id } },
      })),
    );
    s.button("Restore all", { event: EVENTS.restore, payload: { all: true } }, "secondary");
    s.button("Purge expired", { event: EVENTS.purgeExpired }, "secondary");
    s.button("Empty quarantine", { event: EVENTS.emptyQuarantine, confirm: "Permanently delete every quarantined file?" }, "danger");
  });
  windowFooter(page, "quarantine", v.offset, v.quarantine.length);
}

function expiresIn(expiresAtMs: number, now: number): string {
  const ms = expiresAtMs - now;
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  return `${hours}h`;
}

// ── Page 3: folders ─────────────────────────────────────────────────

export function buildFolders(v: FoldersView): HubPageTree {
  const page = new PageBuilder("Folders & Rules");

  if (v.state === "loading") {
    page.emptyState("Loading…", "Reading configuration.");
    return page.build();
  }
  if (v.state === "error") {
    page.section(undefined, (s) => {
      s.status(v.errorMessage ?? "Could not read config", "error");
      s.button("Retry", { event: EVENTS.reloadConfig }, "secondary");
    });
    return page.build();
  }

  if (!v.daemonRunning) {
    page.section(undefined, (s) => {
      s.status("Watcher is stopped — changes apply when it restarts", "warning");
    });
  }

  page.section(undefined, (s) => {
    s.button("Add watched folder", { event: EVENTS.addFolder, prompt: { label: "Folder path", placeholder: "/watched/Downloads", field: "path", format: "file-path" } }, "primary");
    s.button("Add ignore", { event: EVENTS.addIgnore, prompt: { label: "Ignore path or name", field: "path" } }, "secondary");
    s.button("Add quick rule", { event: EVENTS.addRule, prompt: { label: "Rule (e.g. *.tmp older 7d -> quarantine)", field: "rule" } }, "secondary");
  });

  if (v.config.folders.length === 0) {
    page.emptyState("No folders watched", "Add a folder above, or co-design a workflow in chat.");
    page.link("Co-design in chat", "/?ext=file-organizer&intent=onboard");
    return page.build();
  }

  page.stats([{ label: "Watched folders", value: String(v.config.folders.length) }]);

  const windowed = v.config.folders.slice(v.offset, v.offset + WINDOW_SIZE);
  for (const f of windowed) renderFolderSection(page, f);
  return page.build();
}

const MODE_LABELS: Record<Mode, string> = {
  "ask-everything": "Ask",
  "approve-non-destructive-only": "Non-destructive",
  "fully-auto": "Auto",
};

function renderFolderSection(page: PageBuilder, f: FolderConfig): void {
  page.section(f.path, (s) => {
    s.kv([
      { key: "Mode", value: f.mode ?? "(global)" },
      { key: "Presets", value: f.presets.join(", ") || "none" },
      { key: "Custom rules", value: String(f.customRules.length) },
      { key: "Backlog", value: f.backlogPolicy },
    ]);
    // Mode trio.
    s.section("Mode", (m) => {
      for (const mode of Object.keys(MODE_LABELS) as Mode[]) {
        m.button(
          MODE_LABELS[mode],
          { event: EVENTS.setMode, payload: { folderId: f.id, mode } },
          f.mode === mode ? "primary" : "secondary",
        );
      }
    });
    // Preset toggles.
    s.section("Presets", (pr) => {
      for (const name of PRESET_NAMES) {
        const on = f.presets.includes(name);
        pr.button(
          `${on ? "✓ " : ""}${name}`,
          { event: EVENTS.togglePreset, payload: { folderId: f.id, preset: name } },
          on ? "primary" : "secondary",
        );
      }
    });
    s.link("Edit rules in chat", "/?ext=file-organizer&intent=rules");
    s.button("Remove folder", { event: EVENTS.removeFolder, payload: { folderId: f.id }, confirm: "Stop watching this folder? Quarantine is kept." }, "danger");
  });
}
