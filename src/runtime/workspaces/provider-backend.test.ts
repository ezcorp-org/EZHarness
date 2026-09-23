import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getBuiltinToolDefs } from "../tools";
import { createProviderSandboxWorkspaceBackend, type ProviderSandboxWorkspaceCaller, type WorkspaceGuestAction } from "./provider-backend";
import { sandboxWorkspaceTarget, type SandboxWorkspaceBinding } from "./target";

const binding: SandboxWorkspaceBinding = {
  projectId: "project-1", workspaceId: "sandbox-1", connectionId: "connection-1",
  providerId: "incus", generation: 2, presetId: "feature",
  releaseDigest: "a".repeat(64), presetDigest: "b".repeat(64), effectiveSettingsDigest: "c".repeat(64),
};

class FakeGuest implements ProviderSandboxWorkspaceCaller {
  missingRg = false;
  files = new Map<string, { text: string; revision: string }>([
    ["src/input.ts", { text: "guest value\n", revision: "rev-1" }],
  ]);
  calls: Array<{ action: WorkspaceGuestAction; payload: Record<string, unknown>; binding: SandboxWorkspaceBinding; toolCallId: string }> = [];
  command = "";
  async call(input: Parameters<ProviderSandboxWorkspaceCaller["call"]>[0]): Promise<unknown> {
    this.calls.push({ action: input.action, payload: input.payload, binding: input.binding as SandboxWorkspaceBinding, toolCallId: input.toolCallId });
    const path = input.payload.path as string;
    switch (input.action) {
      case "file.stat": {
        const file = this.files.get(path);
        return file ? { ok: true, file: { path, kind: "file", revision: file.revision, sizeBytes: Buffer.byteLength(file.text) } }
          : { ok: false, error: { kind: "not_found", message: "File not found" } };
      }
      case "file.readRange": {
        const file = this.files.get(path)!;
        if (input.payload.revision !== file.revision) return { ok: false, error: { code: "revision_conflict", message: "Changed" } };
        const bytes = Buffer.from(file.text);
        const start = input.payload.offsetBytes as number;
        const data = bytes.subarray(start, start + (input.payload.lengthBytes as number));
        return { ok: true, path, revision: file.revision, offsetBytes: start, dataBase64: data.toString("base64"), byteLength: data.length, eof: start + data.length >= bytes.length };
      }
      case "file.writeAtomic": {
        const old = this.files.get(path);
        if ((old?.revision ?? null) !== input.payload.expectedRevision) return { ok: false, error: { code: "revision_conflict", message: "Changed" } };
        const text = Buffer.from(input.payload.dataBase64 as string, "base64").toString();
        this.files.set(path, { text, revision: "rev-2" });
        return { ok: true, path, revision: "rev-2", sizeBytes: Buffer.byteLength(text) };
      }
      case "file.list": {
        const directory = path === "." ? "" : path.endsWith("/") ? path : `${path}/`;
        const entries = [...this.files.keys()]
          .filter(item => item.startsWith(directory))
          .map(item => item.slice(directory.length).split("/")[0]!)
          .filter((item, index, items) => items.indexOf(item) === index)
          .map(name => ({ path: directory + name, kind: name.includes(".") ? "file" : "directory", revision: "rev-1", sizeBytes: 0 }));
        return { ok: true, entries, directoryRevision: "dir-1" };
      }
      case "process.start": {
        const argv = input.payload.argv as string[];
        this.command = argv.join(" ");
        return { ok: true, processId: "process-1", bootId: "boot-1", startedAt: new Date().toISOString() };
      }
      case "process.readOutput": {
        const stdout = this.missingRg && this.command.startsWith("rg ") ? ""
          : this.command.startsWith("rg -n") || this.command.startsWith("grep ") ? "src/input.ts:1:guest value\n"
          : this.command.startsWith("rg --files") ? "src/input.ts\n"
          : this.command.startsWith("find ") ? "src/input.ts\n"
          : this.command.includes("printf") ? "guest shell\n" : "";
        return { ok: true, chunks: [{ stream: "stdout", offsetBytes: 0, dataBase64: Buffer.from(stdout).toString("base64"), byteLength: Buffer.byteLength(stdout) }], nextCursor: { sandboxId: binding.workspaceId, processId: "process-1", bootId: "boot-1", offsetBytes: Buffer.byteLength(stdout) }, eof: true };
      }
      case "process.inspect": return this.missingRg && this.command.startsWith("rg ")
        ? { ok: true, process: { state: "failed", exitCode: null } }
        : { ok: true, process: { state: "succeeded", exitCode: 0 } };
      case "process.cancel": return { ok: true };
    }
  }
}

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("provider sandbox workspace bridge", () => {
  test("native tools reach the guest and cannot read, write, search, or run on AMD", async () => {
    const amd = await mkdtemp(join(tmpdir(), "ez-amd-canary-"));
    tempRoots.push(amd);
    await writeFile(join(amd, "secret.txt"), "AMD_SECRET");
    const guest = new FakeGuest();
    const tools = new Map(getBuiltinToolDefs(sandboxWorkspaceTarget(binding, createProviderSandboxWorkspaceBackend(guest)))
      .map(tool => [tool.name, tool]));

    const read = await tools.get("readFile")!.execute("read", { path: "src/input.ts" });
    expect(read.content[0]).toEqual({ type: "text", text: "guest value\n" });
    const edit = await tools.get("editFile")!.execute("edit", { path: "src/input.ts", old_string: "guest", new_string: "changed" });
    expect(edit.details).toMatchObject({ newContent: "changed value\n" });
    expect(guest.files.get("src/input.ts")?.text).toBe("changed value\n");
    const list = await tools.get("listFiles")!.execute("list", { path: "src" });
    expect(list.content[0]).toEqual({ type: "text", text: "input.ts" });
    const tree = await tools.get("readDirectory")!.execute("tree", { path: "src" });
    expect((tree.content[0] as { text: string }).text).toContain("input.ts");
    const shell = await tools.get("shell")!.execute("shell", { command: "printf guest" });
    expect(shell.details).toMatchObject({ stdout: "guest shell\n", exitCode: 0 });
    const grep = await tools.get("grep")!.execute("grep", { pattern: "guest", path: "src" });
    expect(grep.details).toMatchObject({ matchCount: 1 });
    const glob = await tools.get("glob")!.execute("glob", { pattern: "**/*.ts" });
    expect(glob.details).toMatchObject({ fileCount: 1 });

    expect(guest.calls.every(call => JSON.stringify(call.binding) === JSON.stringify(binding))).toBe(true);
    expect(guest.calls.some(call => call.action === "file.writeAtomic" && call.payload.expectedRevision === "rev-1")).toBe(true);
    expect(guest.calls.some(call => call.action === "process.start" && (call.payload.argv as string[])[0] === "/bin/sh")).toBe(true);
    expect(guest.calls.some(call => JSON.stringify(call.payload).includes(amd))).toBe(false);
    expect(await readFile(join(amd, "secret.txt"), "utf8")).toBe("AMD_SECRET");
  });

  test("rejects an absolute AMD path before provider dispatch", async () => {
    const guest = new FakeGuest();
    const read = getBuiltinToolDefs(sandboxWorkspaceTarget(binding, createProviderSandboxWorkspaceBackend(guest)))
      .find(tool => tool.name === "readFile")!;
    const result = await read.execute("read", { path: "/amd/secret.txt" });
    expect(result.details).toMatchObject({ isError: true });
    expect(guest.calls).toEqual([]);
  });

  test("uses guest POSIX search tools when ripgrep is absent", async () => {
    const guest = new FakeGuest();
    guest.missingRg = true;
    const tools = new Map(getBuiltinToolDefs(sandboxWorkspaceTarget(binding, createProviderSandboxWorkspaceBackend(guest)))
      .map(tool => [tool.name, tool]));
    const grep = await tools.get("grep")!.execute("grep", { pattern: "guest", path: "src" });
    const glob = await tools.get("glob")!.execute("glob", { pattern: "**/*.ts" });
    expect(grep.details).toMatchObject({ matchCount: 1, backend: "grep" });
    expect(glob.details).toMatchObject({ fileCount: 1 });
    expect(guest.calls.filter(call => call.action === "process.start").map(call => (call.payload.argv as string[])[0]))
      .toEqual(["rg", "grep", "rg", "find"]);
    expect(new Set(guest.calls.filter(call => call.action === "process.start").map(call => call.toolCallId)).size).toBe(4);
  });
});
