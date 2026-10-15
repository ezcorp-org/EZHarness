import { expect, test } from "bun:test";
import type { MigrationDb } from "../db/migrations/types";
import { readAttemptSupersessionInTransaction } from "./attempt-supersessions";

test("a supersession whose store hands the kernel event back as JSON text is read as the same event", async () => {
  const event = { kind: "attempt-stopped", id: "restore-1:attempt-1:superseded", atMs: 1, nodeId: "node", commandId: "attempt-1", candidateGeneration: 0, attempt: 1, uncertain: true } as const;
  const transaction = { execute: async () => [{ project_id: "project-1", run_id: "run-1", attempt_id: "attempt-1", interpreter_id: "root", restore_id: "restore-1", restore_digest: `sha256:${"c".repeat(64)}`, event_json: JSON.stringify(event) }] } as unknown as MigrationDb;
  expect(await readAttemptSupersessionInTransaction(transaction, "tenant-1", "reservation-1")).toEqual({
    projectId: "project-1", runId: "run-1", attemptId: "attempt-1", interpreterId: "root", restoreId: "restore-1", restoreDigest: `sha256:${"c".repeat(64)}`, event,
  });
});
