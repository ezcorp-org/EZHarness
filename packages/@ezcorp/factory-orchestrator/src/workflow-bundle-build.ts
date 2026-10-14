/**
 * Build time only: `node --experimental-strip-types src/workflow-bundle-build.ts [directory]`.
 *
 * The package build (and so `bun run build:packages` in the image build) runs
 * this once. It is the one place that loads Temporal's webpack bundler; the
 * orchestrator process never imports this module.
 */
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
import { FACTORY_WORKFLOW_BUNDLE_DIRECTORY, writeFactoryWorkflowBundle, type FactoryWorkflowBundleRecord } from "./workflow-bundle.ts";

export async function buildFactoryWorkflowBundle(directory: string = FACTORY_WORKFLOW_BUNDLE_DIRECTORY): Promise<FactoryWorkflowBundleRecord> {
  return writeFactoryWorkflowBundle(directory, bundleWorkflowCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildFactoryWorkflowBundle(process.argv[2])));
