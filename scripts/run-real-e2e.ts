/**
 * Run one real-PGlite Playwright tier with an isolated, process-owned database.
 *
 * Playwright runs globalTeardown before its webServer plugin stops the preview,
 * so this outer process owns cleanup: it waits for Playwright to exit, then
 * removes only the directory it created and that directory's holder sidecar.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type RealE2eMode = "real-auth" | "fresh-setup";

type SpawnedProcess = {
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
};

type Spawn = (cmd: string[], options: { cwd: string; env: Record<string, string | undefined>; stdout: "inherit"; stderr: "inherit" }) => SpawnedProcess;

type SignalHooks = {
  on(signal: NodeJS.Signals, listener: () => void): void;
  off(signal: NodeJS.Signals, listener: () => void): void;
};

export interface RunRealE2eOptions {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  createTempDir?: () => string;
  spawn?: Spawn;
  signals?: SignalHooks;
}

const CONFIG_FOR_MODE: Record<RealE2eMode, string> = {
  "real-auth": "playwright.real.config.ts",
  "fresh-setup": "playwright.fresh-setup.config.ts",
};

function cleanupGeneratedDb(dbDir: string): void {
  // `holderPidPath()` is exactly `${dbPath}.ezcorp.pid`. Do not broaden either
  // removal: this runner may only remove paths created from its own mkdtemp.
  for (const path of [dbDir, `${dbDir}.ezcorp.pid`]) {
    try {
      rmSync(path, { recursive: path === dbDir, force: true });
    } catch (error) {
      console.warn(`real E2E cleanup could not remove ${path}: ${String(error)}`);
    }
  }
}

function childEnvironment(baseEnv: NodeJS.ProcessEnv, dbDir: string, ownsDbDir: boolean): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...baseEnv,
    PI_E2E_REAL: "1",
    PI_E2E_REAL_DB_PATH: dbDir,
  };
  if (ownsDbDir) {
    env.PI_E2E_REAL_DB_GENERATED = "1";
  } else {
    // A caller-supplied DB is never disposable, including when an outer shell
    // happened to export an old generated marker.
    delete env.PI_E2E_REAL_DB_GENERATED;
    delete env.PI_E2E_REAL_GENERATED_DB_PATH;
  }
  return env;
}

export async function runRealE2e(mode: RealE2eMode, playwrightArgs: string[], options: RunRealE2eOptions = {}): Promise<number> {
  const projectRoot = options.projectRoot ?? resolve(import.meta.dir, "..");
  const sourceEnv = options.env ?? process.env;
  const callerDbDir = sourceEnv.PI_E2E_REAL_DB_PATH;
  const ownsDbDir = callerDbDir === undefined;
  const dbDir = callerDbDir ?? (options.createTempDir ?? (() => mkdtempSync(join(tmpdir(), "ezcorp-e2e-"))))();
  const spawn = options.spawn ?? ((cmd, spawnOptions) => Bun.spawn(cmd, spawnOptions));
  const signals = options.signals ?? process;
  const child = spawn(
    [join(projectRoot, "web", "node_modules", ".bin", "playwright"), "test", "--config", CONFIG_FOR_MODE[mode], ...playwrightArgs],
    {
      cwd: join(projectRoot, "web"),
      env: childEnvironment(sourceEnv, dbDir, ownsDbDir),
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  // Playwright handles SIGINT by running its task cleanup, including the
  // webServer plugin. Translate SIGTERM to that signal, then await child exit
  // before removing a generated directory. A second signal changes nothing:
  // deleting while the child is live is worse than waiting for it.
  let forwardedSignal = false;
  const forwardInterrupt = () => {
    if (forwardedSignal) return;
    forwardedSignal = true;
    child.kill("SIGINT");
  };
  signals.on("SIGINT", forwardInterrupt);
  signals.on("SIGTERM", forwardInterrupt);

  try {
    return await child.exited;
  } finally {
    signals.off("SIGINT", forwardInterrupt);
    signals.off("SIGTERM", forwardInterrupt);
    if (ownsDbDir) cleanupGeneratedDb(dbDir);
  }
}

export function parseRealE2eCommand(args: string[]): { mode: RealE2eMode; playwrightArgs: string[] } | null {
  const [mode, ...playwrightArgs] = args;
  if (mode === "real-auth" || mode === "fresh-setup") return { mode, playwrightArgs };
  return null;
}

if (import.meta.main) {
  const command = parseRealE2eCommand(process.argv.slice(2));
  if (!command) {
    console.error("usage: bun scripts/run-real-e2e.ts <real-auth|fresh-setup> [Playwright args...]");
    process.exitCode = 2;
  } else {
    process.exitCode = await runRealE2e(command.mode, command.playwrightArgs);
  }
}
