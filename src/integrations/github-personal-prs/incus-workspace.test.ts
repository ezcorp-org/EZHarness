import { afterEach, describe, expect, test } from "bun:test";
import { createIncusSourceTransport } from "../../__tests__/helpers/incus-source-transport";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSandboxProviderMethodExchange, validateSandboxProviderMethodValue, type SandboxProtocolOperation } from "@ezcorp/extension-contract";
import type { SandboxController } from "../../runtime/sandbox/controller/types";
import type { ProviderSandboxWorkspaceCaller, WorkspaceGuestAction } from "../../runtime/workspaces/provider-backend";
import type { SandboxWorkspaceTarget } from "../../runtime/workspaces/target";
import { assertIncusImportSnapshot, createIncusSnapshotTransfer } from "./incus-workspace";
import { importSnapshotToSandbox } from "./provider-transfer";
import { validateSnapshot, type ValidatedSnapshot } from "./snapshot";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const binding = { projectId: "project", workspaceId: "binding", connectionId: "connection", providerId: "incus",
  generation: 1, presetId: "preset", releaseDigest: "a".repeat(64), presetDigest: "b".repeat(64), effectiveSettingsDigest: "c".repeat(64) };
function snapshot(entries: Array<{ path: string; bytes: Uint8Array | string; executable?: boolean }>): ValidatedSnapshot {
  return validateSnapshot(entries.map(file => { const bytes = Buffer.from(file.bytes); return { path: file.path,
    mode: file.executable ? "100755" : "100644", data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") }; }));
}
const operations: Record<WorkspaceGuestAction, SandboxProtocolOperation> = {
  "file.stat": "files.stat", "file.list": "files.list", "file.readRange": "files.readRange", "file.writeAtomic": "files.writeAtomic",
  "process.start": "processes.start", "process.inspect": "processes.inspect", "process.readOutput": "processes.readOutput", "process.cancel": "processes.cancel",
};
async function fixture(pageLimit = 100) {
  const root = await mkdtemp(join(tmpdir(), "incus-source-transfer-")); temporary.push(root);
  const workspace = join(root, "workspace"); const state = join(root, "state");
  await mkdir(workspace); await mkdir(state, { mode: 0o700 });
  const transport = createIncusSourceTransport(workspace, state);
  const calls: Parameters<ProviderSandboxWorkspaceCaller["call"]>[0][] = [];
  const commands: string[][] = [];
  let mutate: (action: WorkspaceGuestAction, value: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>> = (_action, value) => value;
  const caller: ProviderSandboxWorkspaceCaller = { async call(request) {
    calls.push(request);
    const operation = operations[request.action];
    const input = { ...request.payload, providerId: "incus", connectionId: binding.connectionId, sandboxId: binding.workspaceId,
      rpcDeadlineMs: request.action === "process.start" ? Math.min(Date.now() + 30_000, Number(request.payload.processDeadlineMs)) : Date.now() + 30_000, ...(["file.writeAtomic", "process.start", "process.cancel"].includes(request.action) ? { requestId: `call-${calls.length}`, idempotencyKey: `call-${calls.length}` } : {}) };
    validateSandboxProviderMethodValue(operation, "input", input);
    const result = await transport(operation, request.action === "file.list" ? { ...input, limit: Math.min(Number(input.limit), pageLimit) } : input) as Record<string, unknown>;
    const changed = await mutate(request.action, result);
    return validateSandboxProviderMethodExchange(operation, input, changed).result;
  } };
  const target: SandboxWorkspaceTarget = { kind: "sandbox", binding, backend: { async execute(request) {
    expect(request.principal).toEqual({ userId: "owner" });
    expect(request.binding).toEqual(binding);
    return { content: [{ type: "text", text: "" }], details: { exitCode: 0, stdout: "", stderr: "" } };
  } } };
  const transfer = createIncusSnapshotTransfer(caller, (captured, principal) => async argv => {
    expect(captured.binding).toEqual(binding); expect(principal).toEqual({ userId: "owner" });
    commands.push(argv);
    const proc = Bun.spawnSync(argv, { cwd: workspace });
    return { exitCode: proc.exitCode, stdout: new TextDecoder().decode(proc.stdout), stderr: new TextDecoder().decode(proc.stderr) };
  });
  const initialize = async () => {
    for (const argv of [["git", "init", "--initial-branch=ezharness-workspace", "--template=", "--", "."], ["git", "add", "--force", "--all", "--", "."]]) {
      const proc = Bun.spawnSync(argv, { cwd: workspace, env: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
      expect(proc.exitCode).toBe(0);
    }
  };
  return { root, workspace, calls, commands, target, caller, transfer, initialize,
    setMutate(fn: typeof mutate) { mutate = fn; } };
}

describe("Incus source transfer through the declared protocol and real guest file helper", () => {
  test("RED boundary: the current legacy transfer sends an absolute root unsupported by new Incus", async () => {
    const bridge: Pick<SandboxController, "admitSandboxMethod" | "executeAdmittedSandboxMethod"> = {
      async admitSandboxMethod(_user, _project, input) {
        validateSandboxProviderMethodValue("files.list", "input", { ...input.payload, providerId: "incus", connectionId: "connection", sandboxId: "binding", rpcDeadlineMs: Date.now() + 30_000 });
        throw new Error("Legacy transfer must fail before new Incus admission");
      },
      async executeAdmittedSandboxMethod() { throw new Error("No dispatch after rejected protocol input"); },
    };
    await expect(importSnapshotToSandbox(bridge, "owner", "project", snapshot([]))).rejects.toThrow();
  });

  test("imports nested executable, binary, empty and64KiB files, then captures immutable source bytes", async () => {
    const f = await fixture();
    const original = snapshot([{ path: "src/nested/run.sh", bytes: "echo safe\n", executable: true },
      { path: "binary.dat", bytes: Uint8Array.of(0, 255, 128, 1) }, { path: "empty", bytes: "" },
      { path: "boundary", bytes: new Uint8Array(64 * 1024).fill(7) }]);
    await f.transfer.importSnapshot(f.target, "owner", original);
    expect((await stat(join(f.workspace, "src/nested/run.sh"))).mode & 0o111).not.toBe(0);
    const captured = await f.transfer.exportSnapshot(f.target, "owner");
    expect(captured.digest).toBe(original.digest);
    await writeFile(join(f.workspace, "binary.dat"), "guest changed after review");
    expect(captured.files.find(file => file.path === "binary.dat")?.bytes).toEqual(Uint8Array.of(0, 255, 128, 1));
    expect(f.commands.filter(argv => argv[0] === "python3")).toHaveLength(1);
    expect(f.commands[0]?.slice(0, 2)).toEqual(["python3", "-c"]);
    expect(f.commands[0]?.at(-1)).toBe("src/nested");
    expect(f.calls.every(call => call.principal?.userId === "owner" && call.binding.generation === 1)).toBe(true);
    expect(new Set(f.calls.map(call => call.toolCallId)).size).toBe(f.calls.length);
    expect(f.calls.filter(call => call.action === "file.writeAtomic").every(call => call.payload.expectedRevision === null)).toBe(true);
    expect(JSON.stringify(f.calls)).not.toContain("githubToken");
  });

  test("the actual native command backend imports through the same protocol transport without command stubs", async () => {
    const f = await fixture();
    const { createProviderSandboxWorkspaceBackend } = await import("../../runtime/workspaces/provider-backend");
    const target: SandboxWorkspaceTarget = { ...f.target, backend: createProviderSandboxWorkspaceBackend(f.caller) };
    const transfer = createIncusSnapshotTransfer(f.caller);
    const original = snapshot([{ path: "src/native.txt", bytes: "native transport" }]);
    await transfer.importSnapshot(target, "owner", original);
    expect((await transfer.exportSnapshot(target, "owner")).digest).toBe(original.digest);
    const starts = f.calls.filter(call => call.action === "process.start");
    expect(starts.length).toBeGreaterThan(3);
    expect(starts.every(call => JSON.stringify(call.payload.env) === "[]" && call.payload.cwd === ".")).toBe(true);
    expect(new Set(starts.map(call => call.toolCallId)).size).toBe(starts.length);
  });

  test("captures a file above64KiB using one pinned revision across ranges", async () => {
    const f = await fixture();
    const bytes = new Uint8Array(130_000).fill(173);
    await writeFile(join(f.workspace, "large.bin"), bytes); await f.initialize();
    const result = await f.transfer.exportSnapshot(f.target, "owner");
    expect(result.files[0]?.bytes).toEqual(bytes);
    const ranges = f.calls.filter(call => call.action === "file.readRange");
    expect(ranges.map(call => call.payload.offsetBytes)).toEqual([0, 65_536]);
    expect(new Set(ranges.map(call => call.payload.revision)).size).toBe(1);
  });

  test("native Git work ignores metadata and generated output but retains tracked ignored edits and deletions", async () => {
    const f = await fixture();
    const original = snapshot([{ path: ".gitignore", bytes: "node_modules/\ndist/\ntracked.txt\n" },
      { path: "tracked.txt", bytes: "base" }, { path: "deleted.txt", bytes: "base" }]);
    await f.transfer.importSnapshot(f.target, "owner", original);
    await rm(join(f.workspace, "deleted.txt")); await writeFile(join(f.workspace, "tracked.txt"), "edited");
    await writeFile(join(f.workspace, "new source.txt"), "new");
    for (const path of ["node_modules", "dist"]) { await mkdir(join(f.workspace, path)); await writeFile(join(f.workspace, path, "artifact"), "ignored"); }
    const result = await f.transfer.exportSnapshot(f.target, "owner");
    expect(result.files.map(file => file.path)).toEqual([".gitignore", "new source.txt", "tracked.txt"]);
    expect(new TextDecoder().decode(result.files.find(file => file.path === "tracked.txt")?.bytes)).toBe("edited");
    expect(f.calls.some(call => String(call.payload.path).startsWith(".git/") || String(call.payload.path).startsWith("node_modules/"))).toBe(false);
  });

  test("preflights the whole import before effects and never silently truncates unsupported files", async () => {
    for (const bad of [snapshot([{ path: "valid", bytes: "ok" }, { path: "oversized", bytes: new Uint8Array(65_537) }]),
      snapshot([{ path: "a".repeat(241), bytes: "x" }]), snapshot([{ path: "é".repeat(121), bytes: "x" }]), snapshot([{ path: "nested/.ezh-config", bytes: "reserved" }])]) {
      const f = await fixture();
      await expect(f.transfer.importSnapshot(f.target, "owner", bad)).rejects.toThrow();
      expect(f.calls).toHaveLength(0); expect(f.commands).toHaveLength(0);
    }
    const f = await fixture(); const changed = snapshot([{ path: "safe", bytes: "before" }]); const first = changed.files[0]; if (!first) throw new Error("Expected fixture file"); first.bytes[0] = 0;
    await expect(f.transfer.importSnapshot(f.target, "owner", changed)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  test("public preflight rejects stale snapshot metadata before any guest effect", async () => {
    const source = snapshot([{ path: "file", bytes: "reviewed source" }]);
    expect(() => assertIncusImportSnapshot(source)).not.toThrow();
    for (const stale of [{ ...source, digest: "0".repeat(64) }, { ...source, totalBytes: source.totalBytes + 1 }]) {
      const f = await fixture();
      expect(() => assertIncusImportSnapshot(stale)).toThrow("changed before import");
      await expect(f.transfer.importSnapshot(f.target, "owner", stale)).rejects.toThrow("changed before import");
      expect(f.calls).toHaveLength(0); expect(f.commands).toHaveLength(0);
    }
  });

  test("unsupported target or absent owner never selects a host or another provider", async () => {
    const f = await fixture();
    for (const target of [{ ...f.target, backend: null }, { ...f.target, binding: { ...binding, providerId: "amd" } }]) {
      await expect(f.transfer.exportSnapshot(target, "owner")).rejects.toThrow("unavailable");
    }
    await expect(f.transfer.importSnapshot(f.target, "", snapshot([]))).rejects.toThrow("unavailable");
    expect(f.calls).toHaveLength(0); expect(f.commands).toHaveLength(0);
  });

  test("rejects an oversized actual source before any file content transfer", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "large"), ""); await f.initialize();
    await truncate(join(f.workspace, "large"), 32 * 1024 * 1024 + 1);
    await expect(f.transfer.exportSnapshot(f.target, "owner")).rejects.toThrow("snapshot limit");
    expect(f.calls.some(call => call.action === "file.readRange")).toBe(false);
  });

  test("refuses a nonempty workspace before directories or writes", async () => {
    const f = await fixture(); await writeFile(join(f.workspace, "existing"), "keep");
    await expect(f.transfer.importSnapshot(f.target, "owner", snapshot([{ path: "new/file", bytes: "x" }]))).rejects.toThrow("not empty");
    expect(f.commands).toHaveLength(0); expect(f.calls.some(call => call.action === "file.writeAtomic")).toBe(false);
  });

  test("a symlink appearing during directory creation cannot escape the workspace", async () => {
    const f = await fixture(); const outside = join(f.root, "outside"); await mkdir(outside);
    const transfer = createIncusSnapshotTransfer(f.caller, () => async argv => {
      await symlink(outside, join(f.workspace, "nested"));
      const proc = Bun.spawnSync(argv, { cwd: f.workspace });
      return { exitCode: proc.exitCode, stdout: "", stderr: "" };
    });
    await expect(transfer.importSnapshot(f.target, "owner", snapshot([{ path: "nested/new/file", bytes: "x" }]))).rejects.toThrow("safely");
    expect(await Bun.file(join(outside, "new/file")).exists()).toBe(false);
    expect(f.calls.some(call => call.action === "file.writeAtomic")).toBe(false);
  });

  test("create-only write CAS rejects a file appearing after the empty check", async () => {
    const f = await fixture();
    f.setMutate(async (action, reply) => {
      if (action === "file.list") await writeFile(join(f.workspace, "new"), "racing guest");
      return reply;
    });
    await expect(f.transfer.importSnapshot(f.target, "owner", snapshot([{ path: "new", bytes: "host" }]))).rejects.toThrow();
    expect(await readFile(join(f.workspace, "new"), "utf8")).toBe("racing guest");
  });

  test("rejects links and protected metadata in source capture", async () => {
    for (const entry of ["symlink", ".ezcorp", ".ezh-source"]) {
      const f = await fixture();
      if (entry === "symlink") await symlink("/etc/passwd", join(f.workspace, entry));
      else { await mkdir(join(f.workspace, entry)); await writeFile(join(f.workspace, entry, "data"), "x"); }
      await f.initialize();
      await expect(f.transfer.exportSnapshot(f.target, "owner")).rejects.toThrow();
    }
  });

  test("rejects modified range bytes and changed revisions before creating a snapshot", async () => {
    for (const change of ["revision", "data", "eof", "offset", "stat"]) {
      const f = await fixture(); await writeFile(join(f.workspace, "file"), "captured"); await f.initialize();
      f.setMutate((action, value) => {
        if (action === "file.readRange") {
          if (change === "revision") return { ...value, revision: "wrong" };
          if (change === "data") return { ...value, dataBase64: "AA==", byteLength: 1, eof: false };
          if (change === "eof") return { ...value, eof: false };
          if (change === "offset") return { ...value, offsetBytes: 1 };
        }
        if (action === "file.stat" && change === "stat") return { ...value, file: { ...value.file as Record<string, unknown>, revision: "changed" } };
        return value;
      });
      await expect(f.transfer.exportSnapshot(f.target, "owner")).rejects.toThrow();
    }
  });

  test("an actual guest edit after the last range cannot pass the post-capture revision check", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "file"), "captured"); await f.initialize();
    f.setMutate(async (action, value) => {
      if (action === "file.readRange") await writeFile(join(f.workspace, "file"), "modified after reading");
      return value;
    });
    await expect(f.transfer.exportSnapshot(f.target, "owner")).rejects.toThrow("changed during capture");
  });

  test("validates imported metadata and executable mode by readback", async () => {
    for (const change of ["size", "mode"]) {
      const f = await fixture();
      f.setMutate((action, value) => {
        if (action === "file.writeAtomic" && change === "size") return { ...value, sizeBytes: 99 };
        if (action === "file.stat" && change === "mode") return { ...value, file: { ...value.file as Record<string, unknown>, executable: true } };
        return value;
      });
      await expect(f.transfer.importSnapshot(f.target, "owner", snapshot([{ path: "file", bytes: "x" }]))).rejects.toThrow();
    }
  });
});
