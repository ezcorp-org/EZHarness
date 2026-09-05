import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resolve, normalize } from "node:path";
import { getChannel } from "@ezcorp/sdk/runtime";
import { _internals, main } from "./index";
import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";

// Test path validation logic
function isUnderCwd(cwd: string, filePath: string): boolean {
  const resolved = resolve(cwd, normalize(filePath));
  return resolved.startsWith(cwd + "/") || resolved === cwd;
}

test("isUnderCwd allows relative paths within cwd", () => {
  expect(isUnderCwd("/project", "src/index.ts")).toBe(true);
  expect(isUnderCwd("/project", "./README.md")).toBe(true);
  expect(isUnderCwd("/project", "nested/deep/file.txt")).toBe(true);
});

test("isUnderCwd rejects paths outside cwd", () => {
  expect(isUnderCwd("/project", "../etc/passwd")).toBe(false);
  expect(isUnderCwd("/project", "/etc/passwd")).toBe(false);
  expect(isUnderCwd("/project", "../../root/.ssh/id_rsa")).toBe(false);
});

test("isUnderCwd allows cwd itself", () => {
  expect(isUnderCwd("/project", ".")).toBe(true);
});

// Test manifest structure
test("manifest has required fields", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  expect(manifest.schemaVersion).toBe(4);
  expect(manifest.name).toBe("project-analyzer");
  expect(manifest.author.name).toBe("EZCorp");
  expect(manifest.entrypoint).toBe("./extension.ts");
  expect(manifest.tools).toHaveLength(2);
  expect(manifest.permissions.filesystem).toEqual(["/project", "/data"]);
  expect(manifest.permissions.shell).toBe(false);
  expect(manifest.scripts.postinstall).toBe("./scripts/postinstall.ts");
});

// Test tool definitions
test("tools have valid input schemas", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  const [listFiles, readFile] = manifest.tools;

  expect(listFiles.name).toBe("listFiles");
  expect(listFiles.inputSchema.type).toBe("object");

  expect(readFile.name).toBe("readFile");
  expect(readFile.inputSchema.required).toContain("path");
});

// Test postinstall script exists
test("postinstall script exists", async () => {
  const file = Bun.file(resolve(import.meta.dir, "scripts/postinstall.ts"));
  expect(await file.exists()).toBe(true);
});

const ORIG_FS_ALLOWED = process.env.EZCORP_FS_ALLOWED;

beforeAll(() => {
  // SDK's `ensureFsAllowed` gate reads this env; the stub IS the host, so
  // the gate is satisfied without granting real filesystem permission.
  process.env.EZCORP_FS_ALLOWED = "1";
});

afterAll(() => {
  if (ORIG_FS_ALLOWED === undefined) delete process.env.EZCORP_FS_ALLOWED;
  else process.env.EZCORP_FS_ALLOWED = ORIG_FS_ALLOWED;
});

beforeEach(() => {
  // preload's afterEach drops the channel singleton, so re-install per test.
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((async (
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    if (method === "ezcorp/fs.read") {
      const p = (params ?? {}) as { path: string };
      if (p.path === `${_internals.cwd}/README.md`) {
        const text = "hello from README";
        return { encoding: "utf-8", body: btoa(text), bytes: text.length, resolvedPath: p.path };
      }
      throw new Error(`project-analyzer test stub: unexpected fs.read path ${p.path}`);
    }
    throw new Error(`project-analyzer test stub: unexpected RPC method ${method}`);
  }) as ReturnType<typeof getChannel>["request"]);
});

describe("readFile — dispatch", () => {
  test("reads a file under cwd via the host-mediated fsRead", async () => {
    const res = (await _internals.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "readFile", arguments: { path: "README.md" } },
    })) as JsonRpcResponse;
    expect(res.error).toBeUndefined();
    const content = (res.result as { content: { type: string; text: string }[] }).content;
    expect(content[0]!.text).toBe("hello from README");
  });

  test("rejects a path outside the project", async () => {
    const res = (await _internals.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "readFile", arguments: { path: "../elsewhere" } },
    })) as JsonRpcResponse;
    expect(res.error?.code).toBe(-32000);
    expect(res.error?.message).toContain("outside project directory");
  });

  test("a host fsRead failure is a clean -32000, not a crash", async () => {
    const res = (await _internals.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "readFile", arguments: { path: "missing.ts" } },
    })) as JsonRpcResponse;
    expect(res.error?.code).toBe(-32000);
    expect(res.error?.message).toContain("Failed to read file:");
  });
});

describe("listFiles — dispatch", () => {
  test("lists the project through the filesystem broker", async () => {
    spyOn(getChannel(), "request").mockResolvedValue({ entries: [{ name: "package.json", type: "file" }, { name: "secret.txt", type: "file" }] });
    const res = (await _internals.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "listFiles", arguments: { pattern: "package.json" } },
    })) as JsonRpcResponse;
    expect(res.error).toBeUndefined();
    const content = (res.result as { content: { type: string; text: string }[] }).content;
    expect(content[0]!.text).toContain("package.json");
  });

  test("a filesystem denial is a clean -32000, not a crash", async () => {
    const spy = spyOn(getChannel(), "request").mockRejectedValue(new Error("filesystem unavailable"));
    try {
      const res = (await _internals.handleRequest({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "listFiles", arguments: {} },
      })) as JsonRpcResponse;
      expect(res.error?.code).toBe(-32000);
      expect(res.error?.message).toContain("Failed to list files:");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("registration", () => {
  test("registered handler reads a file and rejects unknown tools without opening stdin", async () => {
    const input = spyOn(Bun.stdin, "stream");
    const registration = spyOn(getChannel(), "onRequest");
    try {
      main();
      expect(input).not.toHaveBeenCalled();
      const handler = registration.mock.calls.find(([method]) => method === "tools/call")?.[1];
      expect(handler).toBeDefined();
      expect(await handler!({ name: "readFile", arguments: { path: "README.md" } })).toEqual({ content: [{ type: "text", text: "hello from README" }], isError: false });
      await expect(handler!({ name: "unknown" })).rejects.toMatchObject({ code: "HANDLER_FAILED", message: "Tool request failed" });
    } finally {
      input.mockRestore();
    }
  });
});
