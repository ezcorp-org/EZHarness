import type { NativeConnection } from "@temporalio/worker";
import { Worker } from "@temporalio/worker";
import type { DataConverter } from "@temporalio/common";
import { FACTORY_TASK_QUEUE, type FactoryActivities } from "./contracts.ts";

export interface FactoryWorkerOptions {
  readonly connection: NativeConnection;
  readonly namespace: string;
  readonly activities: FactoryActivities;
  /**
   * The workflow code, already bundled. Production passes the image build's
   * bundle (`loadFactoryWorkflowBundle`); nothing here runs a compiler.
   */
  readonly workflowBundle: { readonly code: string };
  readonly identity?: string;
  readonly dataConverter?: DataConverter;
}

export async function createFactoryWorker(options: FactoryWorkerOptions): Promise<Worker> {
  return Worker.create({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: FACTORY_TASK_QUEUE,
    workflowBundle: { code: options.workflowBundle.code },
    activities: options.activities,
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    ...(options.dataConverter === undefined ? {} : { dataConverter: options.dataConverter }),
  });
}
