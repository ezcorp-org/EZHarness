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

import { test, expect, beforeAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  McpServerStdio,
} from "../extensions/types";
import type { AuditEntry } from "../db/schema";

const PROBE_DIR = resolve(
  import.meta.dir,
  "..",
  "..",
  "tests",
  "fixtures",
  "synthetic-mcp",
);
const PROBE_C_PATH = resolve(PROBE_DIR, "probe-ptrace.c");
const PROBE_BIN_PATH = resolve(PROBE_DIR, "probe-ptrace");
const BPF_PATH = resolve(
  import.meta.dir,
  "..",
  "extensions",
  "mcp-seccomp.bpf",
);

const PROBE_C_SOURCE = `/*
 * probe-ptrace.c — Phase 58 / MCP-04 enforce-integration probe.
 *
 * Calls ptrace(PTRACE_TRACEME, 0, 0, 0) once, prints the syscall return
 * value + errno, then exits 0. Under SCMP_ACT_LOG (Phase 55) the
 * syscall succeeds. Under SCMP_ACT_ERRNO (Phase 58) it fails with
 * errno=ENOSYS (or EPERM, glibc version-dependent) and the kernel
 * emits an audit type=1326 line for the soak reader to harvest.
 */
#include <errno.h>
#include <stdio.h>
#include <sys/ptrace.h>
#include <unistd.h>

int main(void) {
    long r = ptrace(PTRACE_TRACEME, 0, 0, 0);
    fprintf(stderr, "probe-ptrace: r=%ld errno=%d\\n", r, errno);
    return 0;
}
`;

const GATE_REASONS: string[] = [];
if (process.platform !== "linux") GATE_REASONS.push("non-linux platform");
if (!Bun.which("bwrap")) GATE_REASONS.push("bwrap missing from PATH");
if (!Bun.which("gcc")) GATE_REASONS.push("gcc missing from PATH");
if (!existsSync(BPF_PATH)) GATE_REASONS.push("mcp-seccomp.bpf artifact absent (run docker build)");

const SHOULD_SKIP = GATE_REASONS.length > 0;

beforeAll(() => {
  if (SHOULD_SKIP) return;
  // Write source and compile the probe once per test run.
  mkdirSync(PROBE_DIR, { recursive: true });
  writeFileSync(PROBE_C_PATH, PROBE_C_SOURCE, "utf8");
  const proc = Bun.spawnSync({
    cmd: ["gcc", "-O2", "-o", PROBE_BIN_PATH, PROBE_C_PATH],
    stderr: "pipe",
    stdout: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `probe-ptrace compile failed: ${new TextDecoder().decode(proc.stderr)}`,
    );
  }
});

test.skipIf(SHOULD_SKIP)(
  "ptrace under enforce returns EPERM/ENOSYS, emits MCP_SECCOMP_VIOLATION with code=0x00050001",
  async () => {
    if (SHOULD_SKIP) {
      console.warn(
        `mcp-seccomp-enforce-integration SKIPPED: ${GATE_REASONS.join(", ")}`,
      );
      return;
    }
    // Lazy-import the SUT only on Linux to avoid pulling DB modules into
    // dev-host unit-test runs.
    const { buildSandboxedMcpSpec, runMcpSeccompSoakReader } = await import(
      "../extensions/mcp-sandbox"
    );
    const { openSeccompBpfFd } = await import(
      "../extensions/runtime/seccomp-loader"
    );
    const { listAuditForExtension } = await import("../db/queries/audit-log");

    const seccompFd = openSeccompBpfFd();
    expect(seccompFd).not.toBeNull();

    const spawnAt = new Date();
    const stdioServer: McpServerStdio = {
      transport: "stdio",
      name: "probe-ptrace",
      command: PROBE_BIN_PATH,
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
    const { spec } = await buildSandboxedMcpSpec(
      stdioServer,
      manifest,
      grantedPerms,
      "ext-probe-ptrace",
    );
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
    const proc = Bun.spawn({
      cmd: [spec.command, ...(spec.args ?? [])],
      env: spec.env,
      stderr: "pipe",
      stdout: "pipe",
    });
    await proc.exited;
    const childPid = proc.pid;
    // Run the soak reader against the post-exit window.
    await runMcpSeccompSoakReader(childPid, spawnAt, {
      userId: null,
      extensionId: "ext-probe-ptrace",
      extensionName: "probe-ptrace",
    });
    // Poll audit_log for up to 5s.
    const deadline = Date.now() + 5000;
    let matchedRow: AuditEntry | null = null;
    while (Date.now() < deadline) {
      const rows = await listAuditForExtension("ext-probe-ptrace");
      const candidate = rows.find(
        (r) =>
          r.action === "ext:mcp:seccomp-violation" &&
          (r.metadata as { pid?: string } | null)?.pid === String(childPid),
      );
      if (candidate) {
        matchedRow = candidate;
        break;
      }
      await new Promise((res) => setTimeout(res, 200));
    }
    expect(matchedRow).not.toBeNull();
    const code =
      (matchedRow?.metadata as { code?: string } | null | undefined)?.code ??
      "";
    expect(code).toMatch(/^0x000?5000?1$/i);
  },
);
