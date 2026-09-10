/**
 * Regression test for the 2026-05-10 stale-postmaster.pid data-loss
 * incident. Two production `docker compose up -d --force-recreate` runs
 * SIGKILL'd the Bun process before PGlite flushed and closed; the next
 * boot's `openPglite()` aborted on the stale `postmaster.pid` and the
 * corruption-catch in `src/db/connection.ts` renamed the dir aside,
 * destroying user data. Two layered fixes:
 *
 *   1. `e304cf8` — clear stale `postmaster.pid` / `postmaster.opts`
 *      BEFORE `openPglite()` so the catch-all never trips on a lock-only
 *      failure (the SIGKILL/crash safety-net).
 *   2. This commit — install a graceful SIGTERM handler that closes
 *      PGlite cleanly so the lock is never written in the first place.
 *
 * The tests below drive a real Bun subprocess against a temp PGlite dir
 * for both paths:
 *
 *   • **Path A (SIGTERM, clean):** subprocess opens PGlite, writes a row,
 *     registers our shutdown handler, signals readiness, waits. The
 *     parent SIGTERMs it. Expected: exit 0, no `.corrupted` sibling,
 *     row reads back on re-open.
 *
 *   • **Path B (SIGKILL, dirty):** same setup but SIGKILL — no handler
 *     runs. Expected: a `postmaster.pid` is left behind, but on re-open
 *     the e304cf8 safety-net removes it (logs "Removed stale PGlite
 *     lock file"), there's no `.corrupted` sibling, and the row reads
 *     back.
 *
 * We pass the child script as a `--eval` string to `bun` so the test is
 * self-contained — no fixture file to drift out of sync. The child uses
 * the same `shutdown.ts` API the production handler uses, exercising
 * the real teardown chain (registerTeardown → install → signal →
 * pglite.close).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, existsSync, readdirSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..", "..");

// Each test gets a fresh tempdir under /tmp/ezcorp-shutdown-test-<rand>
// so concurrent test invocations (Bun's default) can't trample each
// other's PGlite directories. Cleaned up in afterAll.
const TEST_ROOT = join(tmpdir(), `ezcorp-shutdown-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const SEED_PATH = join(TEST_ROOT, "seed");

beforeAll(async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  // Both signal paths start from a real, closed database, as an existing
  // installation does. Build its empty catalog once, outside either signal
  // handshake; each child still creates its table and writes its own row.
  const { PGlite } = await import("@electric-sql/pglite");
  const seed = new PGlite(SEED_PATH);
  try { await seed.waitReady; } finally { await seed.close(); }
}, 30_000);

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

/**
 * The child script. Opens PGlite at `EZCORP_DB_PATH`, creates a tiny
 * test table, writes a row, registers a `pglite-close` teardown via
 * our shutdown orchestrator, installs signal handlers, signals "READY"
 * on stdout, then idles.
 *
 * The `installShutdownHandlers()` call wires the real LIFO teardown
 * chain — exactly what production does in `web/src/lib/server/context.ts`.
 * On SIGTERM the parent observes a clean exit (code 0); on SIGKILL the
 * handler doesn't run and we test the e304cf8 safety-net on the next
 * open.
 *
 * Path resolution: `import.meta.dir` inside `--eval` is `process.cwd()`,
 * which we set explicitly via `Bun.spawn({ cwd })` to the worktree
 * root. So `web/src/lib/server/shutdown.ts` resolves regardless of
 * where the test is run from.
 */
const CHILD_SCRIPT = `
  import { PGlite } from "@electric-sql/pglite";
  import { installShutdownHandlers, registerTeardown } from "./web/src/lib/server/shutdown.ts";

  const path = process.env.EZCORP_DB_PATH;
  if (!path) {
    console.error("EZCORP_DB_PATH required");
    process.exit(2);
  }

  const pg = new PGlite(path);
  await pg.waitReady;
  await pg.exec(\`CREATE TABLE IF NOT EXISTS test_kv (k text primary key, v text)\`);
  await pg.exec(\`INSERT INTO test_kv VALUES ('k', 'v') ON CONFLICT (k) DO NOTHING\`);

  // Register PGlite close BEFORE installing handlers — same order as
  // production (context.ts registers closeDb immediately after initDb).
  registerTeardown("pglite-close", async () => {
    await pg.close();
  });
  installShutdownHandlers();

  // Tell the parent we're armed. The parent waits for "READY\\n" on
  // stdout before sending the signal so we don't race the handler
  // registration.
  console.log("READY");

  // Idle. The signal handler will exit cleanly; otherwise the parent
  // times out after 10s and fails the test.
  await new Promise(() => {});
`;

async function waitChildPhase<T>(work: Promise<T>, phase: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`child ${phase} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Drain both pipes from spawn and reap the owned child on every path.
 * Readiness and post-signal exit have separate, bounded waits. */
async function runChild(
  script: string,
  dbPath: string,
  signal?: "SIGTERM" | "SIGKILL",
  timeoutMs = 10_000,
): Promise<{ exitCode: number | null; signalCode: string | null; stderr: string; stdout: string }> {
  const proc = Bun.spawn([process.execPath, "--eval", script], {
    cwd: ROOT,
    env: { ...process.env, EZCORP_DB_PATH: dbPath },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const ready = Promise.withResolvers<void>();
  let stdout = "";
  let stderr = "";
  const stdoutDone = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value, { stream: true });
        if (/(?:^|\n)READY\r?\n/.test(stdout)) ready.resolve();
      }
      stdout += decoder.decode();
    } finally { reader.releaseLock(); }
  })();
  const stderrDone = new Response(proc.stderr).text().then(text => { stderr = text; });
  const completed = Promise.all([proc.exited, stdoutDone, stderrDone]);
  let exitCode: number | null = null;
  let failure: unknown;
  try {
    if (signal) {
      await waitChildPhase(Promise.race([
        ready.promise,
        completed.then(([code]) => { throw new Error(`child exited before READY with code ${code}`); }),
      ]), "READY", timeoutMs);
      proc.kill(signal);
    }
    [exitCode] = await waitChildPhase(completed, "exit", timeoutMs);
  } catch (error) { failure = error; }
  finally {
    proc.kill("SIGKILL");
    await proc.exited;
    await Promise.allSettled([stdoutDone, stderrDone]);
  }
  if (failure !== undefined) throw new Error(`${failure instanceof Error ? failure.message : String(failure)}; stdout=${stdout}; stderr=${stderr}`, { cause: failure });
  return { exitCode, signalCode: proc.signalCode, stderr, stdout };
}

async function spawnChild(dbPath: string, signal: "SIGTERM" | "SIGKILL") {
  cpSync(SEED_PATH, dbPath, { recursive: true });
  return runChild(CHILD_SCRIPT, dbPath, signal);
}

describe("PGlite graceful shutdown (incident 2026-05-10 regression)", () => {
  test("Path A: SIGTERM closes PGlite cleanly — row survives, exit 0", async () => {
    const dbPath = join(TEST_ROOT, "path-a");
    const result = await spawnChild(dbPath, "SIGTERM");

    // The handler caught SIGTERM and ran teardowns to completion. Exit
    // 0 here is load-bearing: it proves our shutdown orchestrator
    // reached the post-teardown `process.exit(0)`, which can only
    // happen after `pglite-close` ran. Pre-2026-05-10, the
    // `process.exit(0)` was synchronous and skipped PGlite close
    // entirely — exactly the data-loss path.
    expect(result.exitCode).toBe(0);
    expect(result.signalCode).toBeNull();

    // No `.corrupted.<ts>` sibling — if the next openPglite had aborted
    // (the symptom of an unclean shutdown), the connection.ts
    // catch-all would have renamed the dir aside. We verify by both
    // listing the parent tempdir for siblings AND re-opening the dir
    // below.
    //
    // NB we deliberately do NOT assert `postmaster.pid` absence:
    // PGlite (as of v0.3.x with the vector extension) leaves the file
    // on disk even after a clean `close()`. The 2026-05-10 incident
    // was triggered by the file PLUS additional unflushed state from
    // an unclean shutdown — not the file alone. The load-bearing
    // assertion is that data survives + the dir is openable below.
    const siblings = readdirSync(TEST_ROOT).filter((n) => n.startsWith("path-a"));
    expect(siblings).toEqual(["path-a"]);

    // Re-open in this process and verify the row survives the
    // shutdown roundtrip. If WAL hadn't flushed, the INSERT would be
    // lost.
    const { PGlite } = await import("@electric-sql/pglite");
    const pg2 = new PGlite(dbPath);
    await pg2.waitReady;
    const rows = await pg2.query<{ k: string; v: string }>("SELECT k, v FROM test_kv WHERE k = $1", ["k"]);
    await pg2.close();
    expect(rows.rows).toEqual([{ k: "k", v: "v" }]);
  }, 30_000);

  test("Path B: SIGKILL leaves stale lock — but the e304cf8 safety-net cleans it on re-open", async () => {
    const dbPath = join(TEST_ROOT, "path-b");
    const result = await spawnChild(dbPath, "SIGKILL");

    // SIGKILL is uncatchable — the child exits via signal, not via our
    // handler. Bun reports either exitCode 137 (128 + 9) or signalCode
    // "SIGKILL"; behaviour varies slightly by platform/version, so we
    // accept either as "killed by SIGKILL".
    const killedBySignal = result.signalCode === "SIGKILL" || result.exitCode === 137 || result.exitCode === null;
    expect(killedBySignal).toBe(true);

    // Sanity: the stale lock IS present (SIGKILL didn't let us close).
    // This is the precondition the safety-net handles.
    expect(existsSync(join(dbPath, "postmaster.pid"))).toBe(true);

    // Drive the real production cleanup path: import the connection
    // module's initDb against this dir and let it run end-to-end. The
    // e304cf8 cleanup MUST remove postmaster.pid before openPglite,
    // and the corruption catch-all MUST NOT trigger.
    //
    // We exercise this by spawning a fresh child that uses the project
    // db/connection.ts (not raw PGlite), then asserting:
    //   • exit 0 (the boot completed, no .failed/.corrupted rename)
    //   • our log emits "Removed stale PGlite lock file"
    //   • the row from the prior run is still readable
    const probeScript = [
      'process.env.EZCORP_NO_EXIT = "1";',
      'const { initDb, getPglite, closeDb } = await import("./src/db/connection.ts");',
      'await initDb();',
      'const pg = getPglite();',
      'const rows = await pg.query("SELECT k, v FROM test_kv WHERE k = $1", ["k"]);',
      'console.log("ROW:" + JSON.stringify(rows.rows));',
      'await closeDb();',
      'console.log("PROBE_DONE");',
    ].join("\n");
    const { exitCode: probeExit, stdout: probeStdout } = await runChild(probeScript, dbPath, undefined, 30_000);

    expect(probeExit).toBe(0);

    // The safety-net log line is the load-bearing assertion — it
    // proves the cleanup path ran rather than the corruption-catch
    // branch. `logger.info` goes to stdout (see src/logger.ts:37);
    // `logger.warn`/`logger.error` go to stderr. The cleanup is
    // logged at info level on the happy path, so we look in stdout.
    expect(probeStdout).toContain("Removed stale PGlite lock file");

    // The row from the SIGKILL'd subprocess must still be readable. If
    // the corruption catch-all had fired, the DB dir would have been
    // renamed to `.corrupted.<ts>` and replaced with an empty one — so
    // either the row would be missing OR a sibling directory would
    // exist.
    expect(probeStdout).toContain('ROW:[{"k":"k","v":"v"}]');
    expect(probeStdout).toContain("PROBE_DONE");

    const siblings = readdirSync(TEST_ROOT).filter(
      (n) => n.startsWith("path-b") && n !== "path-b",
    );
    expect(siblings).toEqual([]);
  }, 60_000);
});


describe("shutdown subprocess ownership", () => {
  test.each(["READY", "exit"] as const)("reaps a child that exceeds its %s deadline", async phase => {
    const pidFile = join(TEST_ROOT, `${phase}.pid`);
    const script = `
      await Bun.write(process.env.EZCORP_DB_PATH, String(process.pid));
      process.on("SIGTERM", () => {});
      ${phase === "exit" ? 'console.log("READY");' : ""}
      setInterval(() => {}, 1_000);
    `;
    await expect(runChild(script, pidFile, "SIGTERM", 1_000)).rejects.toThrow(`child ${phase} timed out`);
    const pid = Number(await Bun.file(pidFile).text());
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);

  test("reports an early child exit with its stderr", async () => {
    await expect(runChild('console.error("boot failed"); process.exit(23);', join(TEST_ROOT, "early-exit"), "SIGTERM"))
      .rejects.toThrow(/child exited before READY with code 23.*stderr=boot failed/s);
  });

  test("drains stderr before readiness so a full pipe cannot block shutdown", async () => {
    const size = 1024 * 1024;
    const result = await runChild(`
      await Bun.write(Bun.stderr, "x".repeat(${size}));
      process.on("SIGTERM", () => process.exit(0));
      console.log("READY");
      setInterval(() => {}, 1_000);
    `, join(TEST_ROOT, "pipe-control"), "SIGTERM");
    expect(result.exitCode).toBe(0);
    expect(result.stderr.length).toBe(size);
    expect(result.stdout).toContain("READY");
  });
});
