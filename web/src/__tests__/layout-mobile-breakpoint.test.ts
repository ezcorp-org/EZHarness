/**
 * Phase 49.1 — Mobile-responsive sidebar: breakpoint-policy tests.
 *
 * The (app) `+layout.svelte` decides — purely via Tailwind class
 * strings — when to show the inline sidebar vs. the SwipeDrawer +
 * hamburger combination. v1.3 Phase 49 widened the threshold from
 * `<md` (768px) to `<lg` (1024px) so tablets also get the drawer.
 *
 * Why string assertions instead of `render(...)`: jsdom doesn't
 * actually compile Tailwind utilities into matched CSS rules —
 * `hidden lg:flex` resolves to no styling at all under jsdom, so
 * an `expect(el).not.toBeVisible()` would pass for the wrong
 * reason. The viewport-driven UX is exercised in the Phase 49.1
 * Playwright spec (`e2e/sidebar-mobile.spec.ts`) where a real
 * Chromium engine matches media queries. Here we pin the source
 * of truth: the literal class strings the component emits, so a
 * regression that flips back to `md:` fails fast and out-of-process
 * spec runs aren't required for the policy invariant.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";

const layoutSrc = readFileSync(
  new URL("../routes/(app)/+layout.svelte", import.meta.url),
  "utf-8",
);

describe("(app) layout — Phase 49.1 sidebar breakpoint policy", () => {
  test("project rail wrapper hides below lg (not md)", () => {
    // The wrapper around <ProjectRail /> must use `lg:flex` so the
    // rail vanishes on tablets and reappears on desktops.
    expect(layoutSrc).toContain('class="hidden lg:flex">\n\t\t<ProjectRail />');
    // Negative: the old `md:flex` policy must be gone for the rail.
    expect(layoutSrc).not.toContain('class="hidden md:flex">\n\t\t<ProjectRail />');
  });

  test("desktop sidebar <aside> hides below lg", () => {
    // `hidden lg:flex` on the <aside> ensures it joins the rail in
    // collapsing into the drawer at <lg.
    expect(layoutSrc).toMatch(
      /class="hidden lg:flex shrink-0 flex-col[^"]*"\s+aria-label="Sidebar"/,
    );
    expect(layoutSrc).not.toMatch(
      /class="hidden md:flex shrink-0 flex-col[^"]*"\s+aria-label="Sidebar"/,
    );
  });

  test("expand-when-collapsed button hides below lg", () => {
    // The thin "expand sidebar" button only makes sense on desktop —
    // mobile/tablet users can't have a desktop-collapsed sidebar
    // because the desktop sidebar is hidden entirely below lg.
    expect(layoutSrc).toMatch(
      /class="hidden lg:flex items-center justify-center w-6[^"]*"\s+title="Expand sidebar/,
    );
  });

  test("mobile/tablet header (with hamburger) shows below lg", () => {
    // Conversely, the hamburger-bearing header is `flex lg:hidden` so
    // it's visible exactly when the rail+sidebar disappear.
    expect(layoutSrc).toContain(
      'class="flex lg:hidden items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-4 py-3"',
    );
    // Negative: old md-scoped header gone.
    expect(layoutSrc).not.toContain(
      'class="flex md:hidden items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-4 py-3"',
    );
  });

  test("hamburger button has 44x44 touch target (WCAG 2.1 AA)", () => {
    // Phase 49.1 spec § 49.1.1 — every interactive element in the
    // mobile header is ≥44x44 px.
    expect(layoutSrc).toMatch(
      /aria-label="Open menu"[\s\S]{0,200}min-width: 44px; min-height: 44px;/,
    );
  });

  test("drawer-internal nav-links have 44px touch target (WCAG 2.1 AA)", () => {
    // Phase 49.1 spec § 49.1.1 — every interactive element in the mobile
    // surface is ≥44x44 px. The drawer's `<nav>` iterates `navLinks` and
    // emits each `<a>` with an inline `min-height: 44px` style. Pin that
    // so a regression that drops the inline style fails fast.
    expect(layoutSrc).toMatch(
      /\{#each navLinks as link, i\}[\s\S]*?<a[\s\S]{0,400}style="min-height: 44px;[^"]*"[\s\S]{0,200}<\/a>[\s\S]*?\{\/each\}/,
    );
  });

  test("hamburger button toggles store.mobileMenuOpen", () => {
    // The drawer infrastructure already existed; widening the
    // breakpoint must not change the click-handler contract.
    expect(layoutSrc).toMatch(
      /onclick=\{\(\) => \(store\.mobileMenuOpen = true\)\}/,
    );
  });

  test("SwipeDrawer wraps the same nav links as the desktop sidebar", () => {
    // The drawer's `<nav>` iterates over the same `navLinks` derived
    // store the desktop sidebar uses, ensuring the two stay in sync.
    // We assert both `{#each navLinks` blocks exist (one inline, one
    // inside the SwipeDrawer).
    const eachCount = (layoutSrc.match(/\{#each navLinks as link, i\}/g) ?? [])
      .length;
    expect(eachCount).toBeGreaterThanOrEqual(2);
  });

  test("data-testid hooks present for component + Playwright tests", () => {
    expect(layoutSrc).toContain('data-testid="mobile-header"');
    expect(layoutSrc).toContain('data-testid="mobile-menu-toggle"');
  });
});
