import assert from "node:assert/strict";
import { it } from "node:test";
import * as orchestrator from "../src/index.ts";

it("exports the Node orchestrator surface", () => {
  assert.equal(orchestrator.FACTORY_WORKFLOW_TYPE, "factoryWorkflow");
  assert.equal(typeof orchestrator.deliverFactoryCommand, "function");
  assert.equal(typeof orchestrator.loadCompiledFactory, "function");
  assert.equal(typeof orchestrator.createGatewayFactoryActivities, "function");
  assert.equal(typeof orchestrator.createFactoryWorker, "function");
});
