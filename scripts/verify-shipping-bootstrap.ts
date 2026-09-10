/** Establish a verified, idle bootstrap boundary for production proofs. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { productionLifecycleClient, required } from "./lib/production-lifecycle-client";
import { requireBundledBootstrapVerified, waitForBundledBootstrap } from "./lib/shipping-bootstrap-state";

const { client } = await productionLifecycleClient();
const bootstrap = await waitForBundledBootstrap(client, { requireObservedPending: false });
await writeFile(join(required("EZ_PRODUCTION_RECEIPT_DIR"), "bundled-bootstrap-initial.json"), JSON.stringify(bootstrap) + "\n", { mode: 0o600 });
requireBundledBootstrapVerified(bootstrap, "before the production proof");
