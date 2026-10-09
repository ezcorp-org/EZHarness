import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../db/schema";
import { completedCleanupComponents } from "./incus-completed-cleanup-expiry.fixture";
import { releaseTerminalIncusQualification, requestIncusSupervisorReadiness } from "../incus-qualification-supervisor-client";

const [root, phase] = process.argv.slice(2) as [string, string];
const hold = await readFile(join(root, "PUBLIC_HOLD"), "utf8");
if (hold !== "held") throw new Error("public hold changed");
const client = new PGlite(join(root, "database"));
const publicKey = await readFile(join(root, "public.pem"), "utf8");
let effects = 0;
const components = completedCleanupComponents(drizzle(client, { schema }), publicKey, () => { effects++; });
process.once("SIGTERM", async () => { await client.close(); process.exit(0); });
if (phase === "first") await components.reconcile();
const beforeTerminal = await components.checkpoints.terminalAttestation();
let terminalReleased = false;
try {
  await releaseTerminalIncusQualification(drizzle(client, { schema }), {
    EZCORP_INCUS_SUPERVISOR_SOCKET: join(root, "control.sock"),
    EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64: Buffer.from(publicKey).toString("base64"),
  });
  terminalReleased = true;
} catch (error) {
  if (phase !== "first" || !String(error).includes("terminal claim unavailable")) throw error;
}
if (phase === "second" && !terminalReleased) throw new Error("terminal was not released");
const ready = phase === "second" ? await requestIncusSupervisorReadiness(join(root, "control.sock")) : null;
await writeFile(join(root, `result-${phase}.json`), JSON.stringify({ phase, pid: process.pid, beforeTerminal,
  terminalReleased, ready, effects, hold: await readFile(join(root, "PUBLIC_HOLD"), "utf8") }));
setInterval(() => {}, 1000);
