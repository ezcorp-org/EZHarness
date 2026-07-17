// seo-watcher — boot-path + artifact-mirror + content-trust coverage.
//
// The full trigger → check → act → approve path is proven by the REAL-primitive
// integration test, but the production-boot `start()` body and the inline
// `log.artifact` mapper aren't reached there (a spawned subprocess's coverage
// isn't collected, and the in-process integration test drives the primitive
// facade, not `start()`). This isolated file drives both IN-process against the
// SDK test channel (mirrors repo-activity-notify/boot.test.ts):
//   - `defineLoop` is captured via a delegating module stub so the loop's
//     `contentTrust` declaration + `log.artifact` mapper can be asserted directly.
//   - `start()` is called against the real channel/dispatcher (read loop is
//     fire-and-forget + reset after).
import { test, expect, describe, afterEach, mock } from "bun:test";

// Delegating stub: keep every real `@ezcorp/sdk/runtime` export, override ONLY
// `defineLoop` to capture the definition the example registers. Must be
// installed BEFORE importing ./index so the module binds the stubbed symbol.
interface CapturedDef {
  contentTrust?: string;
  trigger?: unknown;
  contract?: { approval?: { mode?: string }; concurrency?: { maxConcurrent?: number } };
  log?: {
    artifact?: (
      run: { id: string; status: string },
      outcome: Record<string, unknown> | undefined,
    ) => { path: string; body: string };
  };
}
let capturedDef: CapturedDef | undefined;
const real = await import("@ezcorp/sdk/runtime");
mock.module("@ezcorp/sdk/runtime", () => ({
  ...real,
  defineLoop: (def: CapturedDef) => {
    capturedDef = def;
  },
}));

const { start, defineSeoWatcherLoop } = await import("./index");

afterEach(() => {
  // `defineLoop` is stubbed to merely CAPTURE (it never touches the real loop
  // registry), so only the channel needs resetting between tests.
  real.__resetChannelForTests();
  capturedDef = undefined;
});

describe("content-trust classification", () => {
  test("the loop declares contentTrust: untrusted-input (fetch-based check)", () => {
    defineSeoWatcherLoop();
    expect(capturedDef?.contentTrust).toBe("untrusted-input");
    // No webhook trigger — the classification rides the explicit declaration.
    expect(capturedDef?.trigger).toEqual([
      { kind: "cron", cron: "0 7 * * *" },
      { kind: "manual", tool: "run_seo_watch" },
    ]);
    // Proactive approval + single-concurrency — the safe recommend-and-approve shape.
    expect(capturedDef?.contract?.approval?.mode).toBe("proactive");
    expect(capturedDef?.contract?.concurrency?.maxConcurrent).toBe(1);
  });
});

describe("log.artifact mirror", () => {
  test("published run → the recommendation is written into the artifact body", () => {
    defineSeoWatcherLoop();
    const artifact = capturedDef?.log?.artifact;
    expect(typeof artifact).toBe("function");
    const out = artifact!(
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

  test("declined run → no recommendation published, note surfaced", () => {
    defineSeoWatcherLoop();
    const artifact = capturedDef!.log!.artifact!;
    const out = artifact(
      { id: "run-9", status: "declined" },
      { metricLabel: "Ranking", metric: 4, direction: "fell", note: "seasonal dip" },
    );
    expect(out.body).toContain("- status: declined");
    expect(out.body).toContain("- note: seasonal dip");
    expect(out.body).toContain("_No recommendation published for this run._");
    expect(out.body).not.toContain("## Recommendation");
    // A declined run carries no baseline/published markers.
    expect(out.body).not.toContain("- baseline:");
    expect(out.body).not.toContain("- published:");
  });

  test("missing outcome → a status-only artifact (never throws)", () => {
    defineSeoWatcherLoop();
    const artifact = capturedDef!.log!.artifact!;
    const out = artifact({ id: "run-x", status: "recommended" }, undefined);
    expect(out.path).toBe("recommendations/run-x.md");
    expect(out.body).toContain("- status: recommended");
    expect(out.body).toContain("_No recommendation published for this run._");
  });
});

describe("start (production boot)", () => {
  test("registers the loop + mounts the dispatcher + starts the channel", () => {
    // Prime the real channel-side dispatcher register (production's real
    // defineLoop touches getChannel() before createToolDispatcher; our stub
    // skips that, so mirror the booted state explicitly).
    real.getChannel();
    // `start()` calls the (stubbed) defineLoop, then the REAL createToolDispatcher
    // + getChannel().start() — non-blocking; the read loop is reset in afterEach.
    expect(() => start()).not.toThrow();
    expect(capturedDef?.log?.artifact).toBeDefined();
  });
});
