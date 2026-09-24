/** Child of the cross-process checkpoint test. It opens the same database afresh. */
import { createInterface } from "node:readline";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { IncusQualificationCheckpointStore, currentProcessIdentity,
  processIdentityKey, type SignedRestartHandoff } from "../incus-qualification-checkpoint";
import { checkpointTestHandle, checkpointTestObservation, checkpointTestScope }
  from "./incus-qualification-checkpoint-test-observation";
import type { RecoveryObservation } from "../incus-live-recovery-probes";

const [mode, directory, runId, nonce, deadline] = process.argv.slice(2);
if (!directory || !runId || !nonce || (mode !== "begin" && mode !== "claim")) {
  throw new Error("Missing checkpoint worker input");
}
const client = new PGlite(directory);
await client.waitReady;
const store = new IncusQualificationCheckpointStore(drizzle(client));
const identity = currentProcessIdentity();
if (mode === "begin") {
  if (!deadline) throw new Error("Missing checkpoint deadline");
  await store.begin({ runId, nonce, deadlineMs: Number(deadline),
    scope: checkpointTestScope, handle: checkpointTestHandle,
    before: checkpointTestObservation(processIdentityKey(identity)) });
  process.stdout.write(`${JSON.stringify(identity)}\n`);
} else {
  const run = await store.get(runId);
  if (!run) throw new Error("Missing durable checkpoint in reopened database");
  process.stdout.write(`${JSON.stringify(identity)}\n`);
  const line = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: process.stdin });
    lines.once("line", resolve);
    lines.once("close", () => reject(new Error("Missing signed handoff")));
  });
  const { receipt } = JSON.parse(line) as { receipt: SignedRestartHandoff };
  const after: RecoveryObservation = { ...run.beforeObservation, processId: processIdentityKey(identity) };
  await store.claim({ runId, nonce, receipt, after });
  let replayRejected = false;
  try { await store.claim({ runId, nonce, receipt, after }); }
  catch { replayRejected = true; }
  if (!replayRejected) throw new Error("Checkpoint accepted a replay");
  process.stdout.write("claimed-once\n");
}
await client.close();
