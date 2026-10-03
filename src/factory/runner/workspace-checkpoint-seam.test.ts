import { expect, test } from "bun:test";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { JsonValue } from "@ezcorp/extension-contract";
import type { FactoryCheckpointReference } from "@ezcorp/factory-sdk";
import type { FactoryWorkspaceCheckpoint } from "./supervisor";

/**
 * Pins the seam against the type a real checkpoint writer returns.
 *
 * `FactoryCheckpointReference` is a declared interface, and an interface never
 * gains `JsonValue`'s implicit index signature, because declaration merging
 * could widen it later. So a seam typed `Promise<JsonValue>` rejects every real
 * implementer while still compiling on its own, and the mismatch appears only
 * where the two branches meet. The explicit return annotation below is the
 * guard: re-widening the seam breaks this file's typecheck, not integration's.
 */
const writer: FactoryWorkspaceCheckpoint = {
  async checkpoint(input): Promise<FactoryCheckpointReference> {
    return { artifactId: `checkpoint-${input.operationIndex}`, digest: `sha256:${"c".repeat(64)}`, encodedBytes: 96, journalCursor: input.operationIndex };
  },
};

const attempt = { attemptId: "attempt-seam", tenantId: "tenant-seam", projectId: "project-seam", runId: "run-seam", nodeInstanceId: "node-seam" } as unknown as Parameters<FactoryWorkspaceCheckpoint["checkpoint"]>[0]["attempt"];

test("a writer returning the SDK checkpoint reference satisfies the seam and its cursor tracks the operation", async () => {
  const first = await writer.checkpoint({ operationId: "run:node:0:0", operationIndex: 0, attempt, result: { text: "first" } });
  const second = await writer.checkpoint({ operationId: "run:node:0:3", operationIndex: 3, attempt, result: { text: "second" } });
  // A completed operation's checkpoint cursor must equal its operation index;
  // validateFactoryRunnerResult rejects the result otherwise.
  expect(first.journalCursor).toBe(0);
  expect(second.journalCursor).toBe(3);
  expect(second.artifactId).not.toBe(first.artifactId);
});

test("the reference survives the canonical copy the journal makes before storing it", async () => {
  const reference = await writer.checkpoint({ operationId: "run:node:0:2", operationIndex: 2, attempt, result: null });
  const stored = JSON.parse(canonicalJson(reference as unknown as JsonValue)) as FactoryCheckpointReference;
  expect(stored).toEqual(reference);
  expect(Object.keys(stored).sort()).toEqual(["artifactId", "digest", "encodedBytes", "journalCursor"]);
});
