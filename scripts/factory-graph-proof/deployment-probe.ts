/**
 * Runs the reference code provider probe against a persistent proof deployment (W10c R7).
 *
 * Reads the deployment's database name and encryption secret from W19A_DEPLOYMENT_DIR and hands
 * them to the probe in its environment: never on argv, never printed. The probe's record names
 * the provider, model, credential kind and store kind only.
 *
 * Env: W19A_REPO, W19A_DEPLOYMENT_DIR, FACTORY_TEST_POSTGRES_URL (exported by run.sh).
 * Usage (through run.sh): run.sh probe <deployment-dir> <evidence.json>
 */
import { join } from "node:path";
import { deploymentEnvironment } from "./deployment";

const repo = process.env.W19A_REPO!;
const evidence = process.argv[2];
const environment = await deploymentEnvironment(process.env.W19A_DEPLOYMENT_DIR ?? "", {
  uid: process.getuid!(), home: process.env.HOME ?? "/", repo, evidence: "/tmp/factory-platform-evidence",
}, process.env.FACTORY_TEST_POSTGRES_URL!);
const env: Record<string, string | undefined> = { ...process.env, ...environment };
for (const name of ["EZCORP_DB_PATH", "EZCORP_SECRETS_DIR", "FACTORY_TEST_POSTGRES_URL"]) delete env[name];
const child = Bun.spawn([process.execPath, join(repo, "scripts/verify-factory-reference-code-provider.ts"), ...(evidence ? ["--evidence", evidence] : [])], { cwd: repo, env, stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
