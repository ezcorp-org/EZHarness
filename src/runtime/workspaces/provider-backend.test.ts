import { afterEach, describe, expect, spyOn, test } from "bun:test";
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

function toolWithReply(name: string, reply: (input: Parameters<ProviderSandboxWorkspaceCaller["call"]>[0]) => Promise<unknown>) {
  return getBuiltinToolDefs(sandboxWorkspaceTarget(binding, createProviderSandboxWorkspaceBackend({ call: reply })))
    .find(tool => tool.name === name)!;
}

test("guest file reads reject changed revisions, stalled ranges, and oversized files", async () => {
  const cases = [
    { sizeBytes: 1, range: { revision: "changed", offsetBytes: 0, dataBase64: btoa("x") }, message: "changed during read" },
    { sizeBytes: 1, range: { revision: "rev", offsetBytes: 0, dataBase64: "" }, message: "made no progress" },
    { sizeBytes: Number.MAX_SAFE_INTEGER, range: null, message: "exceeds the read limit" },
  ];
  for (const item of cases) {
    const seen: WorkspaceGuestAction[] = [];
    const tool = toolWithReply("readFile", async ({ action }) => {
      seen.push(action);
      return action === "file.stat" ? { ok: true, file: { kind: "file", revision: "rev", sizeBytes: item.sizeBytes } }
        : { ok: true, ...item.range };
    });
    const output = await tool.execute("read", { path: "src/input.ts" });
    expect(output).toMatchObject({ details: { isError: true } });
    expect((output.content[0] as { text: string }).text).toContain(item.message);
    expect(seen).toEqual(item.range ? ["file.stat", "file.readRange"] : ["file.stat"]);
  }
});

test("guest list rejects paths outside its directory", async () => {
  const tool = toolWithReply("listFiles", async () => ({ ok: true, entries: [{ path: "elsewhere/secret", kind: "file" }] }));
  const output = await tool.execute("list", { path: "src" });
  expect(output).toMatchObject({ details: { isError: true } });
  expect((output.content[0] as { text: string }).text).toContain("escaped its directory");
});

test("guest process failures cancel the remote process", async () => {
  const calls: WorkspaceGuestAction[] = [];
  const tool = toolWithReply("shell", async ({ action }) => {
    calls.push(action);
    if (action === "process.start") return { ok: true, processId: "process", bootId: "boot" };
    if (action === "process.readOutput") return { ok: true, gap: true };
    if (action === "process.cancel") return { ok: true };
    throw new Error("unexpected process inspection");
  });
  const output = await tool.execute("shell", { command: "true" });
  expect(output).toMatchObject({ details: { isError: true } });
  expect((output.content[0] as { text: string }).text).toContain("output has a gap");
  expect(calls).toEqual(["process.start", "process.readOutput", "process.cancel"]);
});

test("guest process output is bounded before it reaches the host", async () => {
  const calls: WorkspaceGuestAction[] = [];
  const tool = toolWithReply("shell", async ({ action }) => {
    calls.push(action);
    if (action === "process.start") return { ok: true, processId: "process", bootId: "boot" };
    if (action === "process.readOutput") return { ok: true, chunks: [{ stream: "stdout", dataBase64: Buffer.alloc(64 * 1024, 120).toString("base64") }], eof: false };
    if (action === "process.inspect") return { ok: true, process: { state: "running" } };
    if (action === "process.cancel") return { ok: true };
    throw new Error("output was not bounded");
  });
  const output = await tool.execute("shell", { command: "true" });
  expect(output.details).toMatchObject({ exitCode: -1, truncated: true });
  expect(calls.filter(action => action === "process.readOutput")).toHaveLength(17);
  expect(calls.at(-1)).toBe("process.cancel");
});

test("guest provider errors preserve safe failure details", async () => {
  for (const [reply, expected] of [
    [{ ok: false }, "Sandbox provider action failed"],
    [{ ok: false, error: { code: "revision_conflict", message: "Changed" } }, "Changed"],
    [{ ok: false, error: { kind: "not_found" } }, "Sandbox provider action failed"],
  ] as const) {
    const tool = toolWithReply("readFile", async () => reply);
    const output = await tool.execute("read", { path: "src/input.ts" });
    expect(output.details).toMatchObject({ isError: true });
    expect((output.content[0] as { text: string }).text).toContain(expected);
  }
});

test("guest list passes its opaque cursor and filters names in the bound directory", async () => {
  const cursors: unknown[] = [];
  const tool = toolWithReply("listFiles", async ({ payload }) => {
    cursors.push(payload.cursor);
    return payload.cursor ? { ok: true, entries: [{ path: "src/app.ts", kind: "file" }] }
      : { ok: true, entries: [{ path: "src/notes.md", kind: "file" }], nextCursor: "page-2" };
  });
  const output = await tool.execute("list", { path: "src", pattern: "*.ts" });
  expect(output.content).toEqual([{ type: "text", text: "app.ts" }]);
  expect(cursors).toEqual([undefined, "page-2"]);
});

test("guest process streams stderr and waits for terminal output", async () => {
  let reads = 0;
  const tool = toolWithReply("shell", async ({ action }) => {
    if (action === "process.start") return { ok: true, processId: "process", bootId: "boot" };
    if (action === "process.readOutput") return { ok: true, chunks: reads++ === 0
      ? [{ stream: "stderr", dataBase64: btoa("warning") }] : [], eof: reads > 1 };
    if (action === "process.inspect") return { ok: true, process: { state: reads > 1 ? "failed" : "running", exitCode: 3 } };
    throw new Error("unexpected cancellation");
  });
  const output = await tool.execute("shell", { command: "false" });
  expect(output.details).toMatchObject({ stderr: "warning", exitCode: 3, truncated: false });
  expect(reads).toBe(2);
});

test("guest edit validates ranges and creates a nested guest directory", async () => {
  const guest = new FakeGuest();
  const edit = getBuiltinToolDefs(sandboxWorkspaceTarget(binding, createProviderSandboxWorkspaceBackend(guest)))
    .find(tool => tool.name === "editFile")!;
  const changed = await edit.execute("edit", { path: "src/input.ts", lineRange: { startLine: 1, endLine: 1 }, new_string: "new line" });
  expect(changed.details).toMatchObject({ newContent: "new line\n" });
  const invalid = await edit.execute("edit", { path: "src/input.ts", lineRange: { startLine: 3, endLine: 2 }, new_string: "bad" });
  expect(invalid.details).toMatchObject({ isError: true });
  const created = await edit.execute("create", { path: "nested/new.ts", new_string: "guest" });
  expect(created.details).toMatchObject({ newContent: "guest" });
  expect(guest.calls.some(call => call.action === "process.start" && (call.payload.argv as string[]).join(" ") === "mkdir -p nested")).toBe(true);
  expect(guest.files.get("nested/new.ts")?.text).toBe("guest");
});

test("guest edit never writes when an expected old file is missing", async () => {
  const actions: WorkspaceGuestAction[] = [];
  const tool = toolWithReply("editFile", async ({ action }) => {
    actions.push(action);
    return { ok: false, error: { kind: "not_found", message: "File not found" } };
  });
  const output = await tool.execute("edit", { path: "missing.ts", old_string: "old", new_string: "new" });
  expect(output.details).toMatchObject({ isError: true });
  expect(actions).toEqual(["file.stat"]);
});


test("guest list stops after the maximum number of cursor pages", async () => {
  let pages = 0;
  const tool = toolWithReply("listFiles", async () => {
    pages++;
    return { ok: true, entries: [], nextCursor: `page-${pages}` };
  });
  const output = await tool.execute("list", { path: "src" });
  expect(output.details).toMatchObject({ isError: true });
  expect((output.content[0] as { text: string }).text).toContain("exceeds the list limit");
  expect(pages).toBe(100);
});

test("guest process stops after its bounded poll count and cancels", async () => {
  let polls = 0;
  let cancelled = false;
  const tool = toolWithReply("shell", async ({ action }) => {
    if (action === "process.start") return { ok: true, processId: "process", bootId: "boot" };
    if (action === "process.readOutput") { polls++; return { ok: true, chunks: [], eof: false }; }
    if (action === "process.inspect") return { ok: true, process: { state: "running" } };
    if (action === "process.cancel") { cancelled = true; return { ok: true }; }
    throw new Error("unexpected guest action");
  });
  const instantTimer = ((...args: Parameters<typeof setTimeout>) => {
    queueMicrotask(() => args[0]());
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(instantTimer);
  try {
    const output = await tool.execute("shell", { command: "true", timeout: 30_000 });
    expect(output.details).toMatchObject({ isError: true });
    expect((output.content[0] as { text: string }).text).toContain("polling limit reached");
    expect(polls).toBe(7_000);
    expect(cancelled).toBe(true);
  } finally { timer.mockRestore(); }
});
