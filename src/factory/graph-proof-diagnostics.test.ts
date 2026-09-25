import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PASS_PROCESSES,
  PASS_READINESS_FILES,
  checkPassDiagnostics,
  collectSecretValues,
  openProcessLog,
  preserveStackDiagnostics,
  processLogPath,
  redactStreamedLogs,
  stackCopyDir,
} from "../../scripts/factory-graph-proof/diagnostics";

/**
 * What a graph-proof pass leaves behind, proved on real files.
 *
 * The W19a merge batch lost a failed pass's diagnostics because process output
 * lived only in memory and the stack directory was deleted. These cases pin the
 * replacement: output streams to disk with a header and an exit line, a failed
 * pass carries its readiness files out, and nothing that leaves carries a
 * secret the stack holds.
 */

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))); });

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "w19b-diagnostics-"));
  directories.push(path);
  return path;
}

const clock = () => new Date("2026-09-25T10:00:00.000Z");

describe("a process's streamed log", () => {
  test("carries a header, every byte the process wrote, and an exit line, even when the process printed nothing", async () => {
    const dir = await scratch();
    const diagnostics = { dir, label: "pass-1" };
    const speaking = openProcessLog(diagnostics, "web", "bun", ["build/index.js"], 4242, clock);
    speaking.write("listening\n");
    speaking.write(Buffer.from("ready\n"));
    await speaking.close({ code: 0, signal: null });
    expect(await readFile(processLogPath(diagnostics, "web"), "utf8")).toBe(
      "[w19-harness] web started 2026-09-25T10:00:00.000Z pid 4242: bun build/index.js\nlistening\nready\n[w19-harness] web exited 2026-09-25T10:00:00.000Z code 0 signal none\n",
    );
    const silent = openProcessLog(diagnostics, "pool", "bun", ["pool.ts"], undefined, clock);
    await silent.close({ code: null, signal: "SIGKILL" });
    expect(await readFile(silent.path, "utf8")).toBe("[w19-harness] pool started 2026-09-25T10:00:00.000Z pid unknown: bun pool.ts\n[w19-harness] pool exited 2026-09-25T10:00:00.000Z code none signal SIGKILL\n");
  });

  test("stamps the real time when no clock is given", async () => {
    const log = openProcessLog({ dir: await scratch(), label: "pass-clock" }, "orchestrator", "bash", ["runner.sh"], 9);
    await log.close({ code: 0, signal: null });
    expect(await readFile(log.path, "utf8")).toMatch(/^\[w19-harness\] orchestrator started \d{4}-\d\d-\d\dT[^ ]+Z pid 9: bash runner\.sh\n\[w19-harness\] orchestrator exited \d{4}-\d\d-\d\dT[^ ]+Z code 0 signal none\n$/);
  });

  test("closes once: a second close and a late write change nothing", async () => {
    const dir = await scratch();
    const log = openProcessLog({ dir, label: "pass-2" }, "supervisor", "bun", [], 1, clock);
    const first = log.close({ code: 1, signal: null });
    const second = log.close({ code: null, signal: "harness-stopped" });
    expect(second).toBe(first);
    await first;
    log.write("after the exit\n");
    const text = await readFile(log.path, "utf8");
    expect(text.endsWith("[w19-harness] supervisor exited 2026-09-25T10:00:00.000Z code 1 signal none\n")).toBe(true);
    expect(text).not.toContain("after the exit");
    expect(text).not.toContain("harness-stopped");
  });
});

describe("the secrets a stack holds", () => {
  test("are each file's content, each string inside a JSON file, and each URL password, longest first", async () => {
    const secrets = await scratch();
    await writeFile(join(secrets, "tenant.token"), "eyJhbGciOiJSUzI1NiJ9.tenant-token-body.signature\n");
    await writeFile(join(secrets, "pool-database.json"), JSON.stringify({ databaseUrl: "postgres://proof:s3cret-password-value@127.0.0.1:5432/w19a_pool" }));
    await writeFile(join(secrets, "ordinary-storage.json"), JSON.stringify({ identities: [{ credentials: [{ accessKey: "ACCESSKEY0123456", secretKey: "secret-key-0123456789", note: "short" }] }] }));
    await writeFile(join(secrets, "host.kid"), "host-key-1");
    await writeFile(join(secrets, "huge.bin"), Buffer.alloc(64 * 1024 + 1, 97));
    await mkdir(join(secrets, "nested"));
    const values = await collectSecretValues(secrets, ["w19a-jwt-0123456789abcdef", "tiny"]);
    for (const value of ["eyJhbGciOiJSUzI1NiJ9.tenant-token-body.signature", "postgres://proof:s3cret-password-value@127.0.0.1:5432/w19a_pool", "s3cret-password-value", "ACCESSKEY0123456", "secret-key-0123456789", "w19a-jwt-0123456789abcdef"]) {
      expect(values).toContain(value);
    }
    // Too short to be a credential, a file too large to be one, and a directory: none is a value.
    for (const value of ["host-key-1", "tiny", "short"]) expect(values).not.toContain(value);
    expect(values.some((value) => value.startsWith("aaaa"))).toBe(false);
    expect([...values].sort((left, right) => right.length - left.length)).toEqual(values);
  });

  test("with no secrets directory, are the extra values alone", async () => {
    expect(await collectSecretValues(join(await scratch(), "absent"), ["only-in-the-environment-1"])).toEqual(["only-in-the-environment-1"]);
  });

  test("are redacted from a streamed log wherever they appear, and each redaction is counted", async () => {
    const dir = await scratch();
    const leaky = join(dir, "leaky.log");
    const clean = join(dir, "clean.log");
    await writeFile(leaky, "token eyJhbGciOiJSUzI1NiJ9.body.sig and the password s3cret-password-value twice: s3cret-password-value\n");
    await writeFile(clean, "nothing to hide\n");
    const counts = await redactStreamedLogs([leaky, clean, join(dir, "gone.log")], ["eyJhbGciOiJSUzI1NiJ9.body.sig", "s3cret-password-value"]);
    expect(counts).toEqual({ [leaky]: 3 });
    expect(await readFile(leaky, "utf8")).toBe("token [redacted] and the password [redacted] twice: [redacted]\n");
    expect(await readFile(clean, "utf8")).toBe("nothing to hide\n");
  });
});

describe("a failed pass's stack", () => {
  async function stack() {
    const root = await scratch();
    for (const directory of ["secrets", "readiness", "runner/store", "runner/locked"]) await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, "secrets", "tenant.token"), "the-tenant-token-value");
    await writeFile(join(root, "secrets", "extra.log"), "a log inside secrets never leaves");
    await writeFile(join(root, "readiness", "pool.json"), JSON.stringify({ lifecycle: "degraded", errorCode: "pool_database_unavailable" }));
    await writeFile(join(root, "readiness", "supervisor.json"), JSON.stringify({ lifecycle: "ready" }));
    await writeFile(join(root, "readiness", "orchestration.json"), JSON.stringify({ lifecycle: "ready", note: "the-tenant-token-value" }));
    await writeFile(join(root, "runner", "store", "build.log"), "built\n");
    await writeFile(join(root, "runner", "store", "huge.log"), Buffer.alloc(5 * 1024 * 1024 + 1, 98));
    await writeFile(join(root, "temporal.sqlite"), "not a diagnostic");
    return root;
  }

  test("carries its readiness files and logs out, refuses a file that holds a secret, and never touches secrets/", async () => {
    const root = await stack();
    await chmod(join(root, "runner", "locked"), 0o000);
    const out = await scratch();
    const diagnostics = { dir: out, label: "failed-pass" };
    try {
      const preserved = await preserveStackDiagnostics(root, diagnostics, ["the-tenant-token-value"]);
      expect([...preserved.copied].sort()).toEqual(["readiness/pool.json", "readiness/supervisor.json", "runner/store/build.log"]);
      expect(preserved.refused).toEqual(["readiness/orchestration.json"]);
      expect(preserved.oversize).toEqual({ "runner/store/huge.log": 5 * 1024 * 1024 + 1 });
      expect(preserved.unreadable).toEqual(["runner/locked"]);
      expect(JSON.parse(await readFile(join(stackCopyDir(diagnostics), "readiness", "pool.json"), "utf8"))).toEqual({ lifecycle: "degraded", errorCode: "pool_database_unavailable" });
      await expect(readFile(join(stackCopyDir(diagnostics), "secrets", "extra.log"), "utf8")).rejects.toThrow();
      await expect(readFile(join(stackCopyDir(diagnostics), "temporal.sqlite"), "utf8")).rejects.toThrow();
    } finally {
      await chmod(join(root, "runner", "locked"), 0o700);
    }
  });

  test("is judged from the files alone: every process log with its exit line, every readiness file", async () => {
    const out = await scratch();
    const diagnostics = { dir: out, label: "forced" };
    const empty = await checkPassDiagnostics(diagnostics);
    expect(empty.ok).toBe(false);
    expect(empty.problems).toEqual([...PASS_PROCESSES.map((name) => `process log ${name} is missing`), ...PASS_READINESS_FILES.map((name) => `stack file ${name} is missing`)]);

    for (const name of PASS_PROCESSES) {
      const log = openProcessLog(diagnostics, name, "bun", [name], 7, clock);
      await log.close({ code: 0, signal: null });
    }
    for (const name of PASS_READINESS_FILES) {
      await mkdir(join(stackCopyDir(diagnostics), "readiness"), { recursive: true });
      await writeFile(join(stackCopyDir(diagnostics), name), "{\"lifecycle\":\"ready\"}");
    }
    const whole = await checkPassDiagnostics(diagnostics);
    expect(whole).toMatchObject({ ok: true, problems: [] });
    expect(whole.processLogs.pool).toMatchObject({ exitLine: true });

    // A log cut off before its exit line, an empty log, and an empty readiness file are each named.
    await writeFile(processLogPath(diagnostics, "pool"), "[w19-harness] pool started\n");
    await writeFile(processLogPath(diagnostics, "web"), "");
    await writeFile(join(stackCopyDir(diagnostics), "readiness/supervisor.json"), "");
    expect((await checkPassDiagnostics(diagnostics)).problems).toEqual(["process log pool has no exit line", "process log web is empty", "stack file readiness/supervisor.json is empty"]);
  });
});
