/**
 * RED source-read suite — palette vs palette-commands initial-view routing
 * (Phase 67 — Command Palette Search, plan 01 / TDD scaffold).
 *
 * Phase 67 adds a Cmd+Shift+P shortcut that opens the command palette in a
 * COMMAND-FIRST initial view, distinct from the existing Cmd+K shortcut
 * which opens it SEARCH-FIRST. Plan 04 wires this by adding a
 * `case "palette-commands"` arm to the (app) +layout.svelte keydown switch
 * and passing an initial-view prop down to the CommandPalette mount.
 *
 * Today's (app)/+layout.svelte only has the `case "palette"` arm (toggles
 * `commandPaletteOpen`) and mounts <CommandPalette> WITHOUT an initial-view
 * prop. So all three assertions below FAIL RED until Plan 04 lands — that
 * is the intended state.
 *
 * Why source-read instead of render: identical rationale to
 * app-layout-agents-nav.test.ts — jsdom does not cleanly reactive-derive
 * the layout's $state-driven keydown switch, and rendering the layout pulls
 * in the full nav/drawer/palette tree. A source-read pins the routing
 * policy without per-render overhead. Same `bun:test` + readFileSync +
 * import.meta.url style as that precedent.
 *
 * Regression: if someone collapses the two shortcuts back into one arm, or
 * drops the initial-view prop, this test fails — preserving the Phase 67
 * PAL-02 command-first-vs-search-first routing contract.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";

const layoutSrc = readFileSync(new URL("../routes/(app)/+layout.svelte", import.meta.url), "utf-8");

describe("(app) layout — Phase 67 palette initial-view routing", () => {
  test('has a `case "palette-commands"` arm (command-first initial view)', () => {
    // Plan 04 adds this arm distinct from the existing `case "palette"`.
    expect(layoutSrc).toMatch(/case\s+["']palette-commands["']\s*:/);
  });

  test('retains the `case "palette"` arm (search-first initial view)', () => {
    expect(layoutSrc).toMatch(/case\s+["']palette["']\s*:/);
  });

  test("the CommandPalette mount receives an initial-view prop wired from layout state", () => {
    // Plan 04 threads the chosen initial view into the palette mount, e.g.
    // `<CommandPalette ... initialView={paletteInitialView} ... />`. Pin the
    // prop pass-through without over-constraining the exact state var name.
    expect(layoutSrc).toMatch(/initialView\s*=\s*\{/);
  });
});
