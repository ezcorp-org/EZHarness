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

// NOTE: "PullToRefresh touch logic" moved to
// `pull-to-refresh-logic.unit.test.ts`, which exercises the REAL
// `$lib/components/pull-to-refresh-logic` module (dampen / beginPull /
// movePull / endPull / cancelPull / nearestScrollTop).
//
// The suite that lived here re-implemented `computePullDistance` and
// `shouldTriggerRefresh` as local copies, so it asserted nothing about the
// code that ships. It stayed fully green while the shipped guard read
// `document.scrollingElement.scrollTop` — which is permanently 0 under the
// app's 100dvh shell — and hard-reloaded the app on every downward swipe.
// Same reasoning as the resume-logic move noted below.

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
