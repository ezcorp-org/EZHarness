import type { NativeConnection } from "@temporalio/worker";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { FACTORY_TASK_QUEUE, type FactoryActivities } from "./contracts.ts";

export interface FactoryWorkerOptions {
  readonly connection: NativeConnection;
  readonly activities: FactoryActivities;
}

export async function createFactoryWorker(options: FactoryWorkerOptions): Promise<Worker> {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const workflowBundle = await bundleWorkflowCode({ workflowsPath: new URL(`./workflow.${extension}`, import.meta.url).pathname });
  return Worker.create({
    connection: options.connection,
    taskQueue: FACTORY_TASK_QUEUE,
    workflowBundle,
    activities: options.activities,
  });
}
