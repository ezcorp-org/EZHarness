import { test, expect, describe, beforeEach } from "bun:test";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import {
  buildPreviewOpenUrl,
  emitDetectionDecision,
  onPreviewDetected,
  PREVIEW_HOST_EXTENSION_ID,
} from "../runtime/preview/preview-detection-bridge";
import {
  registerPreviewBus,
  getRegisteredPreviewBus,
  _resetPreviewBusForTests,
} from "../runtime/preview/preview-bus-registry";
import {
  launchPreviewDevServer,
  killConversationProcesses,
  trackedProcessCount,
  _resetPreviewProcessesForTests,
} from "../runtime/preview/preview-spawn-orchestration";
import { _resetPreviewUidPoolForTests } from "../runtime/preview/preview-uid-pool";
import { PREVIEW_CONSENT_CARD_TYPE } from "../runtime/preview/preview-consent";
import type { PreviewDetectedEvent } from "../runtime/preview/preview-port-watcher";

const EVENT: PreviewDetectedEvent = { userId: "u1", conversationId: "conv-1", port: 5173 };

beforeEach(() => {
  _resetPreviewBusForTests();
  _resetPreviewUidPoolForTests();
  _resetPreviewProcessesForTests();
});

describe("buildPreviewOpenUrl", () => {
  test("builds https <label>.preview.<host>/__open?c=<code> when secure", () => {
    expect(buildPreviewOpenUrl("abc123", "the code", "ezcorp.example.com", true)).toBe(
      "https://abc123.preview.ezcorp.example.com/__open?c=the%20code",
    );
  });

  test("uses http when not secure", () => {
    expect(buildPreviewOpenUrl("abc", "c", "localhost", false)).toBe(
      "http://abc.preview.localhost/__open?c=c",
    );
  });

  test("returns null when no app host configured (preview origin disabled)", () => {
    expect(buildPreviewOpenUrl("abc", "c", null, true)).toBeNull();
    expect(buildPreviewOpenUrl("abc", "c", "  ", true)).toBeNull();
  });
});

describe("preview-bus-registry", () => {
  test("register + read back; null before registration", () => {
    expect(getRegisteredPreviewBus()).toBeNull();
    const bus = new EventBus<AgentEvents>();
    registerPreviewBus(bus);
    expect(getRegisteredPreviewBus()).toBe(bus);
  });
});

describe("emitDetectionDecision", () => {
  test("consent-card decision → tool:complete with the consent cardType", () => {
    const bus = new EventBus<AgentEvents>();
    const got: AgentEvents["tool:complete"][] = [];
    bus.on("tool:complete", (d) => got.push(d));
    const payload = emitDetectionDecision(
      bus,
      { kind: "consent-card", port: 5173, card: { conversationId: "conv-1", port: 5173, title: "t", summary: "s", actions: { expose: "e", ignore: "i", alwaysExpose: "a" } } },
      EVENT,
    );
    expect(payload).not.toBeNull();
    expect(got).toHaveLength(1);
    expect(got[0]!.cardType).toBe(PREVIEW_CONSENT_CARD_TYPE);
    expect(got[0]!.conversationId).toBe("conv-1");
    expect(got[0]!.extensionId).toBe(PREVIEW_HOST_EXTENSION_ID);
    expect((got[0]!.output as { kind: string }).kind).toBe("consent-card");
  });

  test("auto-exposed decision → tool:complete carrying the open URL", () => {
    const bus = new EventBus<AgentEvents>();
    const got: AgentEvents["tool:complete"][] = [];
    bus.on("tool:complete", (d) => got.push(d));
    emitDetectionDecision(
      bus,
      { kind: "auto-exposed", previewId: "pid", port: 5173, code: "code1", subdomainLabel: "pid" },
      EVENT,
      { appHost: "localhost", secure: false },
    );
    const out = got[0]!.output as { kind: string; url: string };
    expect(out.kind).toBe("auto-exposed");
    expect(out.url).toBe("http://pid.preview.localhost/__open?c=code1");
  });

  test("skipped decision → emits nothing, returns null", () => {
    const bus = new EventBus<AgentEvents>();
    let count = 0;
    bus.on("tool:complete", () => count++);
    const r = emitDetectionDecision(bus, { kind: "skipped", reason: "x" }, EVENT);
    expect(r).toBeNull();
    expect(count).toBe(0);
  });
});

describe("onPreviewDetected", () => {
  test("routes the decision onto the registered bus", async () => {
    const bus = new EventBus<AgentEvents>();
    const got: AgentEvents["tool:complete"][] = [];
    bus.on("tool:complete", (d) => got.push(d));
    await onPreviewDetected(EVENT, {
      getBus: () => bus,
      appHost: () => "localhost",
      decide: async () => ({ kind: "consent-card", port: 5173, card: { conversationId: "conv-1", port: 5173, title: "t", summary: "s", actions: { expose: "e", ignore: "i", alwaysExpose: "a" } } }),
    });
    expect(got).toHaveLength(1);
  });

  test("no bus → logged no-op (no throw)", async () => {
    await expect(
      onPreviewDetected(EVENT, {
        getBus: () => null,
        appHost: () => null,
        decide: async () => ({ kind: "skipped", reason: "x" }),
      }),
    ).resolves.toBeUndefined();
  });

  test("a throwing decide is swallowed (fail-safe)", async () => {
    await expect(
      onPreviewDetected(EVENT, {
        getBus: () => new EventBus<AgentEvents>(),
        appHost: () => null,
        decide: async () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("launchPreviewDevServer (spawn orchestration)", () => {
  test("uid mode: allocates a uid, registers with the watcher, spawns", () => {
    const watched: Array<{ c: string; u: string }> = [];
    let spawnedUid = -1;
    const res = launchPreviewDevServer(
      { conversationId: "conv-1", userId: "u1", workDir: "/work", command: "bun", args: ["dev"] },
      {
        capabilities: () => ({ mode: "uid" }),
        watcher: { watch: (c, u) => watched.push({ c, u }) },
        spawn: ({ uid }) => {
          spawnedUid = uid;
          return { pid: 999, kill: () => {}, exited: Promise.resolve(0) };
        },
      },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.process.pid).toBe(999);
      expect(res.uid).toBe(spawnedUid);
    }
    expect(watched).toEqual([{ c: "conv-1", u: "u1" }]);
  });

  test("refuses when not in uid mode (netns/static)", () => {
    const res = launchPreviewDevServer(
      { conversationId: "conv-1", userId: "u1", workDir: "/w", command: "bun" },
      { capabilities: () => ({ mode: "static" }) },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("mode=static");
  });

  test("refuses when the uid pool is exhausted", () => {
    const res = launchPreviewDevServer(
      { conversationId: "conv-1", userId: "u1", workDir: "/w", command: "bun" },
      { capabilities: () => ({ mode: "uid" }), allocUid: () => null },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("exhausted");
  });

  test("a spawn failure releases the uid + reports", () => {
    const res = launchPreviewDevServer(
      { conversationId: "conv-1", userId: "u1", workDir: "/w", command: "bun" },
      {
        capabilities: () => ({ mode: "uid" }),
        allocUid: () => ({ uid: 90001 }),
        spawn: () => {
          throw new Error("ENOENT helper");
        },
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("spawn failed");
  });

  test("validates required inputs", () => {
    expect(launchPreviewDevServer({ conversationId: "", userId: "u", workDir: "/w", command: "x" }).ok).toBe(false);
    expect(launchPreviewDevServer({ conversationId: "c", userId: "u", workDir: "", command: "x" }).ok).toBe(false);
  });

  test("tracks the launched process + killConversationProcesses confirms the kill via the helper", async () => {
    const killArgs: Array<{ uid: number; pgid: number }> = [];
    const res = launchPreviewDevServer(
      { conversationId: "conv-kill", userId: "u1", workDir: "/w", command: "bun", args: ["dev"] },
      {
        capabilities: () => ({ mode: "uid" }),
        // Capture the uid + pgid (== pid here) the orchestration records.
        spawn: ({ uid }) => ({ pid: 4242, uid, pgid: 4242, kill: () => {}, exited: new Promise(() => {}) }),
      },
    );
    expect(res.ok).toBe(true);
    expect(trackedProcessCount("conv-kill")).toBe(1);
    // CONFIRMED kill: the injected killPreview resolves true → killed:1.
    const r = await killConversationProcesses("conv-kill", {
      killPreview: async (uid, pgid) => { killArgs.push({ uid, pgid }); return true; },
    });
    expect(r).toEqual({ killed: 1, unconfirmed: 0 });
    // Routed through the helper with the captured uid + pgid (not proc.kill()).
    expect(killArgs).toHaveLength(1);
    expect(killArgs[0]!.pgid).toBe(4242);
    if (res.ok) expect(killArgs[0]!.uid).toBe(res.uid);
    expect(trackedProcessCount("conv-kill")).toBe(0);
    // Idempotent — reaping again is a no-op.
    expect(await killConversationProcesses("conv-kill")).toEqual({ killed: 0, unconfirmed: 0 });
  });

  test("an UNconfirmed helper kill is reported (drives uid quarantine)", async () => {
    launchPreviewDevServer(
      { conversationId: "conv-unconf", userId: "u1", workDir: "/w", command: "bun" },
      {
        capabilities: () => ({ mode: "uid" }),
        spawn: ({ uid }) => ({ pid: 7, uid, pgid: 7, kill: () => {}, exited: new Promise(() => {}) }),
      },
    );
    const r = await killConversationProcesses("conv-unconf", {
      killPreview: async () => false, // helper non-zero (EPERM / survived)
    });
    expect(r).toEqual({ killed: 0, unconfirmed: 1 });
    expect(trackedProcessCount("conv-unconf")).toBe(0);
  });

  test("a process with no captured uid/pgid counts as unconfirmed (fail-closed)", async () => {
    launchPreviewDevServer(
      { conversationId: "conv-nouid", userId: "u1", workDir: "/w", command: "bun" },
      {
        capabilities: () => ({ mode: "uid" }),
        // Inject-spawn returns NO uid/pgid → cannot confirm a cross-uid kill.
        spawn: () => ({ pid: 9, kill: () => {}, exited: new Promise(() => {}) }),
      },
    );
    let helperCalled = false;
    const r = await killConversationProcesses("conv-nouid", {
      killPreview: async () => { helperCalled = true; return true; },
    });
    expect(helperCalled).toBe(false); // never even attempts (no pgid)
    expect(r).toEqual({ killed: 0, unconfirmed: 1 });
  });

  test("a thrown helper kill counts as unconfirmed (does not throw)", async () => {
    launchPreviewDevServer(
      { conversationId: "conv-throw", userId: "u1", workDir: "/w", command: "bun" },
      {
        capabilities: () => ({ mode: "uid" }),
        spawn: ({ uid }) => ({ pid: 11, uid, pgid: 11, kill: () => {}, exited: new Promise(() => {}) }),
      },
    );
    const r = await killConversationProcesses("conv-throw", {
      killPreview: async () => { throw new Error("helper spawn boom"); },
    });
    expect(r).toEqual({ killed: 0, unconfirmed: 1 });
  });
});
