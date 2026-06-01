/**
 * Admin dashboard — per-source loading decoupling (robustness regression).
 *
 * Pin: the System tab's cards each settle on their OWN data source. A slow
 * or failing `/api/admin/analytics` MUST NOT keep the embedding-index card
 * (backed by `/api/admin/embed-progress`) or the system-health cards
 * (backed by `/api/admin/system`) stuck on a skeleton forever.
 *
 * Before the fix a single shared `loading` flag — only flipped after
 * `await Promise.all([...])` — gated every card, so one hanging endpoint
 * froze all four cards as skeletons indefinitely.
 */

import "@testing-library/jest-dom/vitest";
import { render, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));

import AdminDashboard from "../routes/(app)/admin/dashboard/+page.svelte";

const ADMIN_ME = { user: { role: "admin" } };

const SYSTEM_DATA = {
  health: {
    dbSizeBytes: 1024,
    uptimeSeconds: 3600,
    tableRowCounts: { conversations: 5, messages: 42, agents: 3 },
  },
  activityFeed: [],
  errorSummary: { totalErrors: 0, errorRate: [], recentErrors: [] },
};

const EMBED_DATA = {
  backlog: { pending: 7, inProgress: 1, failed: 0, total: 8 },
  coverage: { eligibleMessages: 100, embeddedMessages: 75 },
};

/**
 * Install a global `fetch` that routes per-URL. `analytics` controls how
 * the (slow/failing) analytics endpoint behaves; system + embed always
 * resolve OK.
 */
function installFetch(analytics: "hang" | "500") {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/me")) {
      return Promise.resolve(new Response(JSON.stringify(ADMIN_ME)));
    }
    if (url.includes("/api/admin/system")) {
      return Promise.resolve(new Response(JSON.stringify(SYSTEM_DATA)));
    }
    if (url.includes("/api/admin/embed-progress")) {
      return Promise.resolve(new Response(JSON.stringify(EMBED_DATA)));
    }
    if (url.includes("/api/admin/analytics")) {
      if (analytics === "hang") {
        // Never resolves — simulates the 40s+ hang.
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
      );
    }
    return Promise.resolve(new Response("{}"));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin dashboard — per-source decoupling", () => {
  test("hanging /api/admin/analytics does NOT block the embedding-index or system cards", async () => {
    installFetch("hang");
    const { findByTestId, getByText, queryByTestId } = render(AdminDashboard);

    // Switch to the System tab (embedding + health live here).
    const systemTab = await waitFor(() => getByText("System"));
    systemTab.click();

    // Embedding-index card renders its data despite analytics hanging.
    const embedCard = await findByTestId("embed-progress-card");
    expect(embedCard).toBeInTheDocument();
    expect(embedCard.textContent).toContain("7 pending");
    expect(embedCard.textContent).toContain("75");

    // System health card also rendered (Database Size / Uptime labels).
    expect(getByText("Database Size")).toBeInTheDocument();
    expect(getByText("Uptime")).toBeInTheDocument();

    // And no leftover error affordance for the embed/system sources.
    expect(queryByTestId("source-error")).not.toBeInTheDocument();
  });

  test("failing /api/admin/analytics (500) still lets the embedding-index card render", async () => {
    installFetch("500");
    const { findByTestId, getByText } = render(AdminDashboard);

    const systemTab = await waitFor(() => getByText("System"));
    systemTab.click();

    const embedCard = await findByTestId("embed-progress-card");
    expect(embedCard.textContent).toContain("7 pending");
    expect(getByText("Database Size")).toBeInTheDocument();
  });
});
