// docs-updater — boot-path + registration-wiring unit coverage.
//
// The full flow is proven by index.integration.test.ts (real primitive) and
// subprocess.integration.test.ts (real transport). This isolated file covers
// the production-boot `start()` body + the inline `log.artifact` mapper, which
// a spawned subprocess's coverage never contributes to this process's lcov.
//
// It drives the REAL registry (not a `defineLoop` stub — a `mock.module` stub
// would leak across test files and starve the integration test's real manual-
// tool registration). `__resetLoopsForTests` / `__resetChannelForTests` keep
// each test — and this whole file — isolated from the others.

import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import type { LoopRunState } from "@ezcorp/sdk/runtime";
import {
  __resetLoopsForTests,
  _getRegisteredLoop,
} from "../../../../packages/@ezcorp/sdk/src/runtime/loop";
import { __resetChannelForTests } from "../../../../packages/@ezcorp/sdk/src/runtime/channel";
import { defineDocsUpdaterLoop, start, APPROVE_EVENT, DECLINE_EVENT, PAGE_ID } from "./index";

beforeEach(() => __resetLoopsForTests());
afterEach(() => {
  __resetLoopsForTests();
  __resetChannelForTests();
});

function registeredDef() {
  const reg = _getRegisteredLoop("docs-updater");
  if (!reg) throw new Error("docs-updater loop not registered");
  return reg.def;
}

describe("defineDocsUpdaterLoop wiring", () => {
  test("registers the check / act / onComplete + approval contract + triggers", () => {
    defineDocsUpdaterLoop();
    const def = registeredDef();
    expect(typeof def.check).toBe("function");
    expect(typeof def.act).toBe("function");
    expect(typeof def.onComplete).toBe("function");
    expect(def.contract?.approval).toEqual({ mode: "proactive", staleAfterDays: 7 });
    expect(def.contract?.configVersion).toBe("1");
    const triggers = Array.isArray(def.trigger) ? def.trigger : [def.trigger];
    expect(triggers.map((t) => t.kind)).toEqual(["cron", "manual"]);
  });

  test("log.artifact maps a run + outcome to the PR trail file", () => {
    defineDocsUpdaterLoop();
    const artifact = registeredDef().log?.artifact as
      | ((run: LoopRunState, outcome: Record<string, unknown>) => { path: string; body: string })
      | undefined;
    const out = artifact!(
      { id: "run-3" } as LoopRunState,
      { headHash: "abcdef123456", prRef: "#7", marked: "ready", note: "n" },
    );
    expect(out.path).toBe("prs/run-3.md");
    expect(out.body).toContain("- pr: #7");
    expect(out.body).toContain("- marked: ready");
    expect(out.body).toContain("- note: n");
  });

  test("log.artifact omits absent fields", () => {
    defineDocsUpdaterLoop();
    const artifact = registeredDef().log?.artifact as
      | ((run: LoopRunState, outcome: Record<string, unknown>) => { path: string; body: string })
      | undefined;
    const out = artifact!({ id: "run-4" } as LoopRunState, { headHash: "" });
    expect(out.body).toContain("- head: ?");
    expect(out.body).not.toContain("- pr:");
    expect(out.body).not.toContain("- marked:");
  });

  test("log.dashboard names the page + the approve/decline row actions", () => {
    defineDocsUpdaterLoop();
    const dash = registeredDef().log?.dashboard;
    expect(dash?.pageId).toBe(PAGE_ID);
    expect(Object.keys(dash?.rowActions ?? {})).toEqual([APPROVE_EVENT, DECLINE_EVENT]);
  });
});

describe("start (production boot)", () => {
  test("registers the loop + mounts the dispatcher + starts the channel", () => {
    expect(() => start()).not.toThrow();
    expect(_getRegisteredLoop("docs-updater")?.contract.approval).toBeDefined();
  });
});
