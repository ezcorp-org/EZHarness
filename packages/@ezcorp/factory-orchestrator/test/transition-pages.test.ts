import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import { persistTransition, splitTransitionContent } from "../src/transition-pages.ts";

const digest = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
const identity = { tenantId: "tenant", projectId: "project", logicalRunId: "run", interpreterId: "interpreter" };

function writer(overrides = {}) {
  const contents: string[] = [];
  const records = [];
  return {
    contents,
    records,
    async stageTransitionPage(request) {
      contents[request.index] = request.content;
      return { index: request.index, objectId: `page-${request.index}`, digest: digest(request.content), encodedBytes: request.encodedBytes };
    },
    async finalizeTransitionArtifact(request) {
      const artifact = JSON.parse(contents.join(""));
      assert.equal(request.encodedBytes, new TextEncoder().encode(contents.join("")).byteLength);
      assert.equal(request.eventId, artifact.event.id);
      const eventHash = digest(canonicalizeJson(artifact.event));
      if (request.expectedEventHash !== undefined) assert.equal(request.expectedEventHash, eventHash);
      return { manifest: { objectId: "transition-manifest", digest: digest(contents.join("")), encodedBytes: 512 }, eventHash };
    },
    async recordTransition(record) { records.push(record); },
    ...overrides,
  };
}

describe("transition paging", () => {
  it("splits UTF-8 content into exact bounded pages", () => {
    assert.deepEqual(splitTransitionContent(""), [""]);
    const content = `start-${"🙂".repeat(20_000)}-end`;
    const pages = splitTransitionContent(content);
    assert.equal(pages.join(""), content);
    assert.ok(pages.length > 2);
    assert.ok(pages.every((page) => new TextEncoder().encode(page).byteLength <= 32 * 1024));
  });

  it("finalizes immutable pages and commits the compact exact inbox identity", async () => {
    const event = { kind: "cancel", id: "decision-1", atMs: 4, reason: "🙂".repeat(18_000) };
    const eventHash = digest(canonicalizeJson(event));
    const sink = writer();
    await persistTransition(identity, 9, event, {
      logicalRunId: "run", definitionDigest: digest("definition"), input: {}, status: "cancelled", runDeadlineAtMs: 10, nowMs: 4,
      cancellationEpoch: 1, commandCounter: 0, eventSequence: 9, spentCostMicros: "0", unknownCostMicros: "0", usageSettlements: {}, nodes: {}, scopes: {}, appliedEventIds: [event.id], unresolvedUncertainNodeIds: [],
    }, [], { sequence: 7, eventId: event.id, eventHash }, sink);
    assert.ok(sink.contents.length > 2);
    assert.deepEqual(sink.records, [{ ...identity, sourceSequence: 9, eventId: event.id, eventHash, inboxSequence: 7, artifactManifest: { objectId: "transition-manifest", digest: digest(sink.contents.join("")), encodedBytes: 512 } }]);
  });

  it("rejects a mismatched page receipt, event digest, or inbox ID before audit", async () => {
    const event = { kind: "cancel", id: "decision-1", atMs: 4, reason: "stop" };
    const state = { logicalRunId: "run", definitionDigest: digest("definition"), input: {}, status: "cancelled", runDeadlineAtMs: 10, nowMs: 4, cancellationEpoch: 1, commandCounter: 0, eventSequence: 1, spentCostMicros: "0", unknownCostMicros: "0", usageSettlements: {}, nodes: {}, scopes: {}, appliedEventIds: [event.id], unresolvedUncertainNodeIds: [] };
    await assert.rejects(persistTransition(identity, 1, event, state, [], undefined, writer({ stageTransitionPage: async () => ({ index: 2, objectId: "wrong", digest: digest("wrong"), encodedBytes: 1 }) })), /does not match staged content/);
    await assert.rejects(persistTransition(identity, 1, event, state, [], undefined, writer({ finalizeTransitionArtifact: async () => ({ manifest: { objectId: "manifest", digest: digest("manifest"), encodedBytes: 1 }, eventHash: "wrong" }) })), /invalid event digest/);
    const eventHash = digest(canonicalizeJson(event));
    await assert.rejects(persistTransition(identity, 1, event, state, [], { sequence: 1, eventId: "other", eventHash }, writer()), /did not preserve/);
  });
});
