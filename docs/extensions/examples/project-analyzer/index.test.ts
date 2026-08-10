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
  expect(manifest.schemaVersion).toBe(2);
  expect(manifest.name).toBe("project-analyzer");
  expect(manifest.author.name).toBe("EZCorp");
  expect(manifest.entrypoint).toBe("./index.ts");
  expect(manifest.tools).toHaveLength(2);
  expect(manifest.permissions.filesystem).toEqual(["$CWD"]);
  expect(manifest.permissions.shell).toBe(true);
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
  test("lists the real cwd via Bun.$", async () => {
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

  test("a shell failure is a clean -32000, not a crash", async () => {
    const spy = spyOn(Bun, "$").mockImplementation(() => {
      throw new Error("shell unavailable");
    });
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

describe("main() — the stdin JSON-RPC loop", () => {
  // `writeStdout` in index.ts caches the `Bun.stdout.writer()` instance the
  // FIRST time it's called and reuses it for the rest of the process — see
  // the comment on `writeStdout`. The spy is therefore installed exactly
  // ONCE for this file's test process; writes are routed through a
  // rebindable sink so each test gets its own array.
  const sink = { written: [] as string[] };
  let writerSpy: ReturnType<typeof spyOn>;
  beforeAll(() => {
    writerSpy = spyOn(Bun.stdout, "writer").mockReturnValue({
      write: (s: string) => {
        sink.written.push(s as string);
        return (s as string).length;
      },
      flush: () => Promise.resolve(0),
    } as unknown as ReturnType<typeof Bun.stdout.writer>);
  });
  afterAll(() => {
    writerSpy.mockRestore();
  });

  async function runMain(input: string): Promise<string[]> {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input));
        controller.close();
      },
    });
    const streamSpy = spyOn(Bun.stdin, "stream").mockReturnValue(
      stream as unknown as ReturnType<typeof Bun.stdin.stream>,
    );
    sink.written = [];
    try {
      await main();
    } finally {
      streamSpy.mockRestore();
    }
    return sink.written;
  }

  test("answers a request end-to-end through the real reader loop", async () => {
    const req: JsonRpcRequest = { jsonrpc: "2.0", id: 42, method: "nope/nope" };
    const written = await runMain(JSON.stringify(req) + "\n");
    expect(written).toHaveLength(1);
    const res = JSON.parse(written[0]!.trim()) as JsonRpcResponse;
    expect(res.id).toBe(42);
    expect(res.error!.code).toBe(-32601);
  });
});
