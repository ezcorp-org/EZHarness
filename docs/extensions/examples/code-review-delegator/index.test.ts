import { afterAll, beforeAll, beforeEach, describe, test, expect, spyOn } from "bun:test";
import { _internals, main } from "./index";
import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";

// index.ts is now safely importable (main()'s stdin loop is gated on
// `import.meta.main` — see the "Production wiring" comment there), so these
// drive the real `_internals.buildRecommendations` instead of a duplicate
// reimplementation that could silently drift from it.
function buildReview(filePath: string, fileContent: string, qualityText: string) {
  return {
    filePath,
    summary: { lines: fileContent.split("\n").length, sizeBytes: fileContent.length },
    qualityAnalysis: qualityText,
    recommendations: _internals.buildRecommendations(fileContent, qualityText),
  };
}

test("builds review with file summary and quality analysis", () => {
  const review = buildReview("src/app.ts", "line1\nline2\nline3", '{"issues":[],"count":0}');
  expect(review.filePath).toBe("src/app.ts");
  expect(review.summary.lines).toBe(3);
  expect(review.qualityAnalysis).toBe('{"issues":[],"count":0}');
});

test("recommends splitting large files", () => {
  const content = Array(301).fill("line").join("\n");
  const recs = _internals.buildRecommendations(content, '{"issues":[]}');
  expect(recs).toContain("Consider splitting this file into smaller modules");
});

test("recommends addressing TODOs", () => {
  const recs = _internals.buildRecommendations("// TODO: fix\ncode", '{"issues":[]}');
  expect(recs).toContain("Address outstanding TODO/FIXME comments");
});

test("handles unavailable quality analysis", () => {
  const review = buildReview("test.ts", "code", "Analysis unavailable");
  expect(review.qualityAnalysis).toBe("Analysis unavailable");
  expect(review.recommendations).not.toContain("Review quality issues listed above");
});

test("manifest has both dependencies", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  expect(manifest.dependencies["project-analyzer"]).toBeDefined();
  expect(manifest.dependencies["code-quality"]).toBeDefined();
  expect(manifest.agent.category).toBe("Development");
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

describe("reviewFile — invoke round-trip", () => {
  test("a readFile error is forwarded as the tool error, without a second invoke", async () => {
    const req: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} };
    const promise = _internals.reviewFile(req, "src/app.ts");

    const readFrame = JSON.parse(sink.written[0]!.trim());
    expect(readFrame.params.tool).toBe("project-analyzer.readFile");
    resolveInvoke(0, { id: readFrame.id, error: { code: -32000, message: "read denied" } });
    await promise;

    expect(sink.written).toHaveLength(2);
    const errorRes = JSON.parse(sink.written[1]!.trim());
    expect(errorRes.error.message).toBe("read denied");
  });

  test("success chains project-analyzer + code-quality and writes the final review", async () => {
    const req: JsonRpcRequest = { jsonrpc: "2.0", id: 2, method: "tools/call", params: {} };
    const promise = _internals.reviewFile(req, "src/app.ts");

    const readFrame = JSON.parse(sink.written[0]!.trim());
    resolveInvoke(0, {
      id: readFrame.id,
      result: { content: [{ type: "text", text: "line1\nline2\n// TODO fix" }] },
    });

    // reviewFile's second `await invoke(...)` (code-quality.analyzeFile) is
    // written once the microtask resuming that await has run.
    await Bun.sleep(0);
    const qualityFrame = JSON.parse(sink.written[1]!.trim());
    expect(qualityFrame.params.tool).toBe("code-quality.analyzeFile");
    resolveInvoke(1, {
      id: qualityFrame.id,
      result: { content: [{ type: "text", text: '{"issueCount":0}' }] },
    });
    await promise;

    expect(sink.written).toHaveLength(3);
    const reviewRes = JSON.parse(sink.written[2]!.trim());
    const review = JSON.parse(reviewRes.result.content[0].text);
    expect(review.filePath).toBe("src/app.ts");
    expect(review.qualityAnalysis).toBe('{"issueCount":0}');
    expect(review.recommendations).toContain("Address outstanding TODO/FIXME comments");
  });
});

describe("dispatch", () => {
  test("an unknown tool name answers -32601 directly (no invoke)", () => {
    _internals.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    expect(sink.written).toHaveLength(1);
    const res = JSON.parse(sink.written[0]!.trim());
    expect(res.error.code).toBe(-32601);
    expect(res.error.message).toContain("Unknown tool");
  });

  test("an unknown method answers -32601 directly", () => {
    _internals.handleRequest({ jsonrpc: "2.0", id: 4, method: "nope/nope" });
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
    await runMain(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "nope/nope" }) + "\n");
    expect(sink.written).toHaveLength(1);
    const res = JSON.parse(sink.written[0]!.trim());
    expect(res.id).toBe(5);
    expect(res.error.code).toBe(-32601);
  });

  test("a malformed line is swallowed, not thrown", () => {
    _internals.handleLine("{not json");
    expect(sink.written).toHaveLength(0);
  });
});
