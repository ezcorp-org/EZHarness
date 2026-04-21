import { test, expect, describe, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Shared test state ─────────────────────────────────────────────

let intervalCalls: Array<{ fn: (...args: unknown[]) => void; delay: number }> = [];
let originalSetInterval: typeof setInterval;
let warnLogs: unknown[][] = [];
let errorLogs: unknown[][] = [];
let infoLogs: unknown[][] = [];
let originalWarn: typeof console.warn;
let originalError: typeof console.error;
let originalLog: typeof console.log;

// Mock-function handles we re-wire per test
let startDecayTimerMock = mock(() => () => {});
let runCompactionMock = mock(() => Promise.resolve());
let deleteExpiredSessionsMock = mock(() => Promise.resolve());
let cleanupOldErrorsMock = mock((_retainDays: number) => Promise.resolve());
let getSettingMock = mock((_key: string) => Promise.resolve<unknown>(undefined));

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
  mock.module("../db/queries/settings", () => ({
    getSetting: (key: string) => getSettingMock(key),
  }));
}

beforeEach(async () => {
  // Reset mock handles so each test starts clean
  startDecayTimerMock = mock(() => () => {});
  runCompactionMock = mock(() => Promise.resolve());
  deleteExpiredSessionsMock = mock(() => Promise.resolve());
  cleanupOldErrorsMock = mock((_retainDays: number) => Promise.resolve());
  getSettingMock = mock((_key: string) => Promise.resolve<unknown>(undefined));

  installModuleMocks();

  // Capture setInterval registrations without actually scheduling work.
  intervalCalls = [];
  originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: (...args: unknown[]) => void, delay: number) => {
    intervalCalls.push({ fn, delay });
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  // Capture console output
  warnLogs = [];
  errorLogs = [];
  infoLogs = [];
  originalWarn = console.warn;
  originalError = console.error;
  originalLog = console.log;
  console.warn = (...args: unknown[]) => { warnLogs.push(args); };
  console.error = (...args: unknown[]) => { errorLogs.push(args); };
  console.log = (...args: unknown[]) => { infoLogs.push(args); };

  // Reset the singleton flag — background-timers.ts is loaded once per process
  // and its internal `started` flag would persist across tests otherwise.
  const mod = await import("../startup/background-timers");
  mod._resetForTests();
});

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  console.warn = originalWarn;
  console.error = originalError;
  console.log = originalLog;
});

// ── Tests ────────────────────────────────────────────────────────

describe("startBackgroundTimers", () => {
  test("first call schedules decay + 2 cleanup intervals + compaction interval", async () => {
    getSettingMock = mock((_key: string) => Promise.resolve<unknown>(undefined));
    installModuleMocks();

    const { startBackgroundTimers } = await import("../startup/background-timers");
    await startBackgroundTimers();

    // Decay timer is started directly (uses its own setInterval internally,
    // which we stubbed — it would return 0 but the mock still counts the call)
    expect(startDecayTimerMock).toHaveBeenCalledTimes(1);

    // Three setIntervals are registered directly: sessions, error-logs, compaction
    expect(intervalCalls).toHaveLength(3);
    const hourMs = 60 * 60 * 1000;
    expect(intervalCalls[0]!.delay).toBe(hourMs);          // sessions hourly
    expect(intervalCalls[1]!.delay).toBe(hourMs);          // error-logs hourly
    expect(intervalCalls[2]!.delay).toBe(6 * hourMs);      // compaction 6h default

    // Success logs fired
    const flatLogs = infoLogs.flat().join(" ");
    expect(flatLogs).toContain("Decay sweep started");
    expect(flatLogs).toContain("Compaction started (6h interval)");
  });

  test("second call is a no-op (idempotent)", async () => {
    installModuleMocks();

    const { startBackgroundTimers } = await import("../startup/background-timers");
    await startBackgroundTimers();
    await startBackgroundTimers();
    await startBackgroundTimers();

    // All three calls combined should still equal the first-call results
    expect(startDecayTimerMock).toHaveBeenCalledTimes(1);
    expect(intervalCalls).toHaveLength(3);
  });

  test("decay timer failure is logged but compaction still starts", async () => {
    startDecayTimerMock = mock(() => { throw new Error("boom"); });
    installModuleMocks();

    const { startBackgroundTimers } = await import("../startup/background-timers");
    await startBackgroundTimers();

    // Warn was logged for decay
    const warns = warnLogs.flat().map(String).join(" ");
    expect(warns).toContain("Failed to start decay timer");

    // Compaction block still ran — 3 setIntervals (sessions, errors, compaction)
    expect(intervalCalls).toHaveLength(3);
    const infos = infoLogs.flat().map(String).join(" ");
    expect(infos).toContain("Compaction started");
  });

  test("getSetting failure leaves decay + cleanups running, logs compaction warning", async () => {
    getSettingMock = mock((_key: string) => Promise.reject(new Error("db down")));
    installModuleMocks();

    const { startBackgroundTimers } = await import("../startup/background-timers");
    await startBackgroundTimers();

    // Decay did start
    expect(startDecayTimerMock).toHaveBeenCalledTimes(1);

    // Two cleanup intervals were registered before the compaction block threw;
    // no compaction interval was added
    expect(intervalCalls).toHaveLength(2);

    const warns = warnLogs.flat().map(String).join(" ");
    expect(warns).toContain("Failed to start compaction timer");
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
    const compactionCall = intervalCalls[2]!;
    expect(compactionCall.delay).toBe(2 * hourMs);

    const infos = infoLogs.flat().map(String).join(" ");
    expect(infos).toContain("Compaction started (2h interval)");
  });
});
