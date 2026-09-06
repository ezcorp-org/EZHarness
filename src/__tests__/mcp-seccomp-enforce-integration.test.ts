/**
 * End-to-end seccomp enforce integration — Phase 58 / MCP-04.
 *
 * Gated on Linux + bwrap + gcc + the compiled mcp-seccomp.bpf artifact.
 * SKIPs cleanly on macOS/NixOS dev hosts; runs in the CI matrix.
 *
 * Strategy:
 *   1. beforeAll: compile a 20-line C probe (tests/fixtures/synthetic-mcp/
 *      probe-ptrace.c) that calls ptrace(PTRACE_TRACEME, 0, 0, 0). Under
 *      Phase 55's SCMP_ACT_LOG the call would log+succeed; under Phase 58's
 *      SCMP_ACT_ERRNO it returns -1 with errno set to ENOSYS (or EPERM —
 *      tolerated by `/^0x000?5000?1$/i`).
 *   2. test body: spawn the probe through buildSandboxedMcpSpec with the
 *      seccomp BPF FD threaded into bwrap; wait for the child to exit;
 *      run the soak reader.
 *   3. Poll audit_log for `MCP_SECCOMP_VIOLATION` rows with metadata.pid
 *      matching the probe's PID and metadata.code matching the regex.
 *
 * The regex `/^0x000?5000?1$/i` tolerates leading-zero variance — the
 * kernel emits both `0x00050001` (canonical) and `0x50001` (some glibc/
 * auditd versions strip leading zeros). Either form proves
 * SECCOMP_RET_ERRNO.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { closeSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  McpServerStdio,
} from "../extensions/types";
import type { AuditEntry } from "../db/schema";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";

let probeDir: string | undefined;
let probeCPath: string;
let probeBinPath: string;
const BPF_PATH = resolve(
  import.meta.dir,
  "..",
  "extensions",
  "mcp-seccomp.bpf",
);

const PROBE_C_SOURCE = `/*
 * probe-ptrace.c — Phase 58 / MCP-04 enforce-integration probe.
 *
 * Calls one explicitly logged syscall and one syscall absent from the
 * allow-list, then prints both results for the parent to assert.
 */
#include <errno.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(void) {
    long r = syscall(SYS_getpid);
    fprintf(stderr, "probe-getpid: r=%ld errno=%d\\n", r, errno);
    errno = 0;
    long denied = syscall(SYS_io_uring_setup, 0, NULL);
    fprintf(stderr, "probe-io_uring_setup: r=%ld errno=%d\\n", denied, errno);
    return 0;
}
`;

const GATE_REASONS: string[] = [];
if (process.platform !== "linux") GATE_REASONS.push("non-linux platform");
if (!Bun.which("bwrap")) GATE_REASONS.push("bwrap missing from PATH");
if (!Bun.which("gcc")) GATE_REASONS.push("gcc missing from PATH");
if (!existsSync(BPF_PATH)) GATE_REASONS.push("mcp-seccomp.bpf artifact absent (run docker build)");

const SHOULD_SKIP = GATE_REASONS.length > 0;

beforeAll(async () => {
  if (SHOULD_SKIP) return;
  const { initDb } = await import("../db/connection");
  await initDb();
  probeDir = mkdtempSync(join(tmpdir(), "ez-seccomp-probe-"));
  probeCPath = join(probeDir, "probe-ptrace.c");
  probeBinPath = join(probeDir, "probe-ptrace");
  writeFileSync(probeCPath, PROBE_C_SOURCE, "utf8");
  const proc = Bun.spawnSync({
    cmd: ["gcc", "-O2", "-o", probeBinPath, probeCPath],
    stderr: "pipe",
    stdout: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `probe-ptrace compile failed: ${new TextDecoder().decode(proc.stderr)}`,
    );
  }
});

afterAll(() => {
  if (probeDir) rmSync(probeDir, { recursive: true, force: true });
});

test.skipIf(SHOULD_SKIP)(
  "declared getpid is logged and undeclared io_uring_setup is denied in the production spawn envelope",
  async () => {
    if (SHOULD_SKIP) {
      console.warn(
        `mcp-seccomp-enforce-integration SKIPPED: ${GATE_REASONS.join(", ")}`,
      );
      return;
    }
    // Lazy-import the SUT only on Linux to avoid pulling DB modules into
    // dev-host unit-test runs.
    const {
      _setSandboxTierOverrideForTests,
      buildSandboxedMcpSpec,
      runMcpSeccompSoakReader,
    } = await import(
      "../extensions/mcp-sandbox"
    );
    const { listAuditForExtension } = await import("../db/queries/audit-log");
    const {
      _setBwrapProbeOverridesForTests,
      _setNetnsProbeCacheForTests,
    } = await import("../extensions/mcp-netns");
    const profile = await Bun.file(
      resolve(import.meta.dir, "..", "extensions", "mcp-seccomp.json"),
    ).json() as { syscalls: Array<{ names: string[]; action: string }> };
    expect(profile.syscalls).toContainEqual({
      names: ["getpid"],
      action: "SCMP_ACT_LOG",
    });
    expect(profile.syscalls.some((entry) => entry.names.includes("io_uring_setup"))).toBe(false);

    const spawnAt = new Date();
    const stdioServer: McpServerStdio = {
      transport: "stdio",
      name: "probe-ptrace",
      command: probeBinPath,
      args: [],
    };
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "probe-ptrace",
      version: "1.0.0",
      description: "Phase 58 / MCP-04 enforce-mode integration probe",
      author: { name: "test" },
      kind: "mcp",
      tools: [],
      mcpServers: [stdioServer],
      permissions: {},
    };
    const grantedPerms: ExtensionPermissions = { grantedAt: {} };
    _setSandboxTierOverrideForTests("bwrap");
    _setNetnsProbeCacheForTests({ available: true });
    _setBwrapProbeOverridesForTests({
      whichBwrap: () => Bun.which("bwrap"),
      probeRunner: () => ({ success: true, exitCode: 0 }),
    });
    const { spec, proxyHandle } = await buildSandboxedMcpSpec(
      stdioServer,
      manifest,
      grantedPerms,
      "ext-probe-ptrace",
      {
        engine: createStubPermissionEngine("allow-all"),
        conversationId: null,
        userId: "user-seccomp-integration",
      },
    ).finally(() => {
      _setSandboxTierOverrideForTests(null);
      _setNetnsProbeCacheForTests(null);
      _setBwrapProbeOverridesForTests(null);
    });
    // McpServerDefinition is a discriminated union — narrow to stdio so
    // .command / .args / .env are visible. (buildSandboxedMcpSpec
    // preserves the inbound transport; we passed stdio in.)
    if (spec.transport !== "stdio") {
      throw new Error(
        `unexpected non-stdio spec from buildSandboxedMcpSpec: ${spec.transport}`,
      );
    }
    // We don't have an McpClient to drive — spawn the probe ourselves
    // via Bun.spawn using the spec's command/args/env.
    expect(spec.seccompFd).not.toBeNull();
    const seccompFd = spec.seccompFd!;
    const proc = Bun.spawn({
      cmd: [spec.command, ...(spec.args ?? [])],
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe", seccompFd],
    } as Parameters<typeof Bun.spawn>[0]);
    closeSync(seccompFd);
    try {
      await spec.onChildSpawned?.(proc.pid, async (byte) => {
        proc.stdin.write(Uint8Array.of(byte));
        await proc.stdin.flush();
      });
      const [exitCode, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      // getpid is explicitly logged. io_uring_setup is absent from the declared
      // list and receives the default ENOSYS action.
      expect(stderr).toMatch(/probe-getpid: r=[1-9]\d* errno=0\b/);
      expect(stderr).toMatch(/probe-io_uring_setup: r=-1 errno=38\b/);
    } finally {
      await proxyHandle?.stop();
    }
    const childPid = proc.pid;
    // Run the soak reader against the post-exit window.
    await runMcpSeccompSoakReader(childPid, spawnAt, {
      userId: null,
      extensionId: "ext-probe-ptrace",
      extensionName: "probe-ptrace",
    });
    // Poll audit_log for up to 5s.
    const deadline = Date.now() + 5000;
    let matchedRows: AuditEntry[] = [];
    while (Date.now() < deadline) {
      const rows = await listAuditForExtension("ext-probe-ptrace");
      matchedRows = rows.filter(
        (r) =>
          r.action === "ext:mcp:seccomp-violation" &&
          (r.metadata as { pid?: string } | null)?.pid === String(childPid),
      );
      if (matchedRows.length >= 2) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    const codes = matchedRows.map(
      (row) => ((row.metadata as { code?: string } | null)?.code ?? "").toLowerCase(),
    );
    expect(codes).toContain("0x7ffc0000");
    expect(codes.some((code) => /^0x0*50026$/.test(code))).toBe(true);
  },
);
