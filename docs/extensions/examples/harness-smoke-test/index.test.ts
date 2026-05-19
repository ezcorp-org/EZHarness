import { test, expect, describe } from "bun:test";
import { handleRequest } from "./index";

describe("harness-smoke-test — ping handler", () => {
  test("ping returns a pretty-printed { ok: true } envelope (smokeTest contract)", () => {
    const res = handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ping", arguments: { message: "hello harness" } },
    });
    expect(res.error).toBeUndefined();
    const result = res.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    const text = result.content[0]!.text;
    // The spec-locked smokeTest asserts textIncludes '"ok": true' —
    // pin the exact pretty-print substring so a formatting regression
    // (compact JSON) is caught here, not just in the e2e.
    expect(text).toContain('"ok": true');
    expect(text).toContain("hello harness");
  });

  test("ping with no message echoes empty string", () => {
    const res = handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    });
    const result = res.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('"echo": ""');
  });

  test("unknown tool ⇒ -32601 error", () => {
    const res = handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    expect(res.error?.code).toBe(-32601);
    expect(res.error?.message).toContain("Unknown tool: nope");
  });

  test("unknown method ⇒ -32601 error", () => {
    const res = handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "resources/list",
    });
    expect(res.error?.code).toBe(-32601);
    expect(res.error?.message).toContain("Unknown method");
  });
});
