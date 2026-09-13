import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertContinuationSize, validateInboxEvent, validateWorkflowInput } from "../src/validation.ts";

const factory = { digest: "sha256:test", partitions: [] };
const valid = { tenantId: "tenant", projectId: "project", logicalRunId: "run", interpreterId: "build", startedAtMs: 1, factory, input: {} };

describe("orchestrator boundary validation", () => {
  it("accepts bounded workflow identities and partitions", () => assert.doesNotThrow(() => validateWorkflowInput(valid)));
  it("rejects missing, oversized, and invalid workflow fields", () => {
    for (const field of ["tenantId", "projectId", "logicalRunId", "interpreterId"]) {
      assert.throws(() => validateWorkflowInput({ ...valid, [field]: "" }), /1 to 512/);
      assert.throws(() => validateWorkflowInput({ ...valid, [field]: "x".repeat(513) }), /1 to 512/);
    }
    assert.throws(() => validateWorkflowInput({ ...valid, startedAtMs: -1 }), /timestamp/);
    assert.throws(() => validateWorkflowInput({ ...valid, startedAtMs: 1.5 }), /timestamp/);
    assert.throws(() => validateWorkflowInput({ ...valid, factory: { ...factory, partitions: [{ nodeIds: Array(129).fill("x") }] } }), /128 nodes/);
    assert.throws(() => validateWorkflowInput({ ...valid, continuation: { state: { definitionDigest: "sha256:other" } } }), /digest/);
  });
  it("requires stable, recorded inbox events", () => {
    assert.doesNotThrow(() => validateInboxEvent({ id: "event", atMs: 1, kind: "cancel", reason: "test" }));
    for (const value of [null, [], 1]) assert.throws(() => validateInboxEvent(value), /object/);
    for (const id of [undefined, "", "x".repeat(513)]) assert.throws(() => validateInboxEvent({ id, atMs: 1, kind: "cancel" }), /stable ID/);
    for (const atMs of [undefined, -1, 1.5]) assert.throws(() => validateInboxEvent({ id: "event", atMs, kind: "cancel" }), /timestamp/);
    assert.throws(() => validateInboxEvent({ id: "event", atMs: 1 }), /kind/);
  });
  it("rejects continuation snapshots larger than 64 KiB", () => {
    assert.doesNotThrow(() => assertContinuationSize({ state: {}, inbox: [], sourceSequence: 1, handledSinceContinuation: 0 }));
    assert.throws(() => assertContinuationSize({ state: { value: "x".repeat(70_000) }, inbox: [], sourceSequence: 1, handledSinceContinuation: 0 }), /65536 bytes/);
  });
});
