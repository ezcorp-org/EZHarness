import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// ─── PullToRefresh: source-level guard on the reload trigger ─────────────────
//
// The BEHAVIOURAL suite moved to `pull-to-refresh-logic.unit.test.ts`, which
// exercises the REAL `$lib/components/pull-to-refresh-logic` module. What lived
// here re-implemented `computePullDistance`/`shouldTriggerRefresh` as local
// copies, so it asserted nothing about shipped code: it stayed fully green
// while the shipped guard read `document.scrollingElement.scrollTop` — pinned
// at 0 forever under the app's 100dvh shell — and hard-reloaded the app on
// every downward swipe.
//
// What stays here is the guard that suite could never provide: this file runs
// on the BUN leg, and a bun:test that IMPORTS a `web/src/lib/**` module the
// vitest leg measures corrupts that module's merged coverage (see the coverage
// trap in CLAUDE.md). So the source is PARSED, not imported — the same
// technique as `src/__tests__/author-draft-allowlist-parity.test.ts`.
//
// This pins the two properties that made the bug possible, at the only place
// they can regress: the component's arming guard, and the constants it shares
// with the logic module.

const COMPONENT_SRC = readFileSync(
  join(import.meta.dir, "..", "lib", "components", "PullToRefresh.svelte"),
  "utf8",
);
const LOGIC_SRC = readFileSync(
  join(import.meta.dir, "..", "lib", "components", "pull-to-refresh-logic.ts"),
  "utf8",
);

describe("PullToRefresh reload trigger (source guard)", () => {
  test("the component still ends in a real reload — the risk this guards", () => {
    // If this ever stops being true the rest of this block is pointless, so
    // assert the premise rather than assuming it.
    expect(COMPONENT_SRC).toContain("location.reload()");
  });

  test("arming does NOT depend on the document scroller alone", () => {
    // The exact defect: `document.scrollingElement.scrollTop` is permanently 0
    // under a 100dvh shell, so guarding on it armed the gesture everywhere.
    expect(COMPONENT_SRC).not.toMatch(/scrollEl\s*=\s*target\s*\?\?\s*document\.scrollingElement/);
    expect(COMPONENT_SRC).not.toMatch(/if\s*\(\s*scrollEl\.scrollTop\s*>\s*0\s*\)\s*return/);
  });

  test("arming resolves the scroller under the finger", () => {
    expect(COMPONENT_SRC).toContain("nearestScrollTop");
    // The touch target is what makes the walk-up meaningful.
    expect(COMPONENT_SRC).toMatch(/scrollTopUnder\(\s*e\.target\s*\)/);
  });

  test("the gesture is gated to the viewport where its indicator is visible", () => {
    expect(COMPONENT_SRC).toContain("isPullEnabled(window.innerWidth)");
    // The indicator is `md:hidden`; the gate must match Tailwind's `md`.
    expect(LOGIC_SRC).toMatch(/PULL_MAX_VIEWPORT_PX\s*=\s*768/);
    expect(COMPONENT_SRC).toContain("md:hidden");
  });

  test("touchcancel is handled, so an abandoned gesture cannot stay armed", () => {
    expect(COMPONENT_SRC).toContain("ontouchcancel");
    expect(COMPONENT_SRC).toContain("cancelPull");
  });

  test("the reload is reached only through endPull's explicit refresh signal", () => {
    // No other path in the component may call reload. Comments mention it too,
    // so strip them before counting.
    const code = COMPONENT_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const reloadCalls = code.match(/location\.reload\(\)/g) ?? [];
    expect(reloadCalls).toHaveLength(1);
    expect(code).toMatch(/if\s*\(resolved\.refresh\)\s*\{\s*refreshing\s*=\s*true;\s*location\.reload\(\)/);
  });

  test("the tuning constants live in one place and keep their values", () => {
    expect(LOGIC_SRC).toMatch(/PULL_THRESHOLD_PX\s*=\s*80/);
    expect(LOGIC_SRC).toMatch(/PULL_DAMPING\s*=\s*0\.4/);
    expect(LOGIC_SRC).toMatch(/PULL_MAX_PX\s*=\s*PULL_THRESHOLD_PX\s*\*\s*1\.5/);
    // The component must not re-declare its own copy of the threshold.
    expect(COMPONENT_SRC).not.toMatch(/const\s+THRESHOLD\s*=/);
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
