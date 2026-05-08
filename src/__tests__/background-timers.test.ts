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
  // Cap-expiry Phase 3: stub the HostMaintenanceDaemon for the same
  // reason — that daemon's lifecycle / sweep coverage lives in
  // src/__tests__/host-maintenance-daemon.test.ts, and standing it up
  // here would require a real DB. The stub returns `true` from start()
  // so the boot block's "started" log fires (mirrors the schedule-
  // daemon stub above).
  mock.module("../extensions/host-maintenance-daemon", () => ({
    HostMaintenanceDaemon: class {
      start() { return Promise.resolve(true); }
      stop() {}
    },
  }));
  mock.module("../logger", () => ({ logger: loggerSpy }));
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
