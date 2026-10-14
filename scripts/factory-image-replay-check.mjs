// Runs INSIDE the factory image, under the shipped isolation (scripts/check-factory-image-shipped-config.ts):
//
//   node factory-image-replay-check.mjs <app root> <history.json>
//
// It obtains the workflow code the way the image's orchestrator does, then replays a committed workflow
// history through Temporal's worker. An image with the build-time bundle (W4H-27) loads it through the
// digest-checked loader; an image from before it bundles at run time, as its orchestrator did
// (worker.ts:16 at 1981febd2), so the guard is red on such an image for the very cause that broke it.
// Plain JavaScript on purpose: it must run on images built before this file existed.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export async function replayFactoryImageWorkflow(appRoot, historyPath) {
  const packageRoot = `${appRoot}/packages/@ezcorp/factory-orchestrator`;
  const { Worker, bundleWorkflowCode } = createRequire(`${packageRoot}/package.json`)("@temporalio/worker");
  const loader = await import(pathToFileURL(`${packageRoot}/src/workflow-bundle.ts`).href).then((module) => module.loadFactoryWorkflowBundle, () => undefined);
  const code = loader === undefined
    ? (await bundleWorkflowCode({ workflowsPath: `${packageRoot}/src/workflow.ts` })).code
    : (await loader()).code;
  await Worker.runReplayHistory({ workflowBundle: { code } }, JSON.parse(await readFile(historyPath, "utf8")));
  return loader === undefined ? "runtime bundle" : "build-time bundle";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`REPLAY OK: ${await replayFactoryImageWorkflow(process.argv[2], process.argv[3])}`);
}
