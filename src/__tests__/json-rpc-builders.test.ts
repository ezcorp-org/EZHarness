/**
 * Helper-level unit tests for the `rpcError` / `rpcResult` builders
 * extracted to `src/extensions/json-rpc.ts`.
 *
 * The transport tests in `json-rpc.test.ts` cover framing/buffering and
 * never poke at the response builders directly. The previous duplicates
 * lived inline in `storage-handler.ts`, `event-emit-handler.ts`,
 * `agent-config-handler.ts` etc. — every call site copied the
 * `{ jsonrpc: "2.0", id, error: {...} }` literal. These tests pin:
 *   - the JSON-RPC 2.0 envelope shape
 *   - `id` passthrough across number, string, zero
 *   - the optional `data` field (must be absent when undefined; present
 *     for any defined value including `null`)
 *   - `result` passthrough for primitive, object, null, undefined
 *   - immutability: each call returns a fresh object
 */

import { describe, expect, test } from "bun:test";
import { rpcError, rpcResult } from "../extensions/json-rpc";

describe("rpcError — envelope shape", () => {
  test("returns a JSON-RPC 2.0 envelope with code + message, no `result` field", () => {
    const out = rpcError(1, -32602, "Invalid params");
    expect(out).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "Invalid params" },
    });
    expect("result" in out).toBe(false);
  });

  test("`data` is OMITTED when undefined (3-arg call)", () => {
    const out = rpcError(1, -32602, "bad");
    expect("data" in (out.error ?? {})).toBe(false);
  });

  test("`data` is INCLUDED when defined — supports object, array, primitive", () => {
    const objCase = rpcError(1, -32004, "Rate limited", { retryAfter: 5 });
    expect(objCase.error?.data).toEqual({ retryAfter: 5 });

    const arrCase = rpcError(1, -32004, "x", [1, 2, 3]);
    expect(arrCase.error?.data).toEqual([1, 2, 3]);

    const strCase = rpcError(1, -32004, "x", "extra");
    expect(strCase.error?.data).toBe("extra");
  });

  test("`data: null` IS included — only `=== undefined` filters the field", () => {
    // Pins the difference between the conditional spread `(data !== undefined)`
    // and a truthy check. A caller passing null is asserting "the data is
    // explicitly null" and we must round-trip that.
    const out = rpcError(1, -32602, "x", null);
    expect(out.error).toBeDefined();
    expect("data" in (out.error ?? {})).toBe(true);
    expect(out.error?.data).toBeNull();
  });
});

describe("rpcError — id passthrough", () => {
  test("number id is preserved (incl. 0 — falsy but valid)", () => {
    expect(rpcError(0, -1, "x").id).toBe(0);
    expect(rpcError(42, -1, "x").id).toBe(42);
  });

  test("string id is preserved verbatim", () => {
    expect(rpcError("req-abc", -1, "x").id).toBe("req-abc");
    expect(rpcError("", -1, "x").id).toBe("");
  });
});

describe("rpcResult — envelope shape", () => {
  test("returns a JSON-RPC 2.0 envelope with `result`, no `error` field", () => {
    const out = rpcResult(1, "ok");
    expect(out).toEqual({ jsonrpc: "2.0", id: 1, result: "ok" });
    expect("error" in out).toBe(false);
  });

  test("`result` carries primitives verbatim — including null + 0 + ''", () => {
    expect(rpcResult(1, null).result).toBeNull();
    expect(rpcResult(1, 0).result).toBe(0);
    expect(rpcResult(1, "").result).toBe("");
    expect(rpcResult(1, false).result).toBe(false);
  });

  test("`result` carries objects + arrays by reference (no defensive clone)", () => {
    // The builders never clone — pin that, so callers know mutating the
    // returned object's `result` mutates the original.
    const payload = { a: 1, nested: { b: 2 } };
    const out = rpcResult(1, payload);
    expect(out.result).toBe(payload);
  });

  test("`result: undefined` is still set on the envelope (NOT filtered)", () => {
    // Unlike rpcError's `data`, the builder for rpcResult does not
    // conditionally spread — it always sets the field. Pin that
    // contract.
    const out = rpcResult(1, undefined);
    expect("result" in out).toBe(true);
    expect(out.result).toBeUndefined();
  });
});

describe("rpcError / rpcResult — immutability", () => {
  test("each call returns a fresh object — no shared module-level instance", () => {
    const a = rpcError(1, -1, "x");
    const b = rpcError(1, -1, "x");
    expect(a).not.toBe(b);
    expect(a.error).not.toBe(b.error);

    const r1 = rpcResult(1, { v: 1 });
    const r2 = rpcResult(1, { v: 1 });
    expect(r1).not.toBe(r2);
  });
});
