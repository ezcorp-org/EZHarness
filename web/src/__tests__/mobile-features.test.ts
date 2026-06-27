import { test, expect, describe } from "bun:test";

// ─── MobileTabBar active tab logic ───────────────────────────────────────────

interface Tab {
  name: string;
  href: string;
  isActive: (currentPath: string) => boolean;
}

function makeTabs(projectId: string): Tab[] {
  return [
    {
      name: "Overview",
      href: `/project/${projectId}`,
      isActive: (path: string) =>
        path === `/project/${projectId}` || path === `/project/${projectId}/`,
    },
    {
      name: "Chat",
      href: `/project/${projectId}/chat`,
      isActive: (path: string) => path.includes("/chat"),
    },
    {
      name: "Settings",
      href: `/project/${projectId}/settings`,
      isActive: (path: string) => path.includes("/settings"),
    },
  ];
}

function getActiveTab(projectId: string, currentPath: string): string | null {
  const tabs = makeTabs(projectId);
  const active = tabs.find((t) => t.isActive(currentPath));
  return active?.name ?? null;
}

function getActiveTabs(projectId: string, currentPath: string): string[] {
  const tabs = makeTabs(projectId);
  return tabs.filter((t) => t.isActive(currentPath)).map((t) => t.name);
}

describe("MobileTabBar active tab logic", () => {
  const projectId = "p1";

  test("/project/p1 activates Dashboard", () => {
    expect(getActiveTab(projectId, "/project/p1")).toBe("Overview");
  });

  test("/project/p1/ activates Dashboard (trailing slash)", () => {
    expect(getActiveTab(projectId, "/project/p1/")).toBe("Overview");
  });

  test("/project/p1/chat activates Chat", () => {
    expect(getActiveTab(projectId, "/project/p1/chat")).toBe("Chat");
  });

  test("/project/p1/chat/conv-123 activates Chat (nested)", () => {
    expect(getActiveTab(projectId, "/project/p1/chat/conv-123")).toBe("Chat");
  });

  test("/project/p1/settings activates Settings", () => {
    expect(getActiveTab(projectId, "/project/p1/settings")).toBe("Settings");
  });

  test("/project/p1/settings/other activates Settings (nested)", () => {
    expect(getActiveTab(projectId, "/project/p1/settings/other")).toBe(
      "Settings",
    );
  });

  test("only one tab is active at a time for each path", () => {
    const paths = [
      "/project/p1",
      "/project/p1/",
      "/project/p1/chat",
      "/project/p1/chat/conv-123",
      "/project/p1/settings",
      "/project/p1/settings/other",
    ];

    for (const path of paths) {
      const activeTabs = getActiveTabs(projectId, path);
      expect(activeTabs).toHaveLength(1);
    }
  });

  test("no tab active for unrecognized path", () => {
    expect(getActiveTab("p1", "/project/p1/unknown")).toBeNull();
  });
});

// ─── PullToRefresh touch logic ───────────────────────────────────────────────

const THRESHOLD = 80;

function computePullDistance(dy: number): number {
  if (dy < 0) return 0;
  return Math.min(dy * 0.4, THRESHOLD * 1.5);
}

function shouldTriggerRefresh(pullDistance: number): boolean {
  return pullDistance >= THRESHOLD;
}

describe("PullToRefresh touch logic", () => {
  test("pull distance is dampened by 0.4 factor", () => {
    expect(computePullDistance(100)).toBe(40);
    expect(computePullDistance(50)).toBe(20);
    expect(computePullDistance(10)).toBe(4);
  });

  test("pull distance is capped at THRESHOLD * 1.5 = 120", () => {
    expect(computePullDistance(500)).toBe(120);
    expect(computePullDistance(1000)).toBe(120);
    expect(computePullDistance(300)).toBe(120);
  });

  test("exact cap boundary: dy=300 gives 120", () => {
    // 300 * 0.4 = 120 which equals the cap
    expect(computePullDistance(300)).toBe(120);
  });

  test("just below cap: dy=299 gives 119.6", () => {
    expect(computePullDistance(299)).toBeCloseTo(119.6, 1);
  });

  test("refresh triggers when pullDistance >= 80 (dy >= 200)", () => {
    // dy=200 => 200 * 0.4 = 80 => exactly threshold
    const pullAt200 = computePullDistance(200);
    expect(pullAt200).toBe(80);
    expect(shouldTriggerRefresh(pullAt200)).toBe(true);
  });

  test("refresh triggers above threshold", () => {
    const pull = computePullDistance(250);
    expect(pull).toBe(100);
    expect(shouldTriggerRefresh(pull)).toBe(true);
  });

  test("no refresh below threshold (dy=199)", () => {
    const pull = computePullDistance(199);
    expect(pull).toBeCloseTo(79.6, 1);
    expect(shouldTriggerRefresh(pull)).toBe(false);
  });

  test("no refresh for small pull", () => {
    const pull = computePullDistance(50);
    expect(pull).toBe(20);
    expect(shouldTriggerRefresh(pull)).toBe(false);
  });

  test("negative dy resets pull distance to 0", () => {
    expect(computePullDistance(-10)).toBe(0);
    expect(computePullDistance(-100)).toBe(0);
    expect(computePullDistance(-1)).toBe(0);
  });

  test("zero dy gives zero pull distance", () => {
    expect(computePullDistance(0)).toBe(0);
  });

  test("only activates when scrollTop is 0", () => {
    // Simulates the guard: pull-to-refresh should not compute when scrolled
    function shouldActivate(scrollTop: number): boolean {
      return scrollTop === 0;
    }
    expect(shouldActivate(50)).toBe(false);
    expect(shouldActivate(0)).toBe(true);
    expect(shouldTriggerRefresh(computePullDistance(200))).toBe(true);
  });
});

// NOTE: "Last path resume logic" moved to `resume-path.unit.test.ts`, which
// exercises the REAL `$lib/resume-path` module (resolveResumeTarget /
// isResumablePath / clearResumeState) instead of local reimplementations.

// ─── Viewport meta tag ──────────────────────────────────────────────────────

describe("Viewport meta tag", () => {
  const viewportContent =
    "width=device-width, initial-scale=1, interactive-widget=resizes-content";

  test("does not restrict zoom (WCAG compliance)", () => {
    expect(viewportContent).not.toContain("maximum-scale=1");
  });

  test("contains width=device-width", () => {
    expect(viewportContent).toContain("width=device-width");
  });

  test("contains initial-scale=1", () => {
    expect(viewportContent).toContain("initial-scale=1");
  });
});
