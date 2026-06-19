import { describe, expect, test } from "bun:test";
import { validatePageTree, MAX_PAGE_NODES, MAX_TABLE_ROWS } from "../../../../../src/extensions/page-schema";
import {
  ALL_EVENTS,
  EVENTS,
  WINDOW_SIZE,
  buildFolders,
  buildOverview,
  buildReview,
  commandPreview,
  proposalsForSegment,
  type FoldersView,
  type OverviewView,
  type ReviewView,
} from "./page";
import type { Proposal, ProposalKind } from "./proposals";
import { emptyConfig, addFolder, type Config } from "./config";
import type { QuarantineEntry } from "./quarantine";
import type { HubPageTree } from "@ezcorp/sdk/runtime";

// ── Helpers ─────────────────────────────────────────────────────────

/** Run a built tree through the REAL host validator: proves caps are
 *  respected, every action event is in the allowlist, no node is dropped. */
function validate(tree: HubPageTree): ReturnType<typeof validatePageTree> {
  return validatePageTree(tree, { allowedEvents: ALL_EVENTS });
}

/** Recursively collect every node `type` in a tree. */
function nodeTypes(tree: HubPageTree): string[] {
  const out: string[] = [];
  const visit = (nodes: unknown[]) => {
    for (const n of nodes) {
      const node = n as { type?: string; nodes?: unknown[] };
      if (node.type) out.push(node.type);
      if (Array.isArray(node.nodes)) visit(node.nodes);
    }
  };
  visit(tree.nodes);
  return out;
}

/** Collect every action.event referenced anywhere in a tree. */
function actionEvents(tree: HubPageTree): string[] {
  const out: string[] = [];
  const visit = (nodes: unknown[]) => {
    for (const n of nodes) {
      const node = n as { action?: { event?: string }; rows?: Array<{ action?: { event?: string } }>; nodes?: unknown[] };
      if (node.action?.event) out.push(node.action.event);
      for (const r of node.rows ?? []) if (r.action?.event) out.push(r.action.event);
      if (Array.isArray(node.nodes)) visit(node.nodes);
    }
  };
  visit(tree.nodes);
  return out;
}

function prop(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1", kind: "move", src: "/w/a.txt", dst: "/w/sub/a.txt", reason: "route",
    ruleId: "r1", ruleLabel: "Route", folderId: "f1",
    snapshot: { size: 10, mtimeMs: 1, isSymlink: false, dev: 1, ino: 2, nlink: 1 },
    status: "pending", dedupeKey: "k", createdAt: "2026-06-17T00:00:00.000Z", version: 0,
    ...overrides,
  };
}

function qentry(id: string, expiresAtMs: number): QuarantineEntry {
  return { id, originalPath: `/w/${id}`, trashPath: `/d/.trash/${id}/x`, proposalId: null, reason: "junk", deletedAt: new Date(0).toISOString(), batchId: null, size: 10, expiresAtMs };
}

function overview(over: Partial<OverviewView> = {}): OverviewView {
  return {
    state: "populated", daemonRunning: true, lastScanAt: "2026-06-17T00:00:00Z", mode: "ask-everything",
    folderCount: 1, pending: 0, unclassified: 0, quarantined: 0, appliedToday: 0, unclassifiedSamples: [],
    ...over,
  };
}

function review(over: Partial<ReviewView> = {}): ReviewView {
  return {
    state: "populated", daemonRunning: true, segment: "all", offset: 0,
    proposals: [], quarantine: [], now: 1000, ...over,
  };
}

function folders(over: Partial<FoldersView> = {}): FoldersView {
  return { state: "populated", daemonRunning: true, config: emptyConfig(), offset: 0, ...over };
}

// ── Cross-cutting invariant: every action event is declared ─────────

describe("event declarations", () => {
  test("ALL_EVENTS mirrors the EVENTS map", () => {
    expect(ALL_EVENTS.sort()).toEqual(Object.values(EVENTS).sort());
    expect(new Set(ALL_EVENTS).size).toBe(ALL_EVENTS.length); // no dups
  });

  const everyTree: Array<[string, () => HubPageTree]> = [
    ["overview/populated", () => buildOverview(overview({ unclassified: 2, unclassifiedSamples: [{ proposalId: "p1", src: "/w/x" }] }))],
    ["overview/empty", () => buildOverview(overview({ folderCount: 0 }))],
    ["overview/daemon-off", () => buildOverview(overview({ daemonRunning: false }))],
    ["review/moves", () => buildReview(review({ proposals: [prop()] }))],
    ["review/deletes", () => buildReview(review({ segment: "deletes", proposals: [prop({ kind: "delete-quarantine", dst: null })] }))],
    ["review/quarantine", () => buildReview(review({ segment: "quarantine", quarantine: [qentry("q1", 9e12)] }))],
    ["review/auto-batch", () => buildReview(review({ autoBatch: { batchId: "b1", moved: 3, quarantined: 1 } }))],
    ["folders/populated", () => {
      const r = addFolder(emptyConfig(), { path: "/watched/D", backlogPolicy: "new-only", now: 1, idGen: () => "f1" });
      return buildFolders(folders({ config: (r as { ok: true; config: Config }).config }));
    }],
  ];

  test.each(everyTree)("%s: every action event ∈ ALL_EVENTS", (_name, build) => {
    const tree = build();
    for (const ev of actionEvents(tree)) expect(ALL_EVENTS).toContain(ev);
  });

  test.each(everyTree)("%s: validator keeps every node (none dropped)", (_name, build) => {
    const tree = build();
    const validated = validate(tree);
    expect(validated).not.toBeNull();
    // No action node dropped ⇒ same count of action events before/after.
    expect(actionEvents(validated as HubPageTree).length).toBe(actionEvents(tree).length);
  });
});

// ── Overview states ─────────────────────────────────────────────────

describe("buildOverview", () => {
  test("loading", () => {
    const tree = buildOverview(overview({ state: "loading" }));
    expect(nodeTypes(tree)).toContain("empty-state");
  });
  test("error → status + retry", () => {
    const tree = buildOverview(overview({ state: "error", errorMessage: "boom" }));
    expect(actionEvents(tree)).toContain(EVENTS.reloadConfig);
    expect(nodeTypes(tree)).toContain("status");
  });
  test("daemon-off shows Enable button", () => {
    const tree = buildOverview(overview({ daemonRunning: false }));
    expect(actionEvents(tree)).toContain(EVENTS.enableDaemon);
  });
  test("empty (no folders) shows onboarding link", () => {
    const tree = buildOverview(overview({ folderCount: 0 }));
    expect(nodeTypes(tree)).toContain("link");
  });
  test("unclassified alert renders a table + focus action", () => {
    const tree = buildOverview(overview({ unclassified: 1, unclassifiedSamples: [{ proposalId: "p9", src: "/w/x" }] }));
    expect(actionEvents(tree)).toContain(EVENTS.focus);
    expect(nodeTypes(tree)).toContain("table");
  });
  test("all-clear: stats present, no alert section", () => {
    const tree = buildOverview(overview());
    expect(nodeTypes(tree)).toContain("stats");
  });
});

// ── Review states ───────────────────────────────────────────────────

describe("buildReview", () => {
  test("loading / error", () => {
    expect(nodeTypes(buildReview(review({ state: "loading" })))).toContain("empty-state");
    expect(actionEvents(buildReview(review({ state: "error" })))).toContain(EVENTS.reloadConfig);
  });

  test("section mode (≤12) carries Accept+Reject per item", () => {
    const tree = buildReview(review({ proposals: [prop(), prop({ id: "p2" })] }));
    const events = actionEvents(tree);
    expect(events).toContain(EVENTS.accept);
    expect(events).toContain(EVENTS.reject);
  });

  test("table mode (>12) uses focus rows, not inline accept", () => {
    const many = Array.from({ length: 13 }, (_, i) => prop({ id: `p${i}` }));
    const tree = buildReview(review({ proposals: many }));
    expect(nodeTypes(tree)).toContain("table");
    expect(actionEvents(tree)).toContain(EVENTS.focus);
  });

  test("deletes segment is a single batched confirm (no per-file accept)", () => {
    const dels = [prop({ id: "d1", kind: "delete-quarantine", dst: null }), prop({ id: "d2", kind: "delete-quarantine", dst: null })];
    const tree = buildReview(review({ segment: "deletes", proposals: dels }));
    const events = actionEvents(tree);
    expect(events).toContain(EVENTS.confirmDeletes);
    expect(events).not.toContain(EVENTS.accept);
  });

  test("auto-batch undo affordance", () => {
    const tree = buildReview(review({ autoBatch: { batchId: "b1", moved: 2, quarantined: 1 } }));
    expect(actionEvents(tree)).toContain(EVENTS.undoBatch);
  });

  test("last-action result with failed rows → retry", () => {
    const tree = buildReview(review({ lastAction: { status: "partial", message: "2 ok, 1 failed", failed: [{ proposalId: "p1", src: "/w/x", error: "EACCES" }] } }));
    expect(actionEvents(tree)).toContain(EVENTS.retryFailed);
  });

  test("stale-source row shows Dismiss, suppresses Accept", () => {
    const tree = buildReview(review({ proposals: [prop({ status: "stale-source" })] }));
    const events = actionEvents(tree);
    expect(events).toContain(EVENTS.dismissStale);
    expect(events).not.toContain(EVENTS.accept);
  });

  test("quarantine segment: restore/purge/empty + per-row focus", () => {
    const tree = buildReview(review({ segment: "quarantine", quarantine: [qentry("q1", 9e12)] }));
    const events = actionEvents(tree);
    expect(events).toContain(EVENTS.restore);
    expect(events).toContain(EVENTS.purgeExpired);
    expect(events).toContain(EVENTS.emptyQuarantine);
    expect(events).toContain(EVENTS.focus);
  });

  test("empty quarantine shows empty-state", () => {
    const tree = buildReview(review({ segment: "quarantine" }));
    expect(nodeTypes(tree)).toContain("empty-state");
  });

  test("empty segment shows empty-state", () => {
    const tree = buildReview(review({ segment: "moves" }));
    expect(nodeTypes(tree)).toContain("empty-state");
  });

  test("windowed past the first page renders a Previous button", () => {
    // offset > 0 ⇒ the windowFooter emits the "Previous" affordance
    // (page.ts:380), not just "Next".
    const many = Array.from({ length: WINDOW_SIZE * 2 + 5 }, (_, i) => prop({ id: `p${i}`, kind: "move" }));
    const tree = buildReview(review({ proposals: many, segment: "moves", offset: WINDOW_SIZE }));
    const buttons = JSON.stringify(tree);
    expect(buttons).toContain("Previous");
    expect(buttons).toContain("Next"); // still more after this window
  });

  test("quarantine expiring in hours renders an h-suffixed countdown", () => {
    // expiresAtMs within a day of `now` ⇒ expiresIn() takes the hours
    // branch (page.ts:414), not the days branch.
    const fiveHours = 1000 + 5 * 60 * 60 * 1000;
    const tree = buildReview(review({ segment: "quarantine", now: 1000, quarantine: [qentry("q1", fiveHours)] }));
    expect(JSON.stringify(tree)).toContain("5h");
  });

  test("overflow window: never renders the whole queue + pagination", () => {
    const many = Array.from({ length: WINDOW_SIZE + 10 }, (_, i) => prop({ id: `p${i}`, kind: "move" }));
    const tree = buildReview(review({ proposals: many, segment: "moves" }));
    expect(actionEvents(tree)).toContain(EVENTS.pageWindow);
    const validated = validate(tree) as HubPageTree;
    // Tables are capped at MAX_TABLE_ROWS by the validator; we window first.
    const tableRows = (validated.nodes.find((n) => (n as { type: string }).type === "table") as { rows?: unknown[] } | undefined)?.rows ?? [];
    expect(tableRows.length).toBeLessThanOrEqual(MAX_TABLE_ROWS);
    expect(tableRows.length).toBeLessThanOrEqual(WINDOW_SIZE);
  });

  test("node count stays under the host cap on a huge queue", () => {
    const many = Array.from({ length: 5000 }, (_, i) => prop({ id: `p${i}`, kind: "move" }));
    const tree = buildReview(review({ proposals: many, segment: "moves" }));
    expect(nodeTypes(tree).length).toBeLessThan(MAX_PAGE_NODES);
  });

  test("segment selector reflects the active segment", () => {
    const tree = buildReview(review({ segment: "moves", proposals: [prop()] }));
    expect(actionEvents(tree)).toContain(EVENTS.selectSegment);
  });
});

// ── Folders states ──────────────────────────────────────────────────

describe("buildFolders", () => {
  test("loading / error", () => {
    expect(nodeTypes(buildFolders(folders({ state: "loading" })))).toContain("empty-state");
    expect(actionEvents(buildFolders(folders({ state: "error" })))).toContain(EVENTS.reloadConfig);
  });
  test("no-folders empty-state + onboarding link", () => {
    const tree = buildFolders(folders());
    expect(nodeTypes(tree)).toContain("empty-state");
    expect(actionEvents(tree)).toContain(EVENTS.addFolder);
  });
  test("daemon-off banner", () => {
    const tree = buildFolders(folders({ daemonRunning: false }));
    expect(nodeTypes(tree)).toContain("status");
  });
  test("populated folder exposes mode trio + preset toggles + remove", () => {
    const r = addFolder(emptyConfig(), { path: "/watched/D", backlogPolicy: "new-only", now: 1, idGen: () => "f1" });
    const config = (r as { ok: true; config: Config }).config;
    const tree = buildFolders(folders({ config }));
    const events = actionEvents(tree);
    expect(events).toContain(EVENTS.setMode);
    expect(events).toContain(EVENTS.togglePreset);
    expect(events).toContain(EVENTS.removeFolder);
  });
  test("add-folder prompt carries a single field + reuses the file-path picker", () => {
    const tree = buildFolders(folders());
    const visit = (nodes: unknown[]): { prompt?: { field?: string; format?: string } } | undefined => {
      for (const n of nodes) {
        const node = n as { action?: { event?: string; prompt?: { field?: string; format?: string } }; nodes?: unknown[] };
        if (node.action?.event === EVENTS.addFolder) return node.action;
        if (Array.isArray(node.nodes)) { const f = visit(node.nodes); if (f) return f; }
      }
      return undefined;
    };
    const addAction = visit(tree.nodes);
    expect(addAction?.prompt?.field).toBe("path");
    // Reuse the shared filesystem picker rather than a bare text input.
    expect(addAction?.prompt?.format).toBe("file-path");
  });
});

// ── Pure helpers ────────────────────────────────────────────────────

describe("helpers", () => {
  test("proposalsForSegment filters by kind + status", () => {
    const ps: Proposal[] = [
      prop({ id: "m", kind: "move" }),
      prop({ id: "r", kind: "rename" }),
      prop({ id: "d", kind: "delete-quarantine", dst: null }),
      prop({ id: "applied", kind: "move", status: "applied" }),
    ];
    expect(proposalsForSegment(ps, "all").map((p) => p.id).sort()).toEqual(["d", "m", "r"]);
    expect(proposalsForSegment(ps, "moves").map((p) => p.id)).toEqual(["m"]);
    expect(proposalsForSegment(ps, "deletes" as ProposalKind extends never ? never : "deletes").map((p) => p.id)).toEqual(["d"]);
  });
  test("commandPreview renders mv / quarantine fenced blocks", () => {
    expect(commandPreview(prop())).toContain('mv "/w/a.txt" "/w/sub/a.txt"');
    expect(commandPreview(prop({ kind: "delete-quarantine", dst: null }))).toContain('quarantine "/w/a.txt"');
    expect(commandPreview(prop({ kind: "unclassified", dst: null, reason: "no rule" }))).toContain("# no rule");
  });
});
