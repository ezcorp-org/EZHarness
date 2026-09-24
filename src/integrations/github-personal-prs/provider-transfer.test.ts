import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { SandboxController } from "../../runtime/sandbox/controller/types";
import { LocalWorkspaceFiles } from "../../runtime/sandbox/local-podman/files";
import { exportSnapshotFromSandbox, importSnapshotToSandbox, WorkspaceTransferError } from "./provider-transfer";
import { validateSnapshot } from "./snapshot";

function file(path: string, value: string) {
  const bytes = Buffer.from(value);
  return { path, mode: "100644" as const, data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}

function fakeBridge(operate: (operation: string, payload: Record<string, unknown>) => Record<string, unknown>) {
  const admitted = new Map<string, { operation: string; payload: Record<string, unknown> }>();
  const calls: string[] = [];
  const bridge = {
    async admitSandboxMethod(_userId: string, _projectId: string, input: { operation: string; payload: Record<string, unknown> }) {
      const id = crypto.randomUUID();
      admitted.set(id, input); calls.push(input.operation);
      return { id, group: "sandbox.files.v1", operation: input.operation, state: "admitted", provider: { installationId: "x", providerId: "x", releaseId: "x", releaseBinding: "x", generation: 1 } };
    },
    async executeAdmittedSandboxMethod(_userId: string, id: string) {
      const input = admitted.get(id)!;
      return { id, group: "sandbox.files.v1", operation: input.operation, state: "succeeded", provider: { installationId: "x", providerId: "x", releaseId: "x", releaseBinding: "x", generation: 1 }, result: { receipt: { outcome: "succeeded" }, ...operate(input.operation, input.payload) } };
    },
  } as Pick<SandboxController, "admitSandboxMethod" | "executeAdmittedSandboxMethod">;
  return { bridge, calls };
}

describe("sandbox PR transfer", () => {
  test("imports only into an empty workspace and verifies each written file", async () => {
    const content = Buffer.from("hello");
    const { bridge, calls } = fakeBridge((operation, payload) => {
      if (operation === "list") return { entries: [] };
      if (operation === "stat") return { entry: { kind: "file", sizeBytes: content.length, mode: 0o644 } };
      if (operation === "read") return { data: content.toString("base64"), encoding: "base64", eof: true };
      if (operation === "write") expect(payload.path).toBe("/src/a.txt");
      return {};
    });
    await importSnapshotToSandbox(bridge, "owner", "project", validateSnapshot([file("src/a.txt", "hello")]));
    expect(calls).toEqual(["list", "mkdir", "write", "chmod", "stat", "read"]);
  });

  test("imports into a fresh ext2 workspace with an empty lost+found directory", async () => {
    const content = Buffer.from("hello");
    const { bridge, calls } = fakeBridge((operation, payload) => {
      if (operation === "list" && payload.path === "/") return { entries: [{ path: "/lost+found", kind: "directory" }] };
      if (operation === "list" && payload.path === "/lost+found") return { entries: [] };
      if (operation === "stat") return { entry: { kind: "file", sizeBytes: content.length, mode: 0o644 } };
      if (operation === "read") return { data: content.toString("base64"), encoding: "base64", eof: true };
      return {};
    });
    await importSnapshotToSandbox(bridge, "owner", "project", validateSnapshot([file("src/a.txt", "hello")]));
    expect(calls).toEqual(["list", "list", "mkdir", "write", "chmod", "stat", "read"]);
  });

  test("imports through the real workspace file adapter with ext2 housekeeping", async () => {
    const root = await mkdtemp(join(tmpdir(), "ez-pr-import-"));
    try {
      await mkdir(join(root, "lost+found"), { mode: 0o700 });
      const workspace = new LocalWorkspaceFiles(root, { maxReadBytes: 256 * 1024, maxWriteBytes: 256 * 1024, maxListEntries: 256 });
      const pending = new Map<string, { operation: string; payload: Record<string, unknown> }>();
      const call = { scope: { projectId: "project-1", bindingId: "binding-1", generation: 1 }, operationId: "operation-1", idempotencyKey: "retry-1", requestDigest: "a".repeat(64) };
      const bridge = {
        async admitSandboxMethod(_user: string, _project: string, input: { operation: string; payload: Record<string, unknown> }) {
          const id = crypto.randomUUID(); pending.set(id, input); return { id };
        },
        async executeAdmittedSandboxMethod(_user: string, id: string) {
          const input = pending.get(id)!;
          const request = { call, resourceId: "resource-1", ...input.payload } as never;
          const result = input.operation === "list" ? await workspace.list(request)
            : input.operation === "mkdir" ? await workspace.mkdir(request)
            : input.operation === "write" ? await workspace.write(request)
            : input.operation === "chmod" ? await workspace.chmod(request)
            : input.operation === "stat" ? await workspace.stat(request)
            : input.operation === "read" ? await workspace.read(request)
            : (() => { throw new Error(`Unexpected workspace operation: ${input.operation}`); })();
          return { result: { receipt: { outcome: "succeeded" }, ...result } };
        },
      };
      await importSnapshotToSandbox(bridge as never, "owner", "project-1", validateSnapshot([file("src/a.txt", "hello")]));
      expect(await readFile(join(root, "src/a.txt"), "utf8")).toBe("hello");
      expect((await workspace.list({ call, resourceId: "resource-1", path: "/lost+found", limit: 1 })).entries).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects unexpected or occupied ext2 housekeeping content", async () => {
    const snapshot = validateSnapshot([file("a.txt", "hello")]);
    for (const entries of [[{ path: "/lost+found", kind: "file" }], [{ path: "/lost+found", kind: "directory" }, { path: "/other", kind: "file" }]]) {
      const { bridge } = fakeBridge((operation, payload) => operation === "list" && payload.path === "/" ? { entries } : {});
      await expect(importSnapshotToSandbox(bridge, "owner", "project", snapshot)).rejects.toMatchObject({ code: "unsupported_workspace" });
    }
    const occupied = fakeBridge((operation, payload) => operation === "list" && payload.path === "/" ? { entries: [{ path: "/lost+found", kind: "directory" }] } : operation === "list" ? { entries: [{ path: "/lost+found/host-file", kind: "file" }] } : {});
    await expect(importSnapshotToSandbox(occupied.bridge, "owner", "project", snapshot)).rejects.toMatchObject({ code: "unsupported_workspace" });
  });

  test("refuses nonempty workspace and mismatched readback", async () => {
    const snapshot = validateSnapshot([file("a.txt", "hello")]);
    const nonempty = fakeBridge(operation => operation === "list" ? { entries: [{ path: "/other" }] } : {});
    await expect(importSnapshotToSandbox(nonempty.bridge, "owner", "project", snapshot)).rejects.toMatchObject({ code: "unsupported_workspace" });
    expect(nonempty.calls).toEqual(["list"]);
    const bad = fakeBridge((operation) => operation === "list" ? { entries: [] } : operation === "stat" ? { entry: { kind: "file", sizeBytes: 5, mode: 0o644 } } : operation === "read" ? { data: "bad", encoding: "utf8", eof: true } : {});
    await expect(importSnapshotToSandbox(bad.bridge, "owner", "project", snapshot)).rejects.toBeInstanceOf(WorkspaceTransferError);
  });

  test("reads a frozen bundle and rejects changed bytes", async () => {
    const bundle = Buffer.from(JSON.stringify([file("a.txt", "hello")]));
    const digest = createHash("sha256").update(bundle).digest("hex");
    const get = (tamper: boolean) => fakeBridge((operation, payload) => {
      if (operation === "beginExport") return { snapshotId: "snapshot", byteLength: bundle.length, sha256: digest };
      if (operation === "readExport") { const offset = Number(payload.offsetBytes); const bytes = bundle.subarray(offset, offset + Number(payload.lengthBytes)); return { snapshotId: "snapshot", offsetBytes: offset, nextOffsetBytes: offset + bytes.length, eof: true, data: tamper ? Buffer.from("changed").toString("base64") : bytes.toString("base64") }; }
      return {};
    });
    const good = get(false);
    expect((await exportSnapshotFromSandbox(good.bridge, "owner", "project", "conversation")).files[0]!.path).toBe("a.txt");
    expect(good.calls.at(-1)).toBe("endExport");
    const bad = get(true);
    await expect(exportSnapshotFromSandbox(bad.bridge, "owner", "project", "conversation")).rejects.toMatchObject({ code: "tampered_snapshot" });
    expect(bad.calls.at(-1)).toBe("endExport");
  });
});
