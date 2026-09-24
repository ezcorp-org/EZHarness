import { createInterface } from "node:readline";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { IncusQualificationCheckpointStore, type SignedRestartHandoff }
  from "../incus-qualification-checkpoint";
import { IncusQualificationContinuation } from "../incus-qualification-continuation";
import { checkpointTestHandle as handle, checkpointTestObservation as observation,
  checkpointTestScope as scope } from "./incus-qualification-checkpoint-test-observation";
import type { IncusQualificationFixtureService } from "../incus-qualification";
import type { HostIncusLiveReadback, LiveReadbackContext } from "../incus-transport/live-readback";

const [mode, directory, runId, nonce, deadline] = process.argv.slice(2);
if (!directory || !runId || !nonce || (mode !== "begin" && mode !== "resume")) {
  throw new Error("Missing continuation worker input");
}
const client = new PGlite(directory);
await client.waitReady;
const context = {
  scope, connection: { revision: 2, configuration: { guestUser: "sandbox" } },
  preset: { id: scope.presetId, imageDigest: "a".repeat(64), profile: "profile",
    helperDigests: ["b".repeat(64)] },
  recipe: { guestImage: { fingerprint: "a".repeat(64), helperSha256: "b".repeat(64) } },
} as unknown as LiveReadbackContext;
const fixtures = { status: async () => observation("unused").durable } as unknown as IncusQualificationFixtureService;
const readback = { instance: async () => ({ state: "stopped", imageDigest: "a".repeat(64),
  profile: "profile", memoryBytes: 1024, cpuMillis: 1000, pids: 4, diskBytes: 1024,
  storageDriver: "zfs", privateNetwork: true, restrictedProject: true, unprivileged: true }) } as unknown as HostIncusLiveReadback;
const continuation = new IncusQualificationContinuation({ checkpoints: new IncusQualificationCheckpointStore(drizzle(client)),
  fixtures, readback, context });
if (mode === "begin") {
  if (!deadline) throw new Error("Missing restart deadline");
  process.stdout.write(`${JSON.stringify(await continuation.prepare({ runId, nonce, deadlineMs: Number(deadline), scope, handle }))}\n`);
} else {
  const result = await continuation.resume(runId, nonce, async payload => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    const line = await new Promise<string>((resolve, reject) => {
      const input = createInterface({ input: process.stdin });
      input.once("line", resolve);
      input.once("close", () => reject(new Error("Missing supervisor receipt")));
    });
    return JSON.parse(line) as SignedRestartHandoff;
  });
  if (result.handle.sandboxId !== handle.sandboxId) throw new Error("Wrong resumed binding");
  let replayRejected = false;
  try { await continuation.resume(runId, nonce, async () => { throw new Error("Receipt requested on replay"); }); }
  catch { replayRejected = true; }
  if (!replayRejected) throw new Error("Restart checkpoint accepted replay");
  process.stdout.write("claimed-once\n");
}
await client.close();
