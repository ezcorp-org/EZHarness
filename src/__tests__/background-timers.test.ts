import { test, expect, describe, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Shared test state ─────────────────────────────────────────────

let intervalCalls: Array<{ fn: (...args: unknown[]) => void; delay: number }> = [];
let originalSetInterval: typeof setInterval;

// Mock-function handles we re-wire per test
let startDecayTimerMock = mock(() => () => {});
let runCompactionMock = mock(() => Promise.resolve());
let deleteExpiredSessionsMock = mock(() => Promise.resolve());
let cleanupOldErrorsMock = mock((_retainDays: number) => Promise.resolve());
let cleanupOldSdkCapabilityCallsMock = mock((_cfg: {
  llmDays: number;
  memoryDays: number;
  lessonsDays: number;
  scheduleDays: number;
  eventsDays?: number;
  force?: boolean;
}) => Promise.resolve(0));
let getSettingMock = mock((_key: string) => Promise.resolve<unknown>(undefined));

// BriefingDaemon stub instrumentation (Daily Briefing Phase 1). Same
// capture-mock pattern as the daemons below: the bootstrap reads
// `new BriefingDaemon()` then `.start()`. The REAL daemon's start()
// would run a boot tick and arm its own setInterval (breaking the
// intervalCalls length assertions); its per-class coverage lives in
// src/__tests__/briefing-daemon.test.ts. Per-test swaps to
// `briefingDaemonStartMock` cover the failure-isolation paths.
let briefingDaemonCtorMock = mock(() => {});
let briefingDaemonStartMock = mock(() => Promise.resolve<boolean>(true));
let briefingDaemonStopMock = mock(() => {});
let lastBriefingDaemonInstance: object | undefined;

// HostMaintenanceDaemon stub instrumentation. The bootstrap reads
// `new HostMaintenanceDaemon()` then `.start()`; we capture both so
// tests can assert (a) the daemon WAS instantiated and (b) the
// daemon's start() was called once. Per-test swaps to
// `permSweepDaemonStartMock` cover the failure-isolation paths
// (start() returns false; start() throws). The instance is recorded
// so a test can assert `_getPermSweepDaemonForTests()` returned
// THIS specific stub vs. undefined after a failed-start.
let permSweepDaemonCtorMock = mock(() => {});
let permSweepDaemonStartMock = mock(() => Promise.resolve<boolean>(true));
let permSweepDaemonStopMock = mock(() => {});
let lastPermSweepDaemonInstance: object | undefined;

// EmbedWorker stub instrumentation. Same capture-mock pattern as
// HostMaintenanceDaemon above: the bootstrap reads `new EmbedWorker()` then
// `.start()`. The REAL EmbedWorker.start() would acquire a PID lockfile,
// call getDb() for boot recovery, and arm its own setInterval — none of
// which belong in this wiring-focused suite (its per-class coverage lives
// in src/__tests__/embed-worker.test.ts). The stub's start() resolves true
// and registers NO interval, so the `intervalCalls` length assertions stay
// at 4. Per-test swaps to `embedWorkerStartMock` cover the failure-isolation
// paths (start() returns false; start() throws).
let embedWorkerCtorMock = mock(() => {});
let embedWorkerStartMock = mock(() => Promise.resolve<boolean>(true));
let embedWorkerStopMock = mock(() => {});
let lastEmbedWorkerInstance: object | undefined;

// FileOrganizerDaemon stub instrumentation. Same capture-mock pattern as
// EmbedWorker above: the bootstrap reads `new FileOrganizerDaemon({...})`
// then `.start(settings)`. The REAL daemon would acquire a PID lockfile,
// hash files, and arm its own setInterval — none of which belong in this
// wiring suite (its per-class coverage lives in
// src/__tests__/file-organizer-daemon.test.ts). The stub's start() resolves
// true and registers NO interval, so the intervalCalls length assertions
// stay at 4. The `getExtensionByName` + settings/engine/page-cache deps the
// bootstrap dynamic-imports are stubbed inert so the block doesn't reach the
// DB. Per-test swaps to `fileOrgDaemonStartMock` / `fileOrgExtMock` cover the
// failure-isolation + gating paths (not installed; disabled; start throws).
let fileOrgDaemonCtorMock = mock((_opts?: unknown) => {});
let fileOrgDaemonStartMock = mock((_s?: unknown) => Promise.resolve<boolean>(true));
let fileOrgDaemonStopMock = mock(() => {});
let lastFileOrgDaemonInstance: object | undefined;
// Returns the installed+enabled file-organizer extension row by default so
// the happy path constructs; re-pointable per-test (null = not installed).
let fileOrgExtMock = mock((_name: string) => Promise.resolve<{ id: string; enabled: boolean } | null>({ id: "ext-fo", enabled: true }));

// GithubProjectsDaemon stub instrumentation. Same capture-mock pattern as the
// daemons above: the bootstrap reads `new GithubProjectsDaemon()` then
// `.start()`. The REAL daemon's start() arms its own setInterval (breaking the
// intervalCalls length assertions); its per-class coverage lives in
// src/integrations/github-projects/__tests__/daemon.test.ts. NB this daemon's
// start() is SYNCHRONOUS (returns a boolean, not a Promise) — unlike the other
// daemons — so the stub returns a raw boolean. Per-test swaps to
// `githubDaemonStartMock` cover the failure-isolation paths (false-return; throw).
let githubDaemonCtorMock = mock(() => {});
let githubDaemonStartMock = mock<() => boolean>(() => true);
let githubDaemonStopMock = mock(() => {});
let lastGithubDaemonInstance: object | undefined;
// Boot reconciliation sweep (module-level export of the daemon module). The
// bootstrap awaits it BEFORE githubProjectsDaemon.start(); the delegating
// handle lets tests assert the ordering and drive the rejection path
// (a sweep failure must never prevent the daemon start).
let githubReconcileMock = mock(() => Promise.resolve<number>(0));
// The stub module's lazy singleton (mirrors the real module's
// getGithubProjectsDaemon). Module-level (NOT factory-closure) state so it
// survives Bun's mock.module materialization freeze the same way the other
// delegating handles do — reset per test in beforeEach.
let githubDaemonStubSingleton: object | null = null;

// PreviewPortWatcher stub instrumentation (Phase 2 — Secure Preview).
// Same capture-mock pattern as the daemons above: the bootstrap reads
// `new PreviewPortWatcher({...})` then `.start()`. The REAL watcher would
// acquire a PID lockfile and arm its own setInterval — neither belongs in
// this wiring suite (its per-class coverage lives in
// src/__tests__/preview-port-watcher.test.ts). The stub's start() resolves
// true and registers NO interval, so the `intervalCalls` length assertions
// stay at 4. Per-test swaps to `previewWatcherStartMock` cover the
// failure-isolation paths (start() returns false; start() throws). The
// source (NetnsPortSource) and consent router (decideOnDetection) the
// bootstrap also imports are stubbed to inert no-ops so neither pulls in
// the DB / netns graph.
let previewWatcherCtorMock = mock((_opts?: unknown) => {});
let previewWatcherStartMock = mock(() => Promise.resolve<boolean>(true));
let previewWatcherStopMock = mock(() => {});
let lastPreviewWatcherInstance: object | undefined;
// Phase 3b: capture the ctor CONFIG so tests can assert idleReapTicks parsing
// + that onIdleReap is wired. The stub records the options object the
// bootstrap passes to `new PreviewPortWatcher({...})`.
let lastPreviewWatcherConfig: {
  idleReapTicks?: number;
  onIdleReap?: (conversationId: string) => unknown;
  onDetected?: (event: unknown) => unknown;
  source?: unknown;
} | undefined;

// Phase 3a — capability MODE drives the enumeration-source selection in the
// bootstrap: `caps.mode === "uid" ? new ProcPortSource() : new
// NetnsPortSource()`. The default stub pins mode "static" (the host's
// fail-closed posture), so without overriding it the `uid → ProcPortSource`
// arm is never exercised (audit gap #1). `previewCapabilitiesMock` is
// re-pointable per-test so a variant can return mode "uid". The two source
// classes carry ctor spies so a test can assert WHICH source the bootstrap
// constructed.
let previewCapabilitiesMock = mock(() => ({
  static: true,
  dynamic: false,
  mode: "static" as "static" | "uid" | "netns",
  reason: "stub",
}));
let procPortSourceCtorMock = mock(() => {});
let netnsPortSourceCtorMock = mock(() => {});

// Logger spies. The structured logger writes JSON via process.stdout/stderr.write,
// bypassing console.* shims, so we mock the logger module itself and assert on
// (msg, fields) call shape. `child()` returns the same spy object so calls made
// via `logger.child("startup.timers")` land on the same mocks we inspect.
let loggerInfoMock = mock((_msg: string, _extra?: Record<string, unknown>) => {});
let loggerWarnMock = mock((_msg: string, _extra?: Record<string, unknown>) => {});
let loggerErrorMock = mock((_msg: string, _extra?: Record<string, unknown>) => {});

const loggerSpy = {
  info: (msg: string, extra?: Record<string, unknown>) => loggerInfoMock(msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => loggerWarnMock(msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => loggerErrorMock(msg, extra),
  debug: (_msg: string, _extra?: Record<string, unknown>) => {},
  child: () => loggerSpy,
};

function installModuleMocks(): void {
  mock.module("../memory/lifecycle", () => ({
    startDecayTimer: (...args: unknown[]) => startDecayTimerMock(...(args as [])),
  }));
  mock.module("../memory/compaction", () => ({
    runCompaction: (...args: unknown[]) => runCompactionMock(...(args as [])),
  }));
  mock.module("../db/queries/sessions", () => ({
    deleteExpiredSessions: (...args: unknown[]) => deleteExpiredSessionsMock(...(args as [])),
  }));
  mock.module("../db/queries/error-logs", () => ({
    cleanupOldErrors: (retainDays: number) => cleanupOldErrorsMock(retainDays),
  }));
  mock.module("../db/queries/sdk-capability-calls", () => ({
    cleanupOldSdkCapabilityCalls: (cfg: {
      llmDays: number;
      memoryDays: number;
      lessonsDays: number;
      scheduleDays: number;
      eventsDays?: number;
      force?: boolean;
    }) => cleanupOldSdkCapabilityCallsMock(cfg),
    // The timer also imports `clampDays` — mirror the production
    // behavior so a 0 setting is clamped to 1 (validator CR-3).
    clampDays: (value: number) => {
      if (!Number.isFinite(value)) return 30;
      return Math.max(1, Math.min(3650, Math.floor(value)));
    },
  }));
  mock.module("../db/queries/settings", () => ({
    getSetting: (key: string) => getSettingMock(key),
  }));
  // Phase 51: stub the ScheduleDaemon so the background-timers test
  // exercise stays focused on its own scope (decay / compaction /
  // cleanups). The daemon has its own dedicated suite at
  // src/extensions/__tests__/schedule-daemon.test.ts.
  mock.module("../extensions/schedule-daemon", () => ({
    ScheduleDaemon: class {
      start() { return Promise.resolve(true); }
      stop() {}
    },
  }));
  // Daily Briefing Phase 1: stub the BriefingDaemon. Its lifecycle /
  // claim coverage lives in src/__tests__/briefing-daemon.test.ts;
  // the REAL daemon would run a DB-touching boot tick and arm a 5th
  // setInterval here (breaking the intervalCalls length assertions —
  // the prior daemon-wiring incident). The stub registers NO interval.
  mock.module("../runtime/briefing/daemon", () => ({
    BriefingDaemon: class {
      constructor() {
        briefingDaemonCtorMock();
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        lastBriefingDaemonInstance = this;
      }
      start() { return briefingDaemonStartMock(); }
      stop() { briefingDaemonStopMock(); }
    },
  }));
  // Cap-expiry Phase 3: stub the HostMaintenanceDaemon for the same
  // reason — that daemon's lifecycle / sweep coverage lives in
  // src/__tests__/host-maintenance-daemon.test.ts, and standing it up
  // here would require a real DB. The stub's constructor + start()
  // route through capture-mocks (`permSweepDaemonCtorMock`,
  // `permSweepDaemonStartMock`) so tests can assert the daemon was
  // instantiated and its start() was called, AND swap start()'s
  // behavior per-test for failure-isolation cases (false-return,
  // throw). `lastPermSweepDaemonInstance` records the most recent
  // `new` so a test can compare against `_getPermSweepDaemonForTests()`.
  mock.module("../extensions/host-maintenance-daemon", () => ({
    HostMaintenanceDaemon: class {
      constructor() {
        permSweepDaemonCtorMock();
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        lastPermSweepDaemonInstance = this;
      }
      start() { return permSweepDaemonStartMock(); }
      stop() { permSweepDaemonStopMock(); }
    },
  }));
  // Phase 64: stub the EmbedWorker for the same reason — its per-class
  // lifecycle/ING coverage lives in src/__tests__/embed-worker.test.ts, and
  // standing up the real daemon here would acquire a lockfile, hit getDb(),
  // and arm a 5th setInterval (breaking the intervalCalls length assertions).
  mock.module("../extensions/embed-worker", () => ({
    EmbedWorker: class {
      constructor() {
        embedWorkerCtorMock();
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        lastEmbedWorkerInstance = this;
      }
      start() { return embedWorkerStartMock(); }
      stop() { embedWorkerStopMock(); }
    },
  }));
  // file-organizer: stub the FileOrganizerDaemon for the same reason — its
  // per-class coverage lives in src/__tests__/file-organizer-daemon.test.ts,
  // and the real daemon would acquire a lockfile + arm a 5th setInterval
  // (breaking the intervalCalls length assertions). The bootstrap
  // dynamic-imports getExtensionByName + getProjectRoot + getPermissionEngine
  // + getPageCache; we stub each inert so the block doesn't reach the DB.
  mock.module("../extensions/file-organizer-daemon", () => ({
    FileOrganizerDaemon: class {
      constructor(opts?: unknown) {
        fileOrgDaemonCtorMock(opts);
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        lastFileOrgDaemonInstance = this;
      }
      start(s?: unknown) { return fileOrgDaemonStartMock(s); }
      stop() { fileOrgDaemonStopMock(); }
    },
    DEFAULT_SETTINGS: {
      daemonEnabled: true,
      defaultMode: "ask-everything",
      quarantineTtlDays: 30,
      quarantineCapGb: 5,
      scanIntervalSec: 45,
      stabilityTicks: 2,
    },
    // The bootstrap's resolveFileOrganizerSettings() delegates to this pure
    // helper. Return enabled defaults so the happy-path daemon-construct arm
    // fires; the daemon-disabled gate is covered by re-pointing fileOrgExtMock.
    mergeFileOrganizerSettings: () => ({
      daemonEnabled: true,
      defaultMode: "ask-everything",
      quarantineTtlDays: 30,
      quarantineCapGb: 5,
      scanIntervalSec: 45,
      stabilityTicks: 2,
    }),
  }));
  mock.module("../db/queries/extensions", () => ({
    getExtensionByName: (name: string) => fileOrgExtMock(name),
  }));
  // github-projects: stub the GithubProjectsDaemon for the same reason — its
  // per-class coverage lives in
  // src/integrations/github-projects/__tests__/daemon.test.ts, and the real
  // daemon would arm a 5th setInterval (breaking the intervalCalls length
  // assertions). The stub's start() returns true and registers NO interval.
  // Export the FULL module surface (not just the class) so this stub can't
  // freeze `../integrations/github-projects/daemon` to a partial shape and break
  // daemon.test.ts in a shared `bun test src/` run (Bun mock.module
  // materialization freeze). CI runs each spec isolated, so this is local-only
  // hygiene — but it keeps the whole-suite run green.
  //
  // The bootstrap consumes the MODULE SINGLETON (getGithubProjectsDaemon), not
  // a private `new` — the reverse-RPC poll-now path shares the same accessor,
  // so the stub mirrors the real module's lazy-singleton semantics: the first
  // accessor call constructs (routing through the ctor spy), later calls
  // return the SAME instance. The singleton lives in the module-level
  // `githubDaemonStubSingleton` handle (reset in beforeEach), not the factory
  // closure, so per-test isolation holds regardless of factory re-runs.
  mock.module("../integrations/github-projects/daemon", () => {
    class GithubProjectsDaemonStub {
      constructor() {
        githubDaemonCtorMock();
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        lastGithubDaemonInstance = this;
      }
      start() { return githubDaemonStartMock(); }
      stop() { githubDaemonStopMock(); }
    }
    return {
      GithubProjectsDaemon: GithubProjectsDaemonStub,
      getGithubProjectsDaemon: () => {
        if (!githubDaemonStubSingleton) githubDaemonStubSingleton = new GithubProjectsDaemonStub();
        return githubDaemonStubSingleton;
      },
      // Boot reconciliation sweep — delegates so tests can assert call order
      // vs start() and drive the rejection path. Part of the SAME factory
      // (extend, never re-mock: Bun freezes the module shape at first
      // materialization).
      reconcileOrphanedProposals: () => githubReconcileMock(),
      _resetGithubProjectsDaemonForTests: () => {
        githubDaemonStubSingleton = null;
      },
    };
  });
  // The daemon settings resolver + page-cache + engine + project-root the
  // bootstrap dynamic-imports. Inert stubs keep them off the DB / fs.
  mock.module("../db/connection", () => ({
    getDb: () => ({
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    }),
  }));
  mock.module("../extensions/permission-engine", () => ({
    getPermissionEngine: () => ({ authorize: () => Promise.resolve({ decision: "allow", auditId: "a" }) }),
  }));
  mock.module("../extensions/page-cache", () => ({
    getPageCache: () => ({ invalidate: () => {} }),
  }));

  // Phase 2 (Secure Preview): stub the PreviewPortWatcher + its injected
  // deps. The watcher's own lifecycle/detection coverage lives in
  // src/__tests__/preview-port-watcher.test.ts; standing the real daemon
  // up here would grab a lockfile and arm a 5th setInterval (breaking the
  // intervalCalls length assertions). NetnsPortSource + decideOnDetection
  // are stubbed inert so the bootstrap's `new NetnsPortSource()` and the
  // onDetected closure don't reach the DB / netns probes.
  mock.module("../runtime/preview/preview-port-watcher", () => ({
    PreviewPortWatcher: class {
      constructor(opts?: typeof lastPreviewWatcherConfig) {
        previewWatcherCtorMock(opts);
        lastPreviewWatcherConfig = opts;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        lastPreviewWatcherInstance = this;
      }
      start() { return previewWatcherStartMock(); }
      stop() { previewWatcherStopMock(); }
    },
  }));
  mock.module("../runtime/preview/preview-port-source", () => ({
    NetnsPortSource: class {
      constructor() {
        netnsPortSourceCtorMock();
      }
    },
    ProcPortSource: class {
      constructor() {
        procPortSourceCtorMock();
      }
    },
  }));
  mock.module("../runtime/preview/preview-consent", () => ({
    decideOnDetection: () => Promise.resolve({ kind: "skipped", reason: "stub" }),
  }));
  // Phase 3a: stub the capability probe, the boot lockdown, the detection
  // bridge, and the bus registry so the watcher bootstrap doesn't reach
  // /proc, chmod the real .ezcorp/data, or the live bus. Keeping these inert
  // preserves the intervalCalls length assertions (the watcher stub above
  // registers NO setInterval) — see the prior background-timers incident.
  mock.module("../runtime/preview/preview-netns", () => ({
    previewCapabilities: () => previewCapabilitiesMock(),
  }));
  mock.module("../runtime/preview/preview-uid-pool", () => ({
    enforceDataDirLockdown: () => ({ ok: false, path: "/stub/.ezcorp/data", reason: "stub" }),
  }));
  mock.module("../runtime/preview/preview-detection-bridge", () => ({
    onPreviewDetected: () => Promise.resolve(),
  }));
  mock.module("../runtime/preview/preview-bus-registry", () => ({
    getRegisteredPreviewBus: () => null,
  }));
  // Superset of the real module shape (logger + extensionLogger) so a shared
  // run can't freeze `../logger` to a partial shape and break a sibling that
  // imports `extensionLogger`.
  mock.module("../logger", () => ({ logger: loggerSpy, extensionLogger: () => loggerSpy }));
}

beforeEach(async () => {
  // Reset mock handles so each test starts clean
  startDecayTimerMock = mock(() => () => {});
  runCompactionMock = mock(() => Promise.resolve());
  deleteExpiredSessionsMock = mock(() => Promise.resolve());
  cleanupOldErrorsMock = mock((_retainDays: number) => Promise.resolve());
  cleanupOldSdkCapabilityCallsMock = mock((_cfg: {
    llmDays: number;
    memoryDays: number;
    lessonsDays: number;
    scheduleDays: number;
    eventsDays?: number;
    force?: boolean;
  }) => Promise.resolve(0));
  getSettingMock = mock((_key: string) => Promise.resolve<unknown>(undefined));
  loggerInfoMock = mock((_msg: string, _extra?: Record<string, unknown>) => {});
  loggerWarnMock = mock((_msg: string, _extra?: Record<string, unknown>) => {});
  loggerErrorMock = mock((_msg: string, _extra?: Record<string, unknown>) => {});
  briefingDaemonCtorMock = mock(() => {});
  briefingDaemonStartMock = mock(() => Promise.resolve<boolean>(true));
  briefingDaemonStopMock = mock(() => {});
  lastBriefingDaemonInstance = undefined;
  permSweepDaemonCtorMock = mock(() => {});
  permSweepDaemonStartMock = mock(() => Promise.resolve<boolean>(true));
  permSweepDaemonStopMock = mock(() => {});
  lastPermSweepDaemonInstance = undefined;
  embedWorkerCtorMock = mock(() => {});
  embedWorkerStartMock = mock(() => Promise.resolve<boolean>(true));
  embedWorkerStopMock = mock(() => {});
  lastEmbedWorkerInstance = undefined;
  fileOrgDaemonCtorMock = mock((_opts?: unknown) => {});
  fileOrgDaemonStartMock = mock((_s?: unknown) => Promise.resolve<boolean>(true));
  fileOrgDaemonStopMock = mock(() => {});
  lastFileOrgDaemonInstance = undefined;
  fileOrgExtMock = mock((_name: string) => Promise.resolve<{ id: string; enabled: boolean } | null>({ id: "ext-fo", enabled: true }));
  githubDaemonCtorMock = mock(() => {});
  githubDaemonStartMock = mock<() => boolean>(() => true);
  githubDaemonStopMock = mock(() => {});
  githubReconcileMock = mock(() => Promise.resolve<number>(0));
  lastGithubDaemonInstance = undefined;
  githubDaemonStubSingleton = null;
  previewWatcherCtorMock = mock((_opts?: unknown) => {});
  previewWatcherStartMock = mock(() => Promise.resolve<boolean>(true));
  previewWatcherStopMock = mock(() => {});
  lastPreviewWatcherInstance = undefined;
  lastPreviewWatcherConfig = undefined;
  // Default capability mode is "static" (the host's fail-closed posture);
  // the ProcPortSource-selection test re-points this to "uid".
  previewCapabilitiesMock = mock(() => ({
    static: true,
    dynamic: false,
    mode: "static" as "static" | "uid" | "netns",
    reason: "stub",
  }));
  procPortSourceCtorMock = mock(() => {});
  netnsPortSourceCtorMock = mock(() => {});

  installModuleMocks();

  // Capture setInterval registrations without actually scheduling work.
  intervalCalls = [];
  originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: (...args: unknown[]) => void, delay: number) => {
    intervalCalls.push({ fn, delay });
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  // Reset the singleton flag — background-timers.ts is loaded once per process
  // and its internal `started` flag would persist across tests otherwise.
  const mod = await import("../startup/background-timers");
  mod._resetForTests();
});

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
});

// ── Tests ────────────────────────────────────────────────────────

describe("startBackgroundTimers", () => {
  test("first call schedules decay + 3 cleanup intervals + compaction interval", async () => {
    getSettingMock = mock((_key: string) => Promise.resolve<unknown>(undefined));
    installModuleMocks();

    const { startBackgroundTimers } = await import("../startup/background-timers");
    await startBackgroundTimers();

    // Decay timer is started directly (uses its own setInterval internally,
    // which we stubbed — it would return 0 but the mock still counts the call)
    expect(startDecayTimerMock).toHaveBeenCalledTimes(1);

    // Four setIntervals are registered directly: sessions, error-logs,
    // sdk-capability-calls retention sweep (Phase 50), compaction.
    expect(intervalCalls).toHaveLength(4);
    const hourMs = 60 * 60 * 1000;
    expect(intervalCalls[0]!.delay).toBe(hourMs);          // sessions hourly
    expect(intervalCalls[1]!.delay).toBe(hourMs);          // error-logs hourly
    expect(intervalCalls[2]!.delay).toBe(hourMs);          // sdk-capability sweep hourly
    expect(intervalCalls[3]!.delay).toBe(6 * hourMs);      // compaction 6h default

    // Success logs fired with structured fields
    expect(loggerInfoMock).toHaveBeenCalledWith("Decay sweep started", { intervalHours: 1 });
    expect(loggerInfoMock).toHaveBeenCalledWith("Compaction started", { intervalHours: 6 });
  });

  test("second call is a no-op (idempotent)", async () => {
    installModuleMocks();

    const { startBackgroundTimers } = await import("../startup/background-timers");
    await startBackgroundTimers();
    await startBackgroundTimers();
    await startBackgroundTimers();

    // All three calls combined should still equal the first-call results
    expect(startDecayTimerMock).toHaveBeenCalledTimes(1);
    expect(intervalCalls).toHaveLength(4);
  });

  test("decay timer failure is logged but compaction still starts", async () => {
    startDecayTimerMock = mock(() => { throw new Error("boom"); });
    installModuleMocks();

    const { startBackgroundTimers } = await import("../startup/background-timers");
    await startBackgroundTimers();

    // Warn was logged for decay with the error string
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Failed to start decay timer",
      { error: String(new Error("boom")) },
    );

    // Compaction block still ran — 4 setIntervals (sessions, errors,
    // sdk-capability sweep, compaction)
    expect(intervalCalls).toHaveLength(4);
    expect(loggerInfoMock).toHaveBeenCalledWith("Compaction started", { intervalHours: 6 });
  });

  test("getSetting failure leaves decay + cleanups running, logs compaction warning", async () => {
    getSettingMock = mock((_key: string) => Promise.reject(new Error("db down")));
    installModuleMocks();

    const { startBackgroundTimers } = await import("../startup/background-timers");
    await startBackgroundTimers();

    // Decay did start
    expect(startDecayTimerMock).toHaveBeenCalledTimes(1);

    // Three cleanup intervals were registered before the compaction
    // block threw (sessions, error-logs, sdk-capability sweep); no
    // compaction interval was added
    expect(intervalCalls).toHaveLength(3);

    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Failed to start compaction timer",
      { error: String(new Error("db down")) },
    );
  });

  test("custom compaction interval from settings is honored", async () => {
    getSettingMock = mock((key: string) => {
      return key === "global:compactionIntervalHours"
        ? Promise.resolve<unknown>(2)
        : Promise.resolve<unknown>(undefined);
    });
    installModuleMocks();

    const { startBackgroundTimers } = await import("../startup/background-timers");
    await startBackgroundTimers();

    const hourMs = 60 * 60 * 1000;
    const compactionCall = intervalCalls[3]!;
    expect(compactionCall.delay).toBe(2 * hourMs);

    expect(loggerInfoMock).toHaveBeenCalledWith("Compaction started", { intervalHours: 2 });
  });
});

// Daily Briefing Phase 1 — bootstrap wiring for BriefingDaemon.
// Mirrors the HostMaintenanceDaemon / EmbedWorker blocks below: assert
// the daemon is constructed + started + exposed, the kill-switch env
// gate, and the two fail-safe branches (start() resolving false;
// start() rejecting) — plus the load-bearing assertion that the new
// daemon adds NO setInterval here (intervalCalls stays at 4).
describe("startBackgroundTimers — BriefingDaemon bootstrap", () => {
  const PRIOR = process.env.EZCORP_DISABLE_BRIEFING_DAEMON;
  afterEach(() => {
    if (PRIOR === undefined) delete process.env.EZCORP_DISABLE_BRIEFING_DAEMON;
    else process.env.EZCORP_DISABLE_BRIEFING_DAEMON = PRIOR;
  });

  test("happy-path bootstrap: BriefingDaemon is instantiated, started, and exposed", async () => {
    delete process.env.EZCORP_DISABLE_BRIEFING_DAEMON;
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(briefingDaemonCtorMock).toHaveBeenCalledTimes(1);
    expect(briefingDaemonStartMock).toHaveBeenCalledTimes(1);
    const exposed = mod._getBriefingDaemonForTests();
    expect(exposed).toBeDefined();
    expect(exposed).toBe(lastBriefingDaemonInstance as never);
    expect(loggerInfoMock).toHaveBeenCalledWith("BriefingDaemon started", undefined);
    // The daemon stub adds NO setInterval — count unchanged at 4.
    expect(intervalCalls).toHaveLength(4);
  });

  test("EZCORP_DISABLE_BRIEFING_DAEMON=1 kill switch: never constructed", async () => {
    process.env.EZCORP_DISABLE_BRIEFING_DAEMON = "1";
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(briefingDaemonCtorMock).not.toHaveBeenCalled();
    expect(mod._getBriefingDaemonForTests()).toBeUndefined();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "BriefingDaemon disabled via EZCORP_DISABLE_BRIEFING_DAEMON",
      undefined,
    );
    expect(intervalCalls).toHaveLength(4);
  });

  test("start() resolving false: handle is dropped, rest of boot ran", async () => {
    delete process.env.EZCORP_DISABLE_BRIEFING_DAEMON;
    briefingDaemonStartMock = mock(() => Promise.resolve<boolean>(false));
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(briefingDaemonCtorMock).toHaveBeenCalledTimes(1);
    expect(briefingDaemonStartMock).toHaveBeenCalledTimes(1);
    expect(mod._getBriefingDaemonForTests()).toBeUndefined();
    expect(loggerInfoMock).not.toHaveBeenCalledWith("BriefingDaemon started", undefined);
    expect(intervalCalls).toHaveLength(4);
  });

  test("start() rejecting: handle is dropped, log.warn carries the error, no exception bubbles", async () => {
    delete process.env.EZCORP_DISABLE_BRIEFING_DAEMON;
    const bootErr = new Error("simulated briefing-daemon boot failure");
    briefingDaemonStartMock = mock(() => Promise.reject(bootErr));
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    // MUST resolve — the boot block's try/catch swallows the rejection.
    await mod.startBackgroundTimers();

    expect(briefingDaemonCtorMock).toHaveBeenCalledTimes(1);
    expect(mod._getBriefingDaemonForTests()).toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Failed to start BriefingDaemon",
      { error: String(bootErr) },
    );
    expect(intervalCalls).toHaveLength(4);
  });

  test("stopBackgroundTimers() and _resetForTests() tear down the daemon", async () => {
    delete process.env.EZCORP_DISABLE_BRIEFING_DAEMON;
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();
    expect(mod._getBriefingDaemonForTests()).toBeDefined();

    await mod.stopBackgroundTimers();
    expect(briefingDaemonStopMock).toHaveBeenCalledTimes(1);
    expect(mod._getBriefingDaemonForTests()).toBeUndefined();

    await mod.startBackgroundTimers();
    expect(mod._getBriefingDaemonForTests()).toBeDefined();
    mod._resetForTests();
    expect(briefingDaemonStopMock).toHaveBeenCalledTimes(2);
    expect(mod._getBriefingDaemonForTests()).toBeUndefined();
  });
});

// Cap-expiry Phase 3 — bootstrap wiring for HostMaintenanceDaemon.
// Validators flagged that nothing in this file actually asserts
// `permSweepDaemon` is instantiated (must-fix #2) or that the
// daemon-start failure paths null the singleton handle (must-fix #3,
// covering `start() === false` AND `start()` rejecting). These tests
// close that gap by leaning on the constructor / start spies wired
// into the stub class above.
describe("startBackgroundTimers — HostMaintenanceDaemon bootstrap", () => {
  test("happy-path bootstrap: HostMaintenanceDaemon is instantiated and started", async () => {
    // Default per-test stub: ctor recorded, start() resolves true.
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    // Constructor fired exactly once.
    expect(permSweepDaemonCtorMock).toHaveBeenCalledTimes(1);
    // start() called exactly once.
    expect(permSweepDaemonStartMock).toHaveBeenCalledTimes(1);
    // The exported test-handle returns the SAME instance that was
    // constructed — proves the bootstrap stored the daemon, not
    // dropped it.
    const exposed = mod._getPermSweepDaemonForTests();
    expect(exposed).toBeDefined();
    expect(exposed).toBe(lastPermSweepDaemonInstance as never);
    // Success log fired ("started"). The boot block emits this only
    // when start() returned true. The bootstrap's call site is
    // `log.info("HostMaintenanceDaemon started")` (no fields), but
    // the spy normalizes the second arg to `undefined` per its
    // signature, so we match that exact shape.
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "HostMaintenanceDaemon started",
      undefined,
    );
  });

  test("start() resolving false: handle is dropped, no exception bubbles, rest of boot still ran", async () => {
    // Failure mode 3a: kill switch or sibling-lockfile path inside
    // the daemon's start() returns false. The boot block must drop
    // the handle (set permSweepDaemon = undefined) and CONTINUE — the
    // surface-audit timer still gets a chance, the unrelated
    // intervals are intact. The daemon's own `start()` already
    // logged the reason, so the boot block does NOT double-log.
    permSweepDaemonStartMock = mock(() => Promise.resolve<boolean>(false));
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    // Constructor and start() each called once.
    expect(permSweepDaemonCtorMock).toHaveBeenCalledTimes(1);
    expect(permSweepDaemonStartMock).toHaveBeenCalledTimes(1);
    // Handle is undefined after the false-return.
    expect(mod._getPermSweepDaemonForTests()).toBeUndefined();
    // No "started" log fired (success path didn't run). Match the
    // exact (msg, undefined) shape the spy normalizes a 1-arg call to.
    expect(loggerInfoMock).not.toHaveBeenCalledWith(
      "HostMaintenanceDaemon started",
      undefined,
    );
    // No "Failed to start" warn either — the daemon's own start()
    // already logged its reason; the bootstrap deliberately doesn't
    // double-log on a clean false-return.
    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      "Failed to start HostMaintenanceDaemon",
      expect.any(Object) as never,
    );
    // The rest of boot still executed — the four prior intervals
    // (sessions, errors, sdk-capability sweep, compaction) are all
    // present. (Surface audit defaults to 0h = disabled.)
    expect(intervalCalls).toHaveLength(4);
  });

  test("start() rejecting: handle is dropped, log.warn carries the error, no exception bubbles", async () => {
    // Failure mode 3b: start() throws (e.g. lockfile FS error,
    // unexpected runtime fault). The boot block's try/catch must
    // catch it, log a warning that names the daemon, drop the
    // handle, and CONTINUE — boot doesn't crash on a daemon
    // pathology.
    const bootErr = new Error("simulated boot failure");
    permSweepDaemonStartMock = mock(() => Promise.reject(bootErr));
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    // Crucially: this MUST resolve (no exception bubbles up).
    await mod.startBackgroundTimers();

    expect(permSweepDaemonCtorMock).toHaveBeenCalledTimes(1);
    expect(permSweepDaemonStartMock).toHaveBeenCalledTimes(1);
    // Handle is dropped after the throw.
    expect(mod._getPermSweepDaemonForTests()).toBeUndefined();
    // The bootstrap's catch block logs the failure with the error
    // string (matching background-timers.ts:144).
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Failed to start HostMaintenanceDaemon",
      { error: String(bootErr) },
    );
    // Other boot work was unaffected.
    expect(intervalCalls).toHaveLength(4);
  });
});

// Phase 64 — bootstrap wiring for EmbedWorker. Mirrors the
// HostMaintenanceDaemon bootstrap block above: assert the worker is
// constructed + started and the handle is exposed, plus the two
// fail-safe branches (start() resolving false and start() rejecting)
// both drop the handle without crashing boot. The wiring in
// background-timers.ts is a verbatim copy of the HostMaintenanceDaemon
// fail-safe shape, so these tests guard against a regression in that
// copied boilerplate.
describe("startBackgroundTimers — EmbedWorker bootstrap", () => {
  test("happy-path bootstrap: EmbedWorker is instantiated, started, and exposed", async () => {
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(embedWorkerCtorMock).toHaveBeenCalledTimes(1);
    expect(embedWorkerStartMock).toHaveBeenCalledTimes(1);
    const exposed = mod._getEmbedWorkerForTests();
    expect(exposed).toBeDefined();
    expect(exposed).toBe(lastEmbedWorkerInstance as never);
    // Success log fired ("started"). 1-arg call normalizes to (msg, undefined).
    expect(loggerInfoMock).toHaveBeenCalledWith("EmbedWorker started", undefined);
  });

  test("start() resolving false: handle is dropped, no exception bubbles, rest of boot ran", async () => {
    // Kill switch / lockfile-sibling refusal returns false. The boot block
    // drops the handle and continues; the daemon's own start() already
    // logged the reason so the bootstrap does NOT double-log.
    embedWorkerStartMock = mock(() => Promise.resolve<boolean>(false));
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(embedWorkerCtorMock).toHaveBeenCalledTimes(1);
    expect(embedWorkerStartMock).toHaveBeenCalledTimes(1);
    expect(mod._getEmbedWorkerForTests()).toBeUndefined();
    expect(loggerInfoMock).not.toHaveBeenCalledWith("EmbedWorker started", undefined);
    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      "Failed to start EmbedWorker",
      expect.any(Object) as never,
    );
    // The four prior intervals are intact (boot continued).
    expect(intervalCalls).toHaveLength(4);
  });

  test("start() rejecting: handle is dropped, log.warn carries the error, no exception bubbles", async () => {
    const bootErr = new Error("simulated embed-worker boot failure");
    embedWorkerStartMock = mock(() => Promise.reject(bootErr));
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    // MUST resolve — the boot block's try/catch swallows the rejection.
    await mod.startBackgroundTimers();

    expect(embedWorkerCtorMock).toHaveBeenCalledTimes(1);
    expect(embedWorkerStartMock).toHaveBeenCalledTimes(1);
    expect(mod._getEmbedWorkerForTests()).toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Failed to start EmbedWorker",
      { error: String(bootErr) },
    );
    expect(intervalCalls).toHaveLength(4);
  });

  test("stopBackgroundTimers() and _resetForTests() tear down the worker", async () => {
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();
    expect(mod._getEmbedWorkerForTests()).toBeDefined();

    await mod.stopBackgroundTimers();
    expect(embedWorkerStopMock).toHaveBeenCalledTimes(1);
    expect(mod._getEmbedWorkerForTests()).toBeUndefined();

    // _resetForTests() on a fresh start also tears the worker down.
    await mod.startBackgroundTimers();
    expect(mod._getEmbedWorkerForTests()).toBeDefined();
    mod._resetForTests();
    expect(embedWorkerStopMock).toHaveBeenCalledTimes(2);
    expect(mod._getEmbedWorkerForTests()).toBeUndefined();
  });
});

// file-organizer — bootstrap wiring for FileOrganizerDaemon. Mirrors the
// EmbedWorker block, plus the gating branches unique to this daemon: it is
// constructed ONLY when the extension is installed+enabled (getExtensionByName
// non-null) AND its `daemon_enabled` setting is true. The load-bearing
// assertion from the prior daemon-wiring incident: the daemon's stub
// registers NO setInterval, so intervalCalls stays at 4.
describe("startBackgroundTimers — FileOrganizerDaemon bootstrap", () => {
  test("happy-path: daemon constructed, started, exposed; no 5th interval", async () => {
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(fileOrgDaemonCtorMock).toHaveBeenCalledTimes(1);
    expect(fileOrgDaemonStartMock).toHaveBeenCalledTimes(1);
    const exposed = mod._getFileOrganizerDaemonForTests();
    expect(exposed).toBeDefined();
    expect(exposed).toBe(lastFileOrgDaemonInstance as never);
    expect(loggerInfoMock).toHaveBeenCalledWith("FileOrganizerDaemon started", undefined);
    expect(intervalCalls).toHaveLength(4);
  });

  test("extension not installed: daemon never constructed, boot continues", async () => {
    fileOrgExtMock = mock((_n: string) => Promise.resolve<{ id: string; enabled: boolean } | null>(null));
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(fileOrgDaemonCtorMock).not.toHaveBeenCalled();
    expect(mod._getFileOrganizerDaemonForTests()).toBeUndefined();
    expect(intervalCalls).toHaveLength(4);
  });

  test("extension installed but disabled: daemon never constructed", async () => {
    fileOrgExtMock = mock((_n: string) => Promise.resolve<{ id: string; enabled: boolean } | null>({ id: "ext-fo", enabled: false }));
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(fileOrgDaemonCtorMock).not.toHaveBeenCalled();
    expect(mod._getFileOrganizerDaemonForTests()).toBeUndefined();
  });

  test("start() resolving false: handle dropped, boot continues", async () => {
    fileOrgDaemonStartMock = mock((_s?: unknown) => Promise.resolve<boolean>(false));
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(fileOrgDaemonCtorMock).toHaveBeenCalledTimes(1);
    expect(mod._getFileOrganizerDaemonForTests()).toBeUndefined();
    expect(intervalCalls).toHaveLength(4);
  });

  test("start() rejecting: handle dropped, log.warn carries the error", async () => {
    const bootErr = new Error("simulated file-organizer boot failure");
    fileOrgDaemonStartMock = mock((_s?: unknown) => Promise.reject(bootErr));
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(mod._getFileOrganizerDaemonForTests()).toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Failed to start FileOrganizerDaemon",
      { error: String(bootErr) },
    );
    expect(intervalCalls).toHaveLength(4);
  });

  test("stopBackgroundTimers() and _resetForTests() tear down the daemon", async () => {
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();
    expect(mod._getFileOrganizerDaemonForTests()).toBeDefined();

    await mod.stopBackgroundTimers();
    expect(fileOrgDaemonStopMock).toHaveBeenCalledTimes(1);
    expect(mod._getFileOrganizerDaemonForTests()).toBeUndefined();

    await mod.startBackgroundTimers();
    expect(mod._getFileOrganizerDaemonForTests()).toBeDefined();
    mod._resetForTests();
    expect(fileOrgDaemonStopMock).toHaveBeenCalledTimes(2);
    expect(mod._getFileOrganizerDaemonForTests()).toBeUndefined();
  });
});

// github-projects — bootstrap wiring for GithubProjectsDaemon. Mirrors the
// EmbedWorker block: assert the daemon is constructed + started + exposed, plus
// the two fail-safe branches (start() returns false → handle dropped; start()
// throws → handle dropped + warn logged). NB this daemon's start() is
// SYNCHRONOUS (boolean, not a Promise). The load-bearing assertion from the
// prior daemon-wiring incident: the daemon's stub registers NO setInterval, so
// intervalCalls stays at 4.
describe("startBackgroundTimers — GithubProjectsDaemon bootstrap", () => {
  test("happy-path bootstrap: GithubProjectsDaemon is instantiated, started, and exposed", async () => {
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(githubDaemonCtorMock).toHaveBeenCalledTimes(1);
    expect(githubDaemonStartMock).toHaveBeenCalledTimes(1);
    const exposed = mod._getGithubProjectsDaemonForTests();
    expect(exposed).toBeDefined();
    expect(exposed).toBe(lastGithubDaemonInstance as never);
    expect(loggerInfoMock).toHaveBeenCalledWith("GithubProjectsDaemon started", undefined);
    expect(intervalCalls).toHaveLength(4);
  });

  test("bootstrap uses the MODULE SINGLETON — the poll-now RPC path's accessor returns the SAME instance", async () => {
    // The non-reentrancy guard + per-link rate-limit back-off live on the
    // instance, so the boot poller and the reverse-RPC poll-now path MUST
    // share one daemon. Assert the bootstrap stored exactly the instance
    // `getGithubProjectsDaemon()` (the poll-now path's accessor) returns —
    // a private `new GithubProjectsDaemon(...)` here would fail this.
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    const daemonMod = await import("../integrations/github-projects/daemon");
    expect(mod._getGithubProjectsDaemonForTests()).toBe(daemonMod.getGithubProjectsDaemon() as never);
    // The lazy singleton constructed exactly once for both paths.
    expect(githubDaemonCtorMock).toHaveBeenCalledTimes(1);
  });

  test("boot reconciliation sweep runs exactly once, BEFORE the daemon start", async () => {
    // Orphaned-proposal reconciliation must precede the poll loop arming so a
    // freed card's re-trigger is observed against post-sweep state. Capture
    // the relative order via shared markers on the two delegating handles.
    const order: string[] = [];
    githubReconcileMock = mock(() => {
      order.push("reconcile");
      return Promise.resolve<number>(0);
    });
    githubDaemonStartMock = mock<() => boolean>(() => {
      order.push("start");
      return true;
    });
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(githubReconcileMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["reconcile", "start"]);
    // The sweep registers NO setInterval — count unchanged at 4.
    expect(intervalCalls).toHaveLength(4);
  });

  test("sweep rejection does NOT prevent the daemon start (warn logged, boot continues)", async () => {
    const sweepErr = new Error("simulated reconcile failure");
    githubReconcileMock = mock(() => Promise.reject(sweepErr));
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    // MUST resolve — the inline .catch swallows the sweep rejection.
    await mod.startBackgroundTimers();

    // The daemon still started and its handle is exposed.
    expect(githubDaemonStartMock).toHaveBeenCalledTimes(1);
    expect(mod._getGithubProjectsDaemonForTests()).toBeDefined();
    expect(mod._getGithubProjectsDaemonForTests()).toBe(lastGithubDaemonInstance as never);
    expect(loggerInfoMock).toHaveBeenCalledWith("GithubProjectsDaemon started", undefined);
    // The sweep failure is surfaced as a warn (not the daemon-start warn).
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "github-projects boot reconciliation failed",
      { error: String(sweepErr) },
    );
    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      "Failed to start GithubProjectsDaemon",
      expect.any(Object) as never,
    );
    expect(intervalCalls).toHaveLength(4);
  });

  test("start() returning false (kill-switch): handle is dropped, boot continues", async () => {
    githubDaemonStartMock = mock<() => boolean>(() => false);
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(githubDaemonCtorMock).toHaveBeenCalledTimes(1);
    expect(githubDaemonStartMock).toHaveBeenCalledTimes(1);
    expect(mod._getGithubProjectsDaemonForTests()).toBeUndefined();
    expect(loggerInfoMock).not.toHaveBeenCalledWith("GithubProjectsDaemon started", undefined);
    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      "Failed to start GithubProjectsDaemon",
      expect.any(Object) as never,
    );
    expect(intervalCalls).toHaveLength(4);
  });

  test("start() throwing: handle is dropped, log.warn carries the error, no exception bubbles", async () => {
    const bootErr = new Error("simulated github-projects boot failure");
    githubDaemonStartMock = mock<() => boolean>(() => { throw bootErr; });
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(githubDaemonCtorMock).toHaveBeenCalledTimes(1);
    expect(githubDaemonStartMock).toHaveBeenCalledTimes(1);
    expect(mod._getGithubProjectsDaemonForTests()).toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Failed to start GithubProjectsDaemon",
      { error: String(bootErr) },
    );
    expect(intervalCalls).toHaveLength(4);
  });

  test("stopBackgroundTimers() and _resetForTests() tear down the daemon", async () => {
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();
    expect(mod._getGithubProjectsDaemonForTests()).toBeDefined();

    await mod.stopBackgroundTimers();
    expect(githubDaemonStopMock).toHaveBeenCalledTimes(1);
    expect(mod._getGithubProjectsDaemonForTests()).toBeUndefined();

    await mod.startBackgroundTimers();
    expect(mod._getGithubProjectsDaemonForTests()).toBeDefined();
    mod._resetForTests();
    expect(githubDaemonStopMock).toHaveBeenCalledTimes(2);
    expect(mod._getGithubProjectsDaemonForTests()).toBeUndefined();
  });
});

// Phase 2 (Secure Preview) — bootstrap wiring for PreviewPortWatcher.
// Mirrors the EmbedWorker / HostMaintenanceDaemon blocks: assert the
// watcher is constructed + started + exposed, plus the two fail-safe
// branches (start() resolving false; start() rejecting) both drop the
// handle without crashing boot, AND — the load-bearing assertion from the
// prior daemon-wiring incident — the new daemon must NOT add a 5th
// setInterval (its stub registers none), so intervalCalls stays at 4.
describe("startBackgroundTimers — PreviewPortWatcher bootstrap", () => {
  test("happy-path bootstrap: PreviewPortWatcher is instantiated, started, and exposed", async () => {
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(previewWatcherCtorMock).toHaveBeenCalledTimes(1);
    expect(previewWatcherStartMock).toHaveBeenCalledTimes(1);
    const exposed = mod._getPreviewPortWatcherForTests();
    expect(exposed).toBeDefined();
    expect(exposed).toBe(lastPreviewWatcherInstance as never);
    expect(loggerInfoMock).toHaveBeenCalledWith("PreviewPortWatcher started", undefined);
    // The watcher adds NO setInterval — interval count is unchanged at 4
    // (sessions, errors, sdk-capability sweep, compaction).
    expect(intervalCalls).toHaveLength(4);
  });

  test("start() resolving false: handle is dropped, no exception bubbles, rest of boot ran", async () => {
    previewWatcherStartMock = mock(() => Promise.resolve<boolean>(false));
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(previewWatcherCtorMock).toHaveBeenCalledTimes(1);
    expect(previewWatcherStartMock).toHaveBeenCalledTimes(1);
    expect(mod._getPreviewPortWatcherForTests()).toBeUndefined();
    expect(loggerInfoMock).not.toHaveBeenCalledWith("PreviewPortWatcher started", undefined);
    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      "Failed to start PreviewPortWatcher",
      expect.any(Object) as never,
    );
    expect(intervalCalls).toHaveLength(4);
  });

  test("start() rejecting: handle is dropped, log.warn carries the error, no exception bubbles", async () => {
    const bootErr = new Error("simulated preview-watcher boot failure");
    previewWatcherStartMock = mock(() => Promise.reject(bootErr));
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(previewWatcherCtorMock).toHaveBeenCalledTimes(1);
    expect(previewWatcherStartMock).toHaveBeenCalledTimes(1);
    expect(mod._getPreviewPortWatcherForTests()).toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Failed to start PreviewPortWatcher",
      { error: String(bootErr) },
    );
    expect(intervalCalls).toHaveLength(4);
  });

  test("stopBackgroundTimers() and _resetForTests() tear down the watcher", async () => {
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();
    expect(mod._getPreviewPortWatcherForTests()).toBeDefined();

    await mod.stopBackgroundTimers();
    expect(previewWatcherStopMock).toHaveBeenCalledTimes(1);
    expect(mod._getPreviewPortWatcherForTests()).toBeUndefined();

    await mod.startBackgroundTimers();
    expect(mod._getPreviewPortWatcherForTests()).toBeDefined();
    mod._resetForTests();
    expect(previewWatcherStopMock).toHaveBeenCalledTimes(2);
    expect(mod._getPreviewPortWatcherForTests()).toBeUndefined();
  });

  // Audit gap #1: the enumeration SOURCE is picked by capability mode —
  // `caps.mode === "uid" ? new ProcPortSource() : new NetnsPortSource()`.
  // The default stub pins mode "static", so only the NetnsPortSource arm was
  // ever exercised. These two variants drive BOTH arms and assert (a) the
  // right source class was constructed and (b) the selection log names it —
  // while keeping the load-bearing intervalCalls length at 4 (the watcher
  // registers NO setInterval; prior daemon-wiring incident).
  test("capability mode 'uid' selects ProcPortSource (not Netns)", async () => {
    previewCapabilitiesMock = mock(() => ({
      static: true,
      dynamic: true,
      mode: "uid" as "static" | "uid" | "netns",
      reason: "portable uid mode",
    }));
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    // ProcPortSource was constructed; NetnsPortSource was NOT.
    expect(procPortSourceCtorMock).toHaveBeenCalledTimes(1);
    expect(netnsPortSourceCtorMock).not.toHaveBeenCalled();
    // The selection log names the chosen source + mode.
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "PreviewPortWatcher source selected by capability mode",
      expect.objectContaining({ mode: "uid", source: "ProcPortSource" }) as never,
    );
    // The watcher still registers no interval — count unchanged.
    expect(intervalCalls).toHaveLength(4);
  });

  test("capability mode 'static' selects NetnsPortSource (default fail-closed arm)", async () => {
    // Default stub already pins mode "static"; assert the OTHER arm so the
    // ternary's branch coverage is complete and the two cases are symmetric.
    installModuleMocks();

    const mod = await import("../startup/background-timers");
    await mod.startBackgroundTimers();

    expect(netnsPortSourceCtorMock).toHaveBeenCalledTimes(1);
    expect(procPortSourceCtorMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "PreviewPortWatcher source selected by capability mode",
      expect.objectContaining({ mode: "static", source: "NetnsPortSource" }) as never,
    );
    expect(intervalCalls).toHaveLength(4);
  });

  // Phase 3b — idle-reap wiring (audit nice-to-have F). Assert the bootstrap
  // (a) passes an onIdleReap handler to the watcher (so idle conversations get
  // reaped), (b) parses EZCORP_PREVIEW_IDLE_REAP_TICKS per the documented
  // contract (unset→30, "0"→0-disabled, "abc"→30), and (c) exposes the live
  // watcher via the production accessor getPreviewPortWatcher(). The watcher
  // adds NO setInterval, so intervalCalls stays at 4 throughout.
  describe("idle-reap config wiring", () => {
    const PRIOR = process.env.EZCORP_PREVIEW_IDLE_REAP_TICKS;
    afterEach(() => {
      if (PRIOR === undefined) delete process.env.EZCORP_PREVIEW_IDLE_REAP_TICKS;
      else process.env.EZCORP_PREVIEW_IDLE_REAP_TICKS = PRIOR;
    });

    test("wires onIdleReap + defaults idleReapTicks to 30 when the env is unset", async () => {
      delete process.env.EZCORP_PREVIEW_IDLE_REAP_TICKS;
      installModuleMocks();
      const mod = await import("../startup/background-timers");
      await mod.startBackgroundTimers();

      expect(lastPreviewWatcherConfig).toBeDefined();
      expect(lastPreviewWatcherConfig!.idleReapTicks).toBe(30);
      // onIdleReap is wired (a function, not undefined).
      expect(typeof lastPreviewWatcherConfig!.onIdleReap).toBe("function");
      expect(intervalCalls).toHaveLength(4);
    });

    test('idleReapTicks "0" disables idle reaping (parsed to 0)', async () => {
      process.env.EZCORP_PREVIEW_IDLE_REAP_TICKS = "0";
      installModuleMocks();
      const mod = await import("../startup/background-timers");
      await mod.startBackgroundTimers();
      expect(lastPreviewWatcherConfig!.idleReapTicks).toBe(0);
      expect(intervalCalls).toHaveLength(4);
    });

    test('a non-numeric idleReapTicks ("abc") falls back to 30', async () => {
      process.env.EZCORP_PREVIEW_IDLE_REAP_TICKS = "abc";
      installModuleMocks();
      const mod = await import("../startup/background-timers");
      await mod.startBackgroundTimers();
      expect(lastPreviewWatcherConfig!.idleReapTicks).toBe(30);
      expect(intervalCalls).toHaveLength(4);
    });

    test("getPreviewPortWatcher() exposes the live watcher (production accessor)", async () => {
      installModuleMocks();
      const mod = await import("../startup/background-timers");
      await mod.startBackgroundTimers();
      // The production accessor returns the SAME instance the test-only handle
      // does, and the same one the ctor recorded.
      const live = mod.getPreviewPortWatcher();
      expect(live).toBeDefined();
      expect(live).toBe(mod._getPreviewPortWatcherForTests() as never);
      expect(live).toBe(lastPreviewWatcherInstance as never);
    });
  });
});

// CA-1: Phase 50 retention-sweep wiring — the timer reads the four
// `global:sdk*RetentionDays` settings each tick, clamps each value to
// [1, 3650] (CR-3), and calls cleanupOldSdkCapabilityCalls with the
// clamped per-capability config. No `force` flag is set — production
// MUST NOT opt into the implicit-on-zero purge.
describe("startBackgroundTimers — Phase 50 sdk-capability retention sweep", () => {
  test("hourly tick reads settings and calls cleanupOldSdkCapabilityCalls with defaults", async () => {
    // No setting → use the documented defaults 90/30/30/90.
    getSettingMock = mock((_key: string) => Promise.resolve<unknown>(undefined));
    installModuleMocks();

    const { startBackgroundTimers } = await import("../startup/background-timers");
    await startBackgroundTimers();

    // Sweep is the third interval registered (after sessions + errors).
    const sweepCall = intervalCalls[2]!;
    const hourMs = 60 * 60 * 1000;
    expect(sweepCall.delay).toBe(hourMs);

    // Fast-forward: invoke the tick callback directly, then await any
    // microtasks the inner async IIFE schedules.
    sweepCall.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cleanupOldSdkCapabilityCallsMock).toHaveBeenCalledTimes(1);
    const arg = cleanupOldSdkCapabilityCallsMock.mock.calls[0]![0]!;
    expect(arg.llmDays).toBe(90);
    expect(arg.memoryDays).toBe(30);
    expect(arg.lessonsDays).toBe(30);
    expect(arg.scheduleDays).toBe(90);
    // CR-3: production MUST NOT pass `force: true`.
    expect(arg.force).toBeUndefined();
  });

  test("hourly tick clamps a stray 0 setting to 1 (CR-3 — no implicit purge)", async () => {
    // Admin sets memory retention to 0 — the clamp at the read site
    // must floor it to 1 BEFORE the cleanup function sees it.
    getSettingMock = mock((key: string) => {
      if (key === "global:sdkMemoryRetentionDays") return Promise.resolve<unknown>(0);
      return Promise.resolve<unknown>(undefined);
    });
    installModuleMocks();

    const { startBackgroundTimers } = await import("../startup/background-timers");
    await startBackgroundTimers();

    intervalCalls[2]!.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cleanupOldSdkCapabilityCallsMock).toHaveBeenCalledTimes(1);
    const arg = cleanupOldSdkCapabilityCallsMock.mock.calls[0]![0]!;
    expect(arg.memoryDays).toBe(1); // clamped, NOT 0
    expect(arg.force).toBeUndefined();
  });

  test("hourly tick clamps an oversize 99999 setting to 3650 (CR-3 ceiling)", async () => {
    getSettingMock = mock((key: string) => {
      if (key === "global:sdkLlmRetentionDays") return Promise.resolve<unknown>(99999);
      return Promise.resolve<unknown>(undefined);
    });
    installModuleMocks();

    const { startBackgroundTimers } = await import("../startup/background-timers");
    await startBackgroundTimers();

    intervalCalls[2]!.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const arg = cleanupOldSdkCapabilityCallsMock.mock.calls[0]![0]!;
    expect(arg.llmDays).toBe(3650);
  });

  test("cleanup throw in tick is logged but does not crash the timer", async () => {
    cleanupOldSdkCapabilityCallsMock = mock(() => Promise.reject(new Error("db down")));
    installModuleMocks();

    const { startBackgroundTimers } = await import("../startup/background-timers");
    await startBackgroundTimers();

    intervalCalls[2]!.fn();
    // Two microtask flushes: one for the inner async IIFE, one for the
    // .catch() handler that follows.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loggerWarnMock).toHaveBeenCalledWith(
      "sdk-capability-calls cleanup failed",
      { error: String(new Error("db down")) },
    );
  });
});
