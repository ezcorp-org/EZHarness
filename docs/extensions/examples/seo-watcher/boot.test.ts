// seo-watcher — boot-path + artifact-mirror + content-trust coverage.
//
// The full flow is proven by index.integration.test.ts (real primitive) and
// subprocess.integration.test.ts (real transport). This isolated file covers
// the production-boot `start()` body + the inline `log.artifact` mapper, which
// a spawned subprocess's coverage never contributes to this process's lcov, and
// asserts the `contentTrust` classification the registration stamps.
//
// It drives the REAL registry (NOT a `defineLoop` stub — a `mock.module` stub
// would leak across test files and starve the integration test's real manual-
// tool registration; docs-updater's boot.test learned the same trap).
// `__resetLoopsForTests` / `__resetChannelForTests` keep each test — and this
// whole file — isolated from the others.

import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import {
  __resetLoopsForTests,
  _getRegisteredLoop,
} from "../../../../packages/@ezcorp/sdk/src/runtime/loop";
import { isUntrustedInputLoop } from "../../../../packages/@ezcorp/sdk/src/runtime/loop-core";
import { __resetChannelForTests } from "../../../../packages/@ezcorp/sdk/src/runtime/channel";
import { defineSeoWatcherLoop, start, LOOP_ID, PAGE_ID, APPROVE_EVENT, DECLINE_EVENT } from "./index";

beforeEach(() => __resetLoopsForTests());
afterEach(() => {
  __resetLoopsForTests();
  __resetChannelForTests();
});

function registered() {
  const reg = _getRegisteredLoop(LOOP_ID);
  if (!reg) throw new Error("seo-watcher loop not registered");
  return reg;
}

type ArtifactFn = (
  run: { id: string; status: string },
  outcome: Record<string, unknown> | undefined,
) => { path: string; body: string };

function artifactOf(): ArtifactFn {
  const fn = registered().def.log?.artifact as ArtifactFn | undefined;
  if (!fn) throw new Error("no log.artifact");
  return fn;
}

describe("content-trust classification", () => {
  test("registration declares + stamps untrusted-input (fetch-based check)", () => {
    defineSeoWatcherLoop();
    const reg = registered();
    // The DECLARATION on the definition.
    expect(reg.def.contentTrust).toBe("untrusted-input");
    // The STAMP the registration derives (Phase 8's content-trust gate reads it).
    expect(reg.untrustedInput).toBe(true);
    // And the SDK predicate agrees for this definition's shape.
    expect(isUntrustedInputLoop(reg.def)).toBe(true);
  });

  test("registers the check / act + proactive-approval contract + safe shape", () => {
    defineSeoWatcherLoop();
    const def = registered().def;
    expect(typeof def.check).toBe("function");
    expect(typeof def.act).toBe("function");
    expect(def.contract?.approval).toEqual({ mode: "proactive", staleAfterDays: 7 });
    expect(def.contract?.concurrency).toEqual({ maxConcurrent: 1 });
    expect(def.contract?.configVersion).toBe("1");
    const triggers = Array.isArray(def.trigger) ? def.trigger : [def.trigger];
    expect(triggers.map((t) => t.kind)).toEqual(["cron", "manual"]);
    // No webhook trigger — untrusted-input rides the declaration, not a trigger.
    expect(triggers.some((t) => t.kind === "webhook")).toBe(false);
  });

  test("log.dashboard names the page + the approve/decline row actions", () => {
    defineSeoWatcherLoop();
    const dash = registered().def.log?.dashboard;
    expect(dash?.pageId).toBe(PAGE_ID);
    expect(Object.keys(dash?.rowActions ?? {})).toEqual([APPROVE_EVENT, DECLINE_EVENT]);
  });
});

describe("log.artifact mirror", () => {
  test("published run → the recommendation is written into the artifact body", () => {
    defineSeoWatcherLoop();
    const out = artifactOf()(
      { id: "run-7", status: "approved" },
      {
        metricLabel: "Competitor price",
        metric: 15,
        baseline: 9,
        direction: "rose",
        published: true,
        recommendation: "Match the price and refresh the copy.",
      },
    );
    expect(out.path).toBe("recommendations/run-7.md");
    expect(out.body).toContain("# seo-watcher recommendation run-7");
    expect(out.body).toContain("- status: approved");
    expect(out.body).toContain("- metric: Competitor price");
    expect(out.body).toContain("- reading: 15");
    expect(out.body).toContain("- baseline: 9");
    expect(out.body).toContain("- published: true");
    expect(out.body).toContain("## Recommendation");
    expect(out.body).toContain("Match the price and refresh the copy.");
  });

  test("declined run → no recommendation published, note surfaced, no baseline", () => {
    defineSeoWatcherLoop();
    const out = artifactOf()(
      { id: "run-9", status: "declined" },
      { metricLabel: "Ranking", metric: 4, direction: "fell", note: "seasonal dip" },
    );
    expect(out.body).toContain("- status: declined");
    expect(out.body).toContain("- note: seasonal dip");
    expect(out.body).toContain("_No recommendation published for this run._");
    expect(out.body).not.toContain("## Recommendation");
    expect(out.body).not.toContain("- baseline:");
    expect(out.body).not.toContain("- published:");
  });

  test("missing outcome → a status-only artifact (never throws)", () => {
    defineSeoWatcherLoop();
    const out = artifactOf()({ id: "run-x", status: "recommended" }, undefined);
    expect(out.path).toBe("recommendations/run-x.md");
    expect(out.body).toContain("- status: recommended");
    expect(out.body).toContain("_No recommendation published for this run._");
  });
});

describe("start (production boot)", () => {
  test("registers the loop + mounts the dispatcher + starts the channel", () => {
    expect(() => start()).not.toThrow();
    expect(_getRegisteredLoop(LOOP_ID)?.contract.approval).toBeDefined();
  });
});
