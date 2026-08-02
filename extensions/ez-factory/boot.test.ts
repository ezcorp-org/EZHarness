/**
 * ez-factory — production-wiring coverage for the subprocess entrypoint.
 *
 * `lib/tools/*.test.ts` drive the tools against an in-memory `FactoryFs`,
 * which by construction never executes the REAL adapter in `index.ts` —
 * the binding between the tools and the host's reverse-RPC. That adapter
 * is this extension's contract with the host, and a rename or a dropped
 * option there is a silent production break no fake-fs test can see. So it
 * is covered here IN-process, the same shape as
 * `extensions/lessons-distiller/boot.test.ts` and
 * `extensions/memory-extractor/boot.test.ts`:
 *
 *   - `mock.module("@ezcorp/sdk/runtime", …)` BEFORE importing `./index`
 *     spreads the REAL module and replaces only the `fs*` helpers with
 *     recorders, so `toolResult` / `toolError` stay real.
 *   - `getChannel` / `createToolDispatcher` are inert spies, so `start()`
 *     runs without opening stdin.
 *
 * `restoreModuleMocks()` in `afterAll` hands the real module back.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../../src/__tests__/helpers/mock-cleanup";
import * as realRuntime from "@ezcorp/sdk/runtime";

afterAll(() => {
  restoreModuleMocks();
});

interface RpcCall {
  method: string;
  args: unknown[];
}
let rpc: RpcCall[] = [];
let registered: Record<string, unknown> | null = null;
let channelStarted = false;
let toolContext: { projectRoot?: string } | undefined;
let readReturnsBinary = false;

const record = (method: string, ...args: unknown[]): void => {
  rpc.push({ method, args });
};

mock.module("@ezcorp/sdk/runtime", () => ({
  ...realRuntime,
  createToolDispatcher: (handlers: Record<string, unknown>) => {
    registered = handlers;
  },
  getChannel: () => ({
    start: () => {
      channelStarted = true;
    },
  }),
  getToolContext: () => toolContext,
  fsList: async (path: string) => {
    record("fsList", path);
    return [{ name: "a.md", isFile: true, isDirectory: false }];
  },
  fsStat: async (path: string) => {
    record("fsStat", path);
    return { size: 5, mtimeMs: 0, isFile: true, isDirectory: false, resolvedPath: path };
  },
  fsRead: async (path: string, opts?: { encoding?: string }) => {
    record("fsRead", path, opts);
    return readReturnsBinary ? new TextEncoder().encode("hello") : "hello";
  },
  fsWrite: async (path: string, content: string) => {
    record("fsWrite", path, content);
    return { bytes: content.length, resolvedPath: path };
  },
  fsMkdir: async (path: string, opts?: { recursive?: boolean }) => {
    record("fsMkdir", path, opts);
    return { resolvedPath: path };
  },
  fsExists: async (path: string) => {
    record("fsExists", path);
    return false;
  },
}));

const { activeProjectRoot, deps, hostFs, start } = await import("./index");

beforeEach(() => {
  rpc = [];
  registered = null;
  channelStarted = false;
  toolContext = { projectRoot: "/active-project" };
  readReturnsBinary = false;
});

describe("boot", () => {
  test("registers the three tools and starts the channel", () => {
    start();
    expect(Object.keys(registered ?? {}).sort()).toEqual(
      ["emit_artifact", "read_files", "write_file"].sort(),
    );
    expect(channelStarted).toBe(true);
  });

  test("the registered handlers are live against the real host adapter", async () => {
    start();
    const readFiles = registered?.["read_files"] as (
      args: unknown,
    ) => Promise<{ isError: boolean; content: Array<{ text: string }> }>;

    const result = await readFiles({ globs: ["**/*.md"] });

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      files: Array<{ path: string; content: string }>;
    };
    expect(payload.files.map((f) => f.path)).toEqual(["a.md"]);
    // The sanitizer ran on the real path, not just in the unit tests.
    expect(payload.files[0]?.content).toContain("-----BEGIN UNTRUSTED INPUT-----");
    expect(rpc.map((c) => c.method)).toEqual(["fsList", "fsStat", "fsRead"]);
  });
});

describe("the host-mediated fs adapter", () => {
  test("list forwards the path", async () => {
    await hostFs.list("/p/dir");
    expect(rpc).toEqual([{ method: "fsList", args: ["/p/dir"] }]);
  });

  test("stat projects only the size the tools need", async () => {
    expect(await hostFs.stat("/p/a.md")).toEqual({ size: 5 });
  });

  test("read asks for utf-8 and returns a string", async () => {
    expect(await hostFs.read("/p/a.md")).toBe("hello");
    expect(rpc[0]).toEqual({ method: "fsRead", args: ["/p/a.md", { encoding: "utf-8" }] });
  });

  test("read decodes a Uint8Array rather than casting it", async () => {
    // `fsRead` is typed `string | Uint8Array` because the same RPC serves
    // binary reads. A cast would put "[object Uint8Array]" into an agent
    // prompt.
    readReturnsBinary = true;
    expect(await hostFs.read("/p/a.md")).toBe("hello");
  });

  test("write reports the host's byte count", async () => {
    expect(await hostFs.write("/p/a.md", "abc")).toEqual({ bytes: 3 });
    expect(rpc).toEqual([{ method: "fsWrite", args: ["/p/a.md", "abc"] }]);
  });

  test("mkdir is recursive — a run's artifact directory has no parent yet", async () => {
    await hostFs.mkdir("/p/deep/dir");
    expect(rpc).toEqual([{ method: "fsMkdir", args: ["/p/deep/dir", { recursive: true }] }]);
  });

  test("exists forwards the path", async () => {
    expect(await hostFs.exists("/p/a.md")).toBe(false);
    expect(rpc).toEqual([{ method: "fsExists", args: ["/p/a.md"] }]);
  });
});

describe("activeProjectRoot", () => {
  test("prefers the per-call tool context", () => {
    // One persistent subprocess serves every conversation, so a
    // process-wide env var names only ever ONE project.
    toolContext = { projectRoot: "/active-project" };
    expect(activeProjectRoot()).toBe("/active-project");
    expect(deps.projectRoot()).toBe("/active-project");
  });

  test("falls back to EZCORP_PROJECT_ROOT for an out-of-band dispatch", () => {
    // A workflow tool step carries a synthetic conversation with no
    // project to resolve, so this is the branch that actually runs there.
    toolContext = undefined;
    const previous = process.env.EZCORP_PROJECT_ROOT;
    process.env.EZCORP_PROJECT_ROOT = "/env-project";
    try {
      expect(activeProjectRoot()).toBe("/env-project");
    } finally {
      if (previous === undefined) delete process.env.EZCORP_PROJECT_ROOT;
      else process.env.EZCORP_PROJECT_ROOT = previous;
    }
  });

  test("falls back to the process cwd as a last resort", () => {
    toolContext = undefined;
    const previous = process.env.EZCORP_PROJECT_ROOT;
    delete process.env.EZCORP_PROJECT_ROOT;
    try {
      expect(activeProjectRoot()).toBe(process.cwd());
    } finally {
      if (previous !== undefined) process.env.EZCORP_PROJECT_ROOT = previous;
    }
  });
});
