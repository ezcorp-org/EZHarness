/**
 * Parity pins for the Ez client-side tools' watchdog budget.
 *
 * The defect these lock out: `fill_form` / `navigate_to` / `read_page`
 * suspend server-side for as long as the `ez-client-tool-registry` gate
 * allows (5 minutes), but they declared NO `callTimeoutMs`, so
 * subscribe-bridge handed the watchdog `DEFAULT_BUILTIN_CALL_TIMEOUT_MS`
 * (= `WATCHDOG_IDLE_MS`, 90s). The watchdog therefore stopped deferring
 * at 90s and killed the run while the tool was still legitimately
 * waiting — invisible with a fast local panel, fatal over a slow link or
 * whenever the round-trip took longer than 90s.
 *
 * Everything below is a PIN, not a re-test of the watchdog: it asserts
 * the two halves of the contract are derived from ONE symbol
 * (`getEzClientToolTimeoutMs`), so editing either side without the other
 * breaks a test instead of shipping a silent inversion.
 */

import { afterEach, describe, expect, mock, test, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// executor-watchdog reaches for the active-runs queries at import time's
// module graph; stub them so this stays a pure constant/shape test.
mock.module("../db/queries/active-runs", () => ({
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
  markInterrupted: async () => {},
  cleanupOrphanedRuns: async () => 0,
  interruptAllRuns: async () => 0,
  getActiveRun: async () => null,
}));

import {
  EZ_CLIENT_TOOL_TIMEOUT_MS,
  EZ_CLIENT_TOOL_WATCHDOG_MARGIN_MS,
  ezClientToolWatchdogBudgetMs,
  getEzClientToolTimeoutMs,
  _setEzClientToolTimeoutForTests,
  _resetEzClientToolTimeoutForTests,
} from "../runtime/ez-client-tool-registry";
import {
  DEFAULT_BUILTIN_CALL_TIMEOUT_MS,
  WATCHDOG_TICK_MS,
} from "../runtime/executor-watchdog";
import {
  createFillFormTool,
  createNavigateToTool,
  createReadPageTool,
  getEzToolDefs,
  isEzClientTool,
} from "../runtime/tools/ez";
import type { BuiltinToolDef } from "../runtime/tools/types";

const CLIENT_CTX = { conversationId: "conv-budget", userId: "user-budget" };

const FACTORIES: Array<[string, (ctx: typeof CLIENT_CTX) => BuiltinToolDef]> = [
  ["fill_form", createFillFormTool],
  ["navigate_to", createNavigateToTool],
  ["read_page", createReadPageTool],
];

afterEach(() => {
  _resetEzClientToolTimeoutForTests();
});

describe("ez client tools declare the gate's own wait as their watchdog budget", () => {
  for (const [name, factory] of FACTORIES) {
    test(`${name} pins callTimeoutMs to the registry timeout symbol + margin`, () => {
      const def = factory(CLIENT_CTX);
      expect(def.name).toBe(name);
      expect(def.clientSide).toBe(true);
      // Derived, never restated: the ONLY accepted value is the live gate
      // timeout plus the documented margin.
      expect(def.callTimeoutMs).toBe(
        getEzClientToolTimeoutMs() + EZ_CLIENT_TOOL_WATCHDOG_MARGIN_MS,
      );
      expect(def.callTimeoutMs).toBe(ezClientToolWatchdogBudgetMs());
    });

    test(`${name} outlasts the gate, so the registry wins the race`, () => {
      const def = factory(CLIENT_CTX);
      // Strictly greater: at the gate deadline the registry rejects with a
      // concrete "Timed out waiting for Ez client tool result" the LLM can
      // act on. The watchdog must NOT have killed the run first — its kill
      // takes the whole turn down with a generic banner.
      expect(def.callTimeoutMs!).toBeGreaterThan(getEzClientToolTimeoutMs());
      // …and by more than one watchdog tick, because the deferral is only
      // re-evaluated once per tick.
      expect(def.callTimeoutMs! - getEzClientToolTimeoutMs()).toBeGreaterThan(
        WATCHDOG_TICK_MS,
      );
    });

    test(`${name} escapes the 90s default that caused the kill`, () => {
      const def = factory(CLIENT_CTX);
      // The regression sentinel. Pre-fix this field was undefined and the
      // bridge fell through to DEFAULT_BUILTIN_CALL_TIMEOUT_MS.
      expect(def.callTimeoutMs).toBeDefined();
      expect(def.callTimeoutMs!).toBeGreaterThan(DEFAULT_BUILTIN_CALL_TIMEOUT_MS);
    });

    test(`${name} tracks a changed gate timeout instead of a frozen literal`, () => {
      // The single-source-of-truth proof: move the gate, the budget moves
      // with it. A hardcoded 300_000 (or 330_000) in the def would fail here.
      _setEzClientToolTimeoutForTests(12_345);
      const def = factory(CLIENT_CTX);
      expect(def.callTimeoutMs).toBe(12_345 + EZ_CLIENT_TOOL_WATCHDOG_MARGIN_MS);
    });
  }

  test("every clientSide def in the Ez tool set carries the budget (family guard)", () => {
    // Catches a FOURTH client-side tool added later without a budget —
    // the same defect, one file over.
    const defs = getEzToolDefs({ userId: "user-budget", conversationId: "conv-budget" });
    const clientDefs = defs.filter((d) => d.clientSide === true);
    expect(clientDefs.map((d) => d.name).sort()).toEqual([
      "fill_form",
      "navigate_to",
      "read_page",
    ]);
    for (const def of clientDefs) {
      expect(isEzClientTool(def.name)).toBe(true);
      expect(def.callTimeoutMs, `${def.name} has no watchdog budget`).toBe(
        ezClientToolWatchdogBudgetMs(),
      );
    }
  });
});

describe("the budget's own constants", () => {
  test("the gate default is the documented 5 minutes and the getter reports it", () => {
    expect(EZ_CLIENT_TOOL_TIMEOUT_MS).toBe(5 * 60_000);
    expect(getEzClientToolTimeoutMs()).toBe(EZ_CLIENT_TOOL_TIMEOUT_MS);
    expect(ezClientToolWatchdogBudgetMs()).toBe(
      EZ_CLIENT_TOOL_TIMEOUT_MS + EZ_CLIENT_TOOL_WATCHDOG_MARGIN_MS,
    );
  });

  test("the margin covers at least two watchdog ticks", () => {
    // Machine-checks the claim the margin's docblock makes. If the tick
    // is ever widened, this fails instead of silently eating the grace
    // that keeps the registry ahead of the watchdog.
    expect(EZ_CLIENT_TOOL_WATCHDOG_MARGIN_MS).toBeGreaterThanOrEqual(2 * WATCHDOG_TICK_MS);
  });

  test("the test override is reversible", () => {
    _setEzClientToolTimeoutForTests(7);
    expect(getEzClientToolTimeoutMs()).toBe(7);
    expect(ezClientToolWatchdogBudgetMs()).toBe(7 + EZ_CLIENT_TOOL_WATCHDOG_MARGIN_MS);
    _resetEzClientToolTimeoutForTests();
    expect(getEzClientToolTimeoutMs()).toBe(EZ_CLIENT_TOOL_TIMEOUT_MS);
  });
});
