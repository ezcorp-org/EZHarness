#!/usr/bin/env bun
// ── cron-dashboard — reference Hub-page extension ────────────────
//
// Demonstrates the full Extension Pages Hub surface:
//
//   1. `manifest.pages` declares the tab (ezcorp.config.ts).
//   2. `definePage` serves `ezcorp/page.render` pulls and registers
//      the "Clear log" action handler.
//   3. `Schedule.on` appends each heartbeat fire to a self-tracked
//      run log in `Storage` (v1 gap: extensions cannot read
//      `extension_schedules` through the SDK).
//   4. `pushPage` after every fire/action — the host validates +
//      caches the tree and broadcasts a content-free invalidation
//      signal so open Hub tabs re-pull.
//
// All page content is data: the host renders native Svelte from the
// declarative tree; this code never touches the DOM.

import {
  PageBuilder,
  Schedule,
  Storage,
  definePage,
  getChannel,
  pushPage,
  type HubPageTree,
  type PageActionEvent,
  type ScheduleHandlerContext,
} from "@ezcorp/sdk/runtime";

export const PAGE_ID = "dashboard";
export const CLEAR_LOG_EVENT = "cron-dashboard:clear-log";
export const HEARTBEAT_CRON = "*/5 * * * *";
export const RUN_LOG_KEY = "run-log";
export const MAX_LOG_ENTRIES = 50;

export interface RunEntry {
  firedAt: string; // ISO timestamp
  cron: string;
  catchUp: boolean;
  attempt: number;
}

// ── Run-log store (Storage-backed; injectable for tests) ─────────

export interface RunLogStore {
  read(): Promise<RunEntry[]>;
  write(entries: RunEntry[]): Promise<void>;
}

function productionStore(): RunLogStore {
  const storage = new Storage("global");
  return {
    async read() {
      const result = await storage.get<RunEntry[]>(RUN_LOG_KEY);
      return Array.isArray(result.value) ? result.value : [];
    },
    async write(entries) {
      await storage.set(RUN_LOG_KEY, entries);
    },
  };
}

let store: RunLogStore | null = null;
function getStore(): RunLogStore {
  if (!store) store = productionStore();
  return store;
}

/** Test seam: substitute the Storage-backed run log. */
export function _setStoreForTests(s: RunLogStore | null): void {
  store = s;
}

// pushPage indirection so tests can observe pushes without a channel.
let pushPageImpl: typeof pushPage = pushPage;
export function _setPushPageForTests(fn: typeof pushPage | null): void {
  pushPageImpl = fn ?? pushPage;
}

// ── Pure helpers ──────────────────────────────────────────────────

/** Prepend the newest run; cap the log. Pure — returns a new array. */
export function appendRun(log: RunEntry[], entry: RunEntry): RunEntry[] {
  return [entry, ...log].slice(0, MAX_LOG_ENTRIES);
}

/** Build the dashboard tree from the run log. Pure. */
export function buildDashboard(log: RunEntry[]): HubPageTree {
  const catchUps = log.filter((r) => r.catchUp).length;
  const page = new PageBuilder("Cron Dashboard")
    .markdownBlock(
      "Heartbeat runs fired by this extension's `*/5 * * * *` cron. " +
        "The log is self-tracked in extension storage and refreshed live after every fire.",
    )
    .stats([
      { label: "Tracked runs", value: String(log.length), hint: `last ${MAX_LOG_ENTRIES} kept` },
      { label: "Last fired", value: log[0]?.firedAt.slice(0, 16).replace("T", " ") ?? "—" },
      { label: "Catch-up fires", value: String(catchUps) },
    ]);

  if (log.length === 0) {
    page.emptyState(
      "No runs recorded yet",
      "The heartbeat cron fires every 5 minutes while the host is up.",
    );
  } else {
    page.table(
      ["Fired at", "Cron", "Catch-up", "Attempt"],
      log.map((r) => ({
        cells: [r.firedAt, r.cron, r.catchUp ? "yes" : "no", String(r.attempt)],
      })),
    );
  }

  page.divider().button(
    "Clear log",
    {
      event: CLEAR_LOG_EVENT,
      confirm: "Clear the entire run log? This cannot be undone.",
    },
    "danger",
  );

  return page.build();
}

// ── Handlers ──────────────────────────────────────────────────────

export async function renderDashboard(): Promise<HubPageTree> {
  return buildDashboard(await getStore().read());
}

export async function handleScheduleFire(ctx: ScheduleHandlerContext): Promise<void> {
  const log = appendRun(await getStore().read(), {
    firedAt: ctx.firedAt,
    cron: ctx.cron,
    catchUp: ctx.catchUp,
    attempt: ctx.attempt,
  });
  await getStore().write(log);
  // Live refresh: validated + cached host-side; open tabs re-pull.
  pushPageImpl(PAGE_ID, buildDashboard(log));
}

export async function handleClearLog(_event: PageActionEvent): Promise<void> {
  await getStore().write([]);
  pushPageImpl(PAGE_ID, buildDashboard([]));
}

// ── Wiring ────────────────────────────────────────────────────────

/** Register the page + cron handler (no stdin side effects — tests
 *  call this against a stubbed channel). */
export function register(): void {
  definePage({
    id: PAGE_ID,
    render: renderDashboard,
    actions: {
      [CLEAR_LOG_EVENT]: handleClearLog,
    },
  });
  new Schedule().on(HEARTBEAT_CRON, handleScheduleFire);
}

export function start(): void {
  register();
  getChannel().start();
}

// Production wiring — gated on `import.meta.main` so test imports
// don't open stdin (same pattern as the other examples).
if (import.meta.main) start();
