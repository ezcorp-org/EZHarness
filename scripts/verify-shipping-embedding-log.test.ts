import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEmbeddingLogHealthy, findEmbeddingLogFailures } from "./lib/shipping-embedding-log-guard";

const repo = join(import.meta.dir, "..");
const shell = Bun.which("bash")!;
const setsid = Bun.which("setsid")!;

async function wrapperWith(log: string | undefined, options: { directoryInsteadOfLog?: boolean; runtimeExit?: number; receiptFileDirectory?: boolean } = {}): Promise<{ exitCode: number; receipt: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "embedding-log-guard-"));
  try {
    const receipt = join(root, "receipt");
    const bin = join(root, "bin");
    await mkdir(receipt);
    await mkdir(bin);
    const fixture = join(root, "compose.log");
    if (log !== undefined) await writeFile(fixture, log);
    await writeFile(join(bin, "bash"), [
      "#!/bin/sh",
      'if [ "${1:-}" = scripts/verify-shipping-runtime.sh ]; then',
      '  if [ "${EMBEDDING_LOG_FIXTURE_DIRECTORY:-}" = 1 ]; then mkdir "$EZ_PRODUCTION_RECEIPT_DIR/compose.log"; fi',
      '  if [ "${EMBEDDING_LOG_RECEIPT_DIRECTORY:-}" = 1 ]; then mkdir "$EZ_PRODUCTION_RECEIPT_DIR/embedding-log-guard.exit"; fi',
      '  if [ -n "${EMBEDDING_LOG_FIXTURE:-}" ]; then cp "$EMBEDDING_LOG_FIXTURE" "$EZ_PRODUCTION_RECEIPT_DIR/compose.log"; fi',
      '  exit "${EMBEDDING_LOG_RUNTIME_EXIT:-0}"',
      "fi",
      'exec "$EMBEDDING_LOG_GUARD_REAL_BASH" "$@"',
      "",
    ].join("\n"));
    await chmod(join(bin, "bash"), 0o700);
    const child = Bun.spawn([setsid, shell, "scripts/verify-shipping-embeddings.sh"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        EMBEDDING_LOG_GUARD_REAL_BASH: shell,
        EMBEDDING_LOG_FIXTURE: log === undefined ? "" : fixture,
        EMBEDDING_LOG_FIXTURE_DIRECTORY: options.directoryInsteadOfLog ? "1" : "",
        EMBEDDING_LOG_RECEIPT_DIRECTORY: options.receiptFileDirectory ? "1" : "",
        EMBEDDING_LOG_RUNTIME_EXIT: String(options.runtimeExit ?? 0),
        EZ_PRODUCTION_IMAGE: "fixture",
        EZ_PRODUCTION_RECEIPT_DIR: receipt,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    let timedOut = false;
    let groupKillFailed = false;
    const killGroup = () => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { groupKillFailed = true; }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, 5_000);
    try {
      const [exitCode] = await Promise.all([child.exited, stdout, stderr]);
      if (timedOut) throw new Error("embedding wrapper fixture exceeded 5 seconds");
      if (groupKillFailed) throw new Error("embedding wrapper fixture could not kill its owned process group");
      return { exitCode, receipt, root };
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) killGroup();
      await child.exited;
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("recognizes structured error/fatal levels and narrow native failures without treating expected warnings as failures", () => {
  const expected = [
    'app | {"level":"warn","msg":"embed-worker: embedding not ready — entering degraded mode"}',
    'app | {"level":40,"msg":"model initializing"}',
  ].join("\n");
  expect(findEmbeddingLogFailures(expected)).toEqual([]);
  expect(() => assertEmbeddingLogHealthy(expected)).not.toThrow();
  expect(findEmbeddingLogFailures('app | {"level":"ERROR","subsystem":"embed-worker","msg":"private"}\napp | {"level":50}\napp | {"level":60}')).toEqual([
    { line: 1, kind: "json-error" },
    { line: 2, kind: "json-error" },
    { line: 3, kind: "json-fatal" },
  ]);
  expect(findEmbeddingLogFailures("app | Unable to add response to browser cache: Error: EACCES: permission denied\napp | EACCES: permission denied\napp | Fatal: terminated")).toEqual([
    { line: 1, kind: "native-cache" },
    { line: 2, kind: "native-error" },
    { line: 3, kind: "native-error" },
  ]);
  expect(findEmbeddingLogFailures("app | this error word is harmless context")).toEqual([]);
  expect(findEmbeddingLogFailures('{"level":"error","msg":"message with | delimiter"}')).toEqual([{ line: 1, kind: "json-error" }]);
  expect(findEmbeddingLogFailures("app | {not-json")).toEqual([{ line: 1, kind: "invalid-json" }]);
  expect(() => assertEmbeddingLogHealthy("app | EACCES: denied")).toThrow("native-error@1");
  expect(() => assertEmbeddingLogHealthy(" \n")).toThrow("embedding compose log is empty");
});

test("embedding wrapper turns an otherwise-successful cache failure log red and accepts expected warmup warnings", async () => {
  const bad = await wrapperWith("app | Unable to add response to browser cache: Error: EACCES: permission denied\n");
  const healthy = await wrapperWith('app | {"level":"warn","msg":"embed-worker: embedding not ready — entering degraded mode"}\napp | {"level":"info","msg":"embedding ready"}\n');
  try {
    expect(bad.exitCode).toBe(1);
    expect(await Bun.file(join(bad.receipt, "embedding-log-guard.exit")).text()).toBe("runtime_exit=0\nembedding_log_guard_exit=1\n");
    expect(healthy.exitCode).toBe(0);
    expect(await Bun.file(join(healthy.receipt, "embedding-log-guard.exit")).text()).toBe("runtime_exit=0\nembedding_log_guard_exit=0\n");
  } finally {
    await Promise.all([rm(bad.root, { recursive: true, force: true }), rm(healthy.root, { recursive: true, force: true })]);
  }
}, 10_000);

test("embedding wrapper fails closed when lifecycle cleanup retains no readable nonempty compose log", async () => {
  const missing = await wrapperWith(undefined);
  const blank = await wrapperWith(" \n");
  const directory = await wrapperWith(undefined, { directoryInsteadOfLog: true });
  try {
    for (const result of [missing, blank, directory]) {
      expect(result.exitCode).toBe(1);
      expect(await Bun.file(join(result.receipt, "embedding-log-guard.exit")).text()).toBe("runtime_exit=0\nembedding_log_guard_exit=1\n");
    }
  } finally {
    await Promise.all([missing, blank, directory].map(({ root }) => rm(root, { recursive: true, force: true })));
  }
}, 10_000);

test("embedding wrapper keeps a lifecycle failure as the terminal status even when the log guard also fails", async () => {
  const result = await wrapperWith("app | Unable to add response to browser cache: Error: EACCES: permission denied\n", { runtimeExit: 42 });
  try {
    expect(result.exitCode).toBe(42);
    expect(await Bun.file(join(result.receipt, "embedding-log-guard.exit")).text()).toBe("runtime_exit=42\nembedding_log_guard_exit=1\n");
  } finally {
    await rm(result.root, { recursive: true, force: true });
  }
}, 10_000);

test("embedding wrapper fails if it cannot write the guard receipt", async () => {
  const result = await wrapperWith('app | {"level":"info","msg":"embedding ready"}\n', { receiptFileDirectory: true });
  try {
    expect(result.exitCode).toBe(1);
  } finally {
    await rm(result.root, { recursive: true, force: true });
  }
}, 10_000);
