import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptFactoryInbox } from "../src/inbox.ts";

const digest = (character) => `sha256:${character.repeat(64)}`;
const delivery = (sequence, id = `event-${sequence}`, eventHash = digest("a")) => ({
  sequence, eventId: id, eventHash, event: { kind: "repair", id, atMs: 1, nodeId: "node", reason: "test" },
});

describe("factory product inbox", () => {
  it("accepts a bounded future delivery and ignores acknowledged or exact duplicate input", () => {
    const pending = new Map();
    const first = delivery(1);
    assert.deepEqual(acceptFactoryInbox(first, 0, pending), { accepted: first, overflow: false });
    assert.deepEqual(acceptFactoryInbox(first, 0, pending), { overflow: false });
    assert.deepEqual(acceptFactoryInbox(first, 1, new Map()), { overflow: false });
  });

  it("rejects malformed, sequence-conflicting, and hash-conflicting input", () => {
    assert.match(acceptFactoryInbox(null, 0, new Map()).error, /object/);
    const pending = new Map([[2, delivery(2, "first", digest("a"))]]);
    assert.match(acceptFactoryInbox(delivery(2, "second", digest("b")), 0, pending).error, /sequence/);
    assert.match(acceptFactoryInbox(delivery(3, "first", digest("b")), 0, pending).error, /hashes/);
  });

  it("rejects a window gap and a full distinct-decision window", () => {
    assert.deepEqual(acceptFactoryInbox(delivery(129), 0, new Map()), { overflow: true });
    const full = new Map(Array.from({ length: 128 }, (_, index) => [index + 1, delivery(index + 1)]));
    assert.deepEqual(acceptFactoryInbox(delivery(128), 0, full), { overflow: false });
    assert.deepEqual(acceptFactoryInbox(delivery(129), 0, full), { overflow: true });
  });
});
