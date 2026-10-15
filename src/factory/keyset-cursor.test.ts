import { describe, expect, test } from "bun:test";
import { decodeFactoryKeyset, encodeFactoryKeyset } from "./keyset-cursor";

describe("factory keyset cursors", () => {
  test("a position round-trips exactly", () => {
    const cursor = encodeFactoryKeyset(["node-a", 3, "attempt/1"]);
    expect(decodeFactoryKeyset(cursor, 3)).toEqual(["node-a", 3, "attempt/1"]);
  });

  test("a malformed, oversized, non-canonical, or wrongly shaped cursor is refused, never partly used", () => {
    const valid = encodeFactoryKeyset(["a"]);
    for (const [cursor, arity] of [
      ["", 1], ["x".repeat(2_049), 1], ["%%%", 1], [Buffer.from("not json").toString("base64url"), 1],
      [encodeFactoryKeyset(["a", "b"]), 1], [Buffer.from(JSON.stringify({ a: 1 })).toString("base64url"), 1],
      [Buffer.from(JSON.stringify([1.5])).toString("base64url"), 1], [Buffer.from(JSON.stringify([null])).toString("base64url"), 1],
      [Buffer.from(' ["a"]').toString("base64url"), 1], [`${valid}=`, 1],
    ] as const) expect(decodeFactoryKeyset(cursor, arity)).toBeNull();
  });
});
