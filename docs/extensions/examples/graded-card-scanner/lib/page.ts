// ── page.ts — the "Card Scanner" Hub dashboard ──────────────────────
//
// One Hub page (declared in the manifest — declaring it IS the grant; no
// actions in v1, so no eventSubscriptions). It surfaces the pipeline's
// self-tracked lookup history:
//
//   - stats: cards cached, lookups recorded, last lookup time
//   - a ≤20-row table of recent lookups (Cert | Card | Grade | Value | When)
//   - a link into the phone-scanner SPA
//   - an empty-state before the first lookup
//
// `buildDashboard` is a pure render (both states unit-tested);
// `loadDashboardData` reads the same Storage the pipeline writes;
// `pushDashboard` broadcasts a live refresh after each uncached lookup.
// Page trees are SHARED across users (pages.md §6) — everything here is
// non-user-specific card data, never a secret.

import { PageBuilder, definePage, pushPage, type HubPageTree } from "@ezcorp/sdk/runtime";
import { formatMoney } from "../app/lib/format.js";
import { CERT_PREFIX, RECENT_CAP, RECENT_KEY, type RecentEntry } from "./pipeline";

export const DASHBOARD_PAGE_ID = "dashboard";

export interface DashboardStats {
  cachedCount: number;
  lookupCount: number;
  lastAt: string | null;
}

/** "2026-07-06T14:08:00.000Z" → "2026-07-06 14:08" (or "—" for null). */
function whenLabel(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "—";
}

/** Pure render of the dashboard tree from a recent list + stats. */
export function buildDashboard(recent: RecentEntry[], stats: DashboardStats): HubPageTree {
  const page = new PageBuilder("Card Scanner")
    .markdownBlock(
      "Recent PSA-graded card lookups from the scanner app and chat. " +
        "Values are the price at each card's own grade; missing data shows as N/A, never $0.",
    )
    .stats([
      { label: "Cards cached", value: String(stats.cachedCount) },
      { label: "Lookups recorded", value: String(stats.lookupCount) },
      { label: "Last lookup", value: whenLabel(stats.lastAt) },
    ]);

  if (recent.length === 0) {
    page.emptyState(
      "No lookups yet",
      "Scan a slab in the app or ask about a PSA cert in chat to see cards here.",
    );
  } else {
    page.table(
      ["Cert", "Card", "Grade", "Value", "When"],
      recent.slice(0, RECENT_CAP).map((r) => ({
        cells: [r.cert, r.title || "—", r.grade || "—", formatMoney(r.value), whenLabel(r.at)],
      })),
    );
  }

  page.divider().link("Open scanner", "/api/extensions/graded-card-scanner/data/app/index.html");
  return page.build();
}

/** The Storage surface the dashboard reads (structurally satisfied by the
 *  SDK `Storage`; a plain fake in tests). */
export interface DashboardStorage {
  get<T = unknown>(key: string): Promise<{ value: T | null; exists: boolean }>;
  list(opts?: { prefix?: string; limit?: number }): Promise<{ keys: unknown[] }>;
}

/** Read the recent list + cached-cert count and derive the stats. */
export async function loadDashboardData(
  storage: DashboardStorage,
): Promise<{ recent: RecentEntry[]; stats: DashboardStats }> {
  const recentRes = await storage.get<RecentEntry[]>(RECENT_KEY);
  const recent = Array.isArray(recentRes.value) ? recentRes.value : [];
  const listed = await storage.list({ prefix: CERT_PREFIX, limit: 1000 });
  const cachedCount = Array.isArray(listed.keys) ? listed.keys.length : 0;
  return {
    recent,
    stats: { cachedCount, lookupCount: recent.length, lastAt: recent[0]?.at ?? null },
  };
}

// pushPage indirection so tests observe pushes without a live channel
// (mirrors the cron-dashboard reference).
let pushPageImpl: typeof pushPage = pushPage;
export function _setPushPageForTests(fn: typeof pushPage | null): void {
  pushPageImpl = fn ?? pushPage;
}

/** Live-refresh the dashboard from current Storage state. */
export async function pushDashboard(storage: DashboardStorage): Promise<void> {
  const { recent, stats } = await loadDashboardData(storage);
  pushPageImpl(DASHBOARD_PAGE_ID, buildDashboard(recent, stats));
}

/** Register the Hub page render handler against the SDK channel. */
export function registerDashboardPage(storage: DashboardStorage): void {
  definePage({
    id: DASHBOARD_PAGE_ID,
    render: async () => {
      const { recent, stats } = await loadDashboardData(storage);
      return buildDashboard(recent, stats);
    },
  });
}
