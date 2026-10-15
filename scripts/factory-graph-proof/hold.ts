/**
 * Hold one persistent proof deployment up for a bounded time (W10c R7/R8 sign-in flow).
 *
 * Starts the stack on the persistent deployment in W19A_DEPLOYMENT_DIR, pinned to the reference
 * model, prints the web URL and the deployment's database name, and stops the stack on SIGTERM,
 * SIGINT, or after W19A_HOLD_MINUTES (at most 30). The deployment's database and key files stay;
 * the next start with the same folder is the same installation. Run only under the heavy lock,
 * through `run.sh hold`.
 *
 * Env: W19A_REPO, W19A_OUT, W19A_LABEL, W19A_DEPLOYMENT_DIR, W19A_HOLD_MINUTES, and the
 * PostgreSQL and storage variables run.sh exports. The record names the deployment by database only.
 */
import { join } from "node:path";
import { graphReferences, graphRunnerProfiles } from "./graph";
import { buildGraphGuest, type GraphGuestBuild } from "./guest-package";
import { checkSharedStores, startStack, type Stack } from "./stack";
import { REFERENCE_CODE_MODEL_PIN } from "../verify-factory-reference-code-provider";

const REPO = process.env.W19A_REPO!;
const OUT = process.env.W19A_OUT!;
const LABEL = process.env.W19A_LABEL ?? "hold";
const DEPLOYMENT_DIR = process.env.W19A_DEPLOYMENT_DIR;
const MAX_MINUTES = 30;
const minutes = Math.min(Number(process.env.W19A_HOLD_MINUTES ?? MAX_MINUTES) || MAX_MINUTES, MAX_MINUTES);

const record: Record<string, unknown> = { label: LABEL, startedAt: new Date().toISOString(), holdMinutes: minutes, modelProvider: REFERENCE_CODE_MODEL_PIN };
let stack: Stack | undefined;

async function finish(outcome: string): Promise<never> {
  record.outcome = outcome;
  if (stack) await stack.stop(false, outcome !== "held").catch((error: unknown) => { record.stopError = String(error); });
  record.finishedAt = new Date().toISOString();
  await Bun.write(join(OUT, `${LABEL}.json`), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ label: LABEL, outcome, deployment: record.deployment ?? null }));
  process.exit(outcome === "held" ? 0 : 1);
}

if (!DEPLOYMENT_DIR) await finish("refused: W19A_DEPLOYMENT_DIR is not set; a hold is always on a persistent deployment");
const stores = await checkSharedStores();
record.sharedStores = stores;
if (stores.some((store) => !store.reachable)) await finish("refused: a shared object store is not available");

let build: GraphGuestBuild | undefined;
try {
  stack = await startStack({
    repo: REPO, bun: process.execPath, record,
    modelProvider: { ...REFERENCE_CODE_MODEL_PIN },
    deploymentDir: DEPLOYMENT_DIR,
    buildGuest: async (runnerRoot) => { build = await buildGraphGuest(REPO, runnerRoot, "w10c-hold-supervisor-store"); return { guest: build.guest, sourceDigest: build.sourceDigest }; },
    // No guest calls a model during a hold; the profiles only have to be valid.
    runnerProfiles: () => graphRunnerProfiles(graphReferences(build!.guest, undefined), undefined),
    diagnostics: { dir: OUT, label: LABEL },
  });
} catch (error) {
  await finish(`failed to start: ${(error as Error).name}: ${(error as Error).message.split("\n")[0]}`);
}
if (!record.ready) await finish("failed: the server never reported ready");
record.url = `http://127.0.0.1:${stack!.port}`;
console.log(JSON.stringify({ label: LABEL, url: record.url, deployment: record.deployment, holdMinutes: minutes }));

const signal = await new Promise<string>((settle) => {
  process.once("SIGTERM", () => settle("SIGTERM"));
  process.once("SIGINT", () => settle("SIGINT"));
  setTimeout(() => settle("time-limit"), minutes * 60_000);
});
record.stoppedBy = signal;
await finish("held");
