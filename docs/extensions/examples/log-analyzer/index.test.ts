// log-analyzer had NO tests, so `docs/extensions/examples/*/index.ts`
// (threshold 90) never gated it: the catch-all key only measures files that
// appear in lcov, and nothing imported this one. Same gap file-refactor's
// index.test.ts closed — see that file's header comment. This suite drives
// `handleSearchLogs` through the real dispatcher with a stubbed host
// channel (`ezcorp/fs.read`), and `main()` through a real reader loop, so
// the file is honestly measured rather than silently excluded.

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getChannel } from "@ezcorp/sdk/runtime";
import { _internals, main } from "./index";
import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";

const cwd = _internals.cwd;

const APP_LOG = [
  "2026-01-01T10:00:00 INFO startup complete",
  "2026-01-02T11:00:00 ERROR db connection failed",
  "2026-01-03T12:00:00 WARN slow query",
  "2026-06-01T09:00:00 ERROR disk full",
  "",
  "not a log line",
].join("\n");

const BIG_LOG = Array.from(
  { length: 150 },
  (_, i) => `2026-01-01T00:00:${String(i % 60).padStart(2, "0")} ERROR issue ${i}`,
).join("\n");

const LOGS: Record<string, string> = {
  [`${cwd}/app.log`]: APP_LOG,
  [`${cwd}/big.log`]: BIG_LOG,
  [`${cwd}/empty.log`]: "no matches here at all",
};

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
      const text = LOGS[p.path];
      if (text === undefined) {
        throw new Error("Filesystem access denied: reserved by the EZCorp platform");
      }
      return { encoding: "utf-8", body: btoa(text), bytes: text.length, resolvedPath: p.path };
    }
    throw new Error(`log-analyzer test stub: unexpected RPC method ${method}`);
  }) as ReturnType<typeof getChannel>["request"]);
});

async function searchLogs(args: Record<string, unknown>): Promise<JsonRpcResponse> {
  return _internals.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "search-logs", arguments: args },
  });
}

function text(res: JsonRpcResponse): string {
  return (res.result as { content: { type: string; text: string }[] }).content[0]!.text;
}

describe("search-logs — argument validation", () => {
  test("missing logFile is -32602", async () => {
    const res = await searchLogs({});
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain("logFile");
  });

  test("a path outside the project is -32000", async () => {
    const res = await searchLogs({ logFile: "../elsewhere.log" });
    expect(res.error?.code).toBe(-32000);
    expect(res.error?.message).toContain("outside project directory");
  });
});

describe("search-logs — filters", () => {
  test("no filters returns every non-blank line", async () => {
    const res = await searchLogs({ logFile: "app.log" });
    const t = text(res);
    expect(t).toContain("startup complete");
    // 4 log lines + the trailing "not a log line" (blank lines excluded).
    expect(t).toContain("5 matching entries found.");
  });

  test("level filter narrows to matching entries", async () => {
    const res = await searchLogs({ logFile: "app.log", level: "error" });
    const t = text(res);
    expect(t).toContain("db connection failed");
    expect(t).toContain("disk full");
    expect(t).not.toContain("startup complete");
    expect(t).toContain("2 matching entries found.");
  });

  test("query filter is case-insensitive substring match", async () => {
    const res = await searchLogs({ logFile: "app.log", query: "SLOW" });
    const t = text(res);
    expect(t).toContain("slow query");
    expect(t).toContain("1 matching entries found.");
  });

  test("since filter drops entries before the cutoff", async () => {
    const res = await searchLogs({ logFile: "app.log", level: "error", since: "2026-03-01T00:00:00" });
    const t = text(res);
    expect(t).toContain("disk full");
    expect(t).not.toContain("db connection failed");
  });

  test("no matches reports the empty message", async () => {
    const res = await searchLogs({ logFile: "empty.log", level: "error" });
    expect(text(res)).toBe("No matching log entries found.");
  });

  test("truncates at 100 matches and reports the remainder", async () => {
    const res = await searchLogs({ logFile: "big.log" });
    const t = text(res);
    expect(t).toContain("... and 50 more matches (150 total)");
  });

  test("a fsRead failure (host denial) is a clean -32000, not a crash", async () => {
    const res = await searchLogs({ logFile: "missing.log" });
    expect(res.error?.code).toBe(-32000);
    expect(res.error?.message).toContain("Failed:");
  });
});

describe("dispatch", () => {
  test("an unknown tool name is -32601", async () => {
    const res = await _internals.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    expect(res.error?.code).toBe(-32601);
    expect(res.error?.message).toContain("Unknown tool");
  });

  test("an unknown method is -32601", async () => {
    const res = await _internals.handleRequest({ jsonrpc: "2.0", id: 3, method: "nope/nope" });
    expect(res.error?.code).toBe(-32601);
    expect(res.error?.message).toContain("Unknown method");
  });
});

describe("registration", () => {
  test("registered handler filters logs and rejects unknown tools without opening stdin", async () => {
    const input = spyOn(Bun.stdin, "stream");
    const registration = spyOn(getChannel(), "onRequest");
    try {
      main();
      expect(input).not.toHaveBeenCalled();
      const handler = registration.mock.calls.find(([method]) => method === "tools/call")?.[1];
      expect(handler).toBeDefined();
      expect(await handler!({ name: "search-logs", arguments: { logFile: "app.log", query: "SLOW" } })).toEqual({ content: [{ type: "text", text: expect.stringContaining("1 matching entries found.") }], isError: false });
      await expect(handler!({ name: "unknown" })).rejects.toMatchObject({ code: "HANDLER_FAILED", message: "Tool request failed" });
    } finally {
      input.mockRestore();
    }
  });
});

describe("manifest", () => {
  test("has required fields", async () => {
    const manifest = (await import(import.meta.dir + "/ezcorp.config.ts")).default;
    expect(manifest.schemaVersion).toBe(4);
    expect(manifest.name).toBe("log-analyzer");
    expect(manifest.author.name).toBe("EZCorp");
    expect(manifest.entrypoint).toBe("./extension.ts");
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0].name).toBe("search-logs");
    expect(manifest.permissions.filesystem).toEqual(["/project", "/data"]);
    expect(manifest.permissions.shell).toBe(false);
  });
});
