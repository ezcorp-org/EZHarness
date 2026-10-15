import type { NativeConnection } from "@temporalio/worker";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import type { DataConverter } from "@temporalio/common";
import { FACTORY_TASK_QUEUE, type FactoryActivities } from "./contracts.ts";

export interface FactoryWorkerOptions {
  readonly connection: NativeConnection;
  readonly namespace: string;
  readonly activities: FactoryActivities;
  readonly identity?: string;
  readonly dataConverter?: DataConverter;
}

export async function createFactoryWorker(options: FactoryWorkerOptions): Promise<Worker> {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const workflowBundle = await bundleWorkflowCode({ workflowsPath: new URL(`./workflow.${extension}`, import.meta.url).pathname });
  return Worker.create({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: FACTORY_TASK_QUEUE,
    workflowBundle,
    activities: options.activities,
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    ...(options.dataConverter === undefined ? {} : { dataConverter: options.dataConverter }),
  });
}
