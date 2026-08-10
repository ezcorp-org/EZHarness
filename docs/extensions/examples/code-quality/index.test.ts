import { afterAll, beforeAll, beforeEach, test, expect, describe, spyOn } from "bun:test";
import manifest from "./ezcorp.config";
import { _internals, main } from "./index";
import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";

describe("code-quality", () => {
  test("manifest has required fields", () => {
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.name).toBe("code-quality");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.author.name).toBe("EZCorp");
  });

  test("declares two tools", () => {
    expect(manifest.tools).toHaveLength(2);
    expect(manifest.tools?.[0]?.name).toBe("analyzeFile");
    expect(manifest.tools?.[1]?.name).toBe("analyzeDirectory");
  });

  test("has entrypoint", () => {
    expect(manifest.entrypoint).toBe("./index.ts");
  });

  test("declares preuninstall script", () => {
    expect(manifest.scripts?.preuninstall).toBe("./scripts/preuninstall.ts");
  });

  test("depends on project-analyzer", () => {
    expect(manifest.dependencies?.["project-analyzer"]).toBeDefined();
    expect(manifest.dependencies?.["project-analyzer"].version).toBe("^1.0.0");
  });
});

// `writeStdout` in index.ts caches the `Bun.stdout.writer()` instance the
// FIRST time it's called and reuses it for the rest of the process — see
// the comment on `writeStdout`. The spy is therefore installed exactly ONCE
// for this file's test process; writes are routed through a rebindable
// sink so each test gets its own array.
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
beforeEach(() => {
  sink.written = [];
});

function req(id: number, name: string, args: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/** Pull the outbound `ezcorp/invoke` frame a handler just wrote (invoke()'s
 *  write is synchronous — see index.ts) and feed a matching response back
 *  through `handleLine`, the same path a real response line takes off
 *  stdin — not by poking `pendingInvokes` directly, so the "this is a
 *  response to a pending invoke" branch is actually exercised. */
function resolveInvoke(index: number, response: Omit<JsonRpcResponse, "jsonrpc">): void {
  const frame = JSON.parse(sink.written[index]!.trim());
  expect(_internals.pendingInvokes.has(frame.id)).toBe(true);
  _internals.handleLine(JSON.stringify({ jsonrpc: "2.0", ...response }));
}

describe("handleAnalyzeFile — invoke round-trip", () => {
  test("success: reads via project-analyzer, then reports quality issues", async () => {
    const promise = _internals.handleAnalyzeFile(req(1, "analyzeFile", {}), "src/app.ts");
    const invokeFrame = JSON.parse(sink.written[0]!.trim());
    expect(invokeFrame.method).toBe("ezcorp/invoke");
    expect(invokeFrame.params.tool).toBe("project-analyzer.readFile");

    resolveInvoke(0, {
      id: invokeFrame.id,
      result: { content: [{ type: "text", text: "line 1\n// TODO fix this\n" }] },
    });
    await promise;

    const report = JSON.parse(sink.written[1]!.trim());
    const parsed = JSON.parse(report.result.content[0].text);
    expect(parsed.filePath).toBe("src/app.ts");
    expect(parsed.issueCount).toBeGreaterThan(0);
  });

  test("error: a readFile failure is forwarded as the tool error", async () => {
    const promise = _internals.handleAnalyzeFile(req(2, "analyzeFile", {}), "src/app.ts");
    const invokeFrame = JSON.parse(sink.written[0]!.trim());
    resolveInvoke(0, { id: invokeFrame.id, error: { code: -32000, message: "denied" } });
    await promise;

    const errorRes = JSON.parse(sink.written[1]!.trim());
    expect(errorRes.error.message).toBe("denied");
  });
});

describe("handleAnalyzeDirectory — invoke round-trip", () => {
  test("success: lists via project-analyzer, then filters by extension", async () => {
    const promise = _internals.handleAnalyzeDirectory(req(3, "analyzeDirectory", {}), "src", "ts");
    const invokeFrame = JSON.parse(sink.written[0]!.trim());
    expect(invokeFrame.params.tool).toBe("project-analyzer.listFiles");

    resolveInvoke(0, {
      id: invokeFrame.id,
      result: { content: [{ type: "text", text: "src/a.ts\nsrc/b.js\nsrc/c.ts" }] },
    });
    await promise;

    const report = JSON.parse(sink.written[1]!.trim());
    const parsed = JSON.parse(report.result.content[0].text);
    expect(parsed.filesAnalyzed).toBe(2);
  });

  test("error: a listFiles failure is forwarded as the tool error", async () => {
    const promise = _internals.handleAnalyzeDirectory(req(4, "analyzeDirectory", {}), "src", "");
    const invokeFrame = JSON.parse(sink.written[0]!.trim());
    resolveInvoke(0, { id: invokeFrame.id, error: { code: -32000, message: "listFiles denied" } });
    await promise;

    const errorRes = JSON.parse(sink.written[1]!.trim());
    expect(errorRes.error.message).toBe("listFiles denied");
  });
});

describe("dispatch", () => {
  test("an unknown tool name answers -32601 directly (no invoke)", () => {
    _internals.handleRequest(req(5, "nope", {}));
    expect(sink.written).toHaveLength(1);
    const res = JSON.parse(sink.written[0]!.trim());
    expect(res.error.code).toBe(-32601);
    expect(res.error.message).toContain("Unknown tool");
  });

  test("an unknown method answers -32601 directly", () => {
    _internals.handleRequest({ jsonrpc: "2.0", id: 6, method: "nope/nope" });
    expect(sink.written).toHaveLength(1);
    const res = JSON.parse(sink.written[0]!.trim());
    expect(res.error.code).toBe(-32601);
    expect(res.error.message).toContain("Unknown method");
  });
});

describe("main() — the stdin JSON-RPC loop", () => {
  async function runMain(input: string): Promise<void> {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input));
        controller.close();
      },
    });
    const streamSpy = spyOn(Bun.stdin, "stream").mockReturnValue(
      stream as unknown as ReturnType<typeof Bun.stdin.stream>,
    );
    try {
      await main();
    } finally {
      streamSpy.mockRestore();
    }
  }

  test("an unknown-method line is answered through the real reader loop", async () => {
    await runMain(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "nope/nope" }) + "\n");
    expect(sink.written).toHaveLength(1);
    const res = JSON.parse(sink.written[0]!.trim());
    expect(res.id).toBe(7);
    expect(res.error.code).toBe(-32601);
  });

  test("a malformed line is swallowed, not thrown", () => {
    _internals.handleLine("{not json");
    expect(sink.written).toHaveLength(0);
  });
});
