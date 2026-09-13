import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { dispatchClaim, dispatchNext, deliverFactoryCommand, FactoryPreSendError, reconcileClaim, reconcileFactoryCommand } from "../src/dispatcher.ts";

const workflowInput = {
  tenantId: "tenant",
  projectId: "project",
  logicalRunId: "run",
  interpreterId: "interpreter",
  startedAtMs: 1,
  definition: { definitionDigest: `sha256:${"a".repeat(64)}`, definitionEncodedBytes: 1, manifest: { objectId: "manifest", digest: `sha256:${"b".repeat(64)}`, encodedBytes: 1 } },
  input: {},
};

function command(kind = "start_run") {
  return {
    commandId: "command-1",
    requestId: "command-1",
    tenantId: "tenant",
    projectId: "project",
    logicalRunId: "run",
    workflowId: "tenant/run",
    kind,
    interpreterId: "interpreter",
    eventId: kind === "start_run" ? undefined : "event-1",
    eventSequence: kind === "start_run" ? undefined : 1,
    eventHash: kind === "start_run" ? undefined : `sha256:${"c".repeat(64)}`,
    body: kind === "start_run" ? workflowInput : { kind: "cancel", id: "event-1", atMs: 2, reason: "test" },
  };
}

describe("factory outbox dispatcher", () => {
  it("uses the durable command ID as the Temporal start request ID", async () => {
    let captured: Record<PropertyKey, any> = {};
    const client = { workflow: { start: async (_type, options) => { captured = options; } } };
    await deliverFactoryCommand(client, command());
    assert.equal(captured[Symbol.for("__temporal_internal_client_workflow_start_options")].requestId, "command-1");
    assert.equal(captured.workflowId, "tenant/run");
    assert.equal(captured.retry.maximumAttempts, 1);
    assert.equal(captured.workflowIdReusePolicy, "REJECT_DUPLICATE");
    assert.deepEqual(captured.memo["ezcorp.factory.start.v1"], { commandId: "command-1", tenantId: "tenant", projectId: "project", logicalRunId: "run", interpreterId: "interpreter" });
  });

  it("acknowledges only a repeated start with the same durable identity", async () => {
    const existing = { commandId: "command-1", tenantId: "tenant", projectId: "project", logicalRunId: "run", interpreterId: "interpreter" };
    const client = {
      workflow: {
        start: async () => {
          throw new WorkflowExecutionAlreadyStartedError("exists", "tenant/run", "factoryWorkflow");
        },
        getHandle: () => ({ describe: async () => ({ type: "factoryWorkflow", memo: { "ezcorp.factory.start.v1": existing } }) }),
      },
    };
    await assert.doesNotReject(deliverFactoryCommand(client, command()));
    client.workflow.getHandle = () => ({ describe: async () => ({ type: "factoryWorkflow", memo: { "ezcorp.factory.start.v1": { ...existing, commandId: "other" } } }) });
    await assert.rejects(deliverFactoryCommand(client, command()), WorkflowExecutionAlreadyStartedError);
  });

  it("signals the existing workflow with a stable inbox event", async () => {
    const calls = [];
    const client = { workflow: { getHandle: (id) => ({ signal: async (name, body) => calls.push([id, name, body]) }) } };
    await deliverFactoryCommand(client, command("decision"));
    const value = command("decision");
    assert.deepEqual(calls, [["tenant/run", "factoryInbox", { sequence: value.eventSequence, eventId: value.eventId, eventHash: value.eventHash, event: value.body }]]);
  });

  it("rejects invalid durable identities and payloads", async () => {
    await assert.rejects(deliverFactoryCommand({ workflow: {} }, { ...command(), requestId: "different" }), /request ID/);
    await assert.rejects(deliverFactoryCommand({ workflow: {} }, { ...command(), body: null }), /workflow input object/);
    await assert.rejects(deliverFactoryCommand({ workflow: {} }, { ...command(), body: [] }), /workflow input object/);
    await assert.rejects(deliverFactoryCommand({ workflow: {} }, { ...command(), body: 1 }), /workflow input object/);
    await assert.rejects(deliverFactoryCommand({ workflow: {} }, { ...command(), tenantId: "other" }), /identity/);
    await assert.rejects(deliverFactoryCommand({ workflow: {} }, { ...command(), workflowId: "other/run" }), /identity/);
    await assert.rejects(deliverFactoryCommand({ workflow: { start: async () => { throw new Error("start failed"); } } }, command()), /start failed/);
    await assert.rejects(deliverFactoryCommand({ workflow: {} }, { ...command("decision"), eventId: undefined }), /stable event identity/);
    await assert.rejects(deliverFactoryCommand({ workflow: {} }, { ...command("decision"), eventSequence: undefined }), /stable event identity/);
    await assert.rejects(deliverFactoryCommand({ workflow: {} }, { ...command("decision"), eventHash: undefined }), /stable event identity/);
    await assert.rejects(deliverFactoryCommand({ workflow: {} }, { ...command("decision"), body: null }), /inbox event/);
    await assert.rejects(deliverFactoryCommand({ workflow: {} }, { ...command("decision"), eventId: "different" }), /does not match/);
  });

  it("reconciles acknowledged and pending decisions by durable identity", async () => {
    const value = command("decision");
    const client = {
      workflow: {
        getHandle: () => ({
          query: async () => ({ acknowledgedSequence: 0, pending: [{ sequence: value.eventSequence, eventId: value.eventId, eventHash: value.eventHash }] }),
        }),
      },
    };
    assert.equal(await reconcileFactoryCommand(client, value), "delivered");
    client.workflow.getHandle = () => ({ query: async () => ({ acknowledgedSequence: 1, pending: [] }) });
    assert.equal(await reconcileFactoryCommand(client, value), "delivered");
    client.workflow.getHandle = () => ({ query: async () => ({ acknowledgedSequence: 0, pending: [] }) });
    assert.equal(await reconcileFactoryCommand(client, value), "outcome_unknown");
    client.workflow.getHandle = () => ({ query: async () => { throw new Error("unavailable"); } });
    assert.equal(await reconcileFactoryCommand(client, value), "outcome_unknown");
    assert.equal(await reconcileFactoryCommand(client, { ...value, eventSequence: undefined }), "outcome_unknown");
  });

  it("settles a recovered unknown claim only after identity reconciliation", async () => {
    const value = command("decision");
    const claim = { claimToken: "token", command: value };
    const settled = [];
    const queue = { claim: async () => null, settle: async (...args) => settled.push(args) };
    const client = { workflow: { getHandle: () => ({ query: async () => ({ acknowledgedSequence: 1, pending: [] }) }) } };
    assert.equal(await reconcileClaim(client, queue, claim), "delivered");
    assert.deepEqual(settled.map((entry) => entry.slice(1)), [["delivered"]]);
    client.workflow.getHandle = () => ({ query: async () => ({ acknowledgedSequence: 0, pending: [] }) });
    assert.equal(await reconcileClaim(client, queue, claim), "outcome_unknown");
    assert.equal(settled.length, 1);
  });

  it("settles only after an acknowledged delivery", async () => {
    const settled = [];
    const claim = { claimToken: "token", command: command("decision") };
    const queue = { claim: async () => claim, settle: async (...args) => settled.push(args) };
    const client = { workflow: { getHandle: () => ({ signal: async () => undefined }) } };
    assert.equal(await dispatchNext(client, queue), "delivered");
    assert.deepEqual(settled.map((entry) => entry.slice(1)), [["delivered"]]);
    queue.claim = async () => null;
    assert.equal(await dispatchNext(client, queue), "empty");
  });

  it("retries known pre-send connection failures and parks uncertain errors", async () => {
    const outcomes = [];
    const queue = { claim: async () => null, settle: async (_claim, outcome, code) => outcomes.push([outcome, code]) };
    const claim = { claimToken: "token", command: command("decision") };
    const disconnected = { workflow: { getHandle: () => ({ signal: async () => { throw new FactoryPreSendError("client proved the request was not sent"); } }) } };
    assert.equal(await dispatchClaim(disconnected, queue, claim), "retry");
    const uncertain = { workflow: { getHandle: () => ({ signal: async () => { throw new Error("deadline exceeded after send"); } }) } };
    assert.equal(await dispatchClaim(uncertain, queue, claim), "outcome_unknown");
    const typedButCertain = { workflow: { getHandle: () => ({ signal: async () => { throw new TypeError("bad payload"); } }) } };
    assert.equal(await dispatchClaim(typedButCertain, queue, claim), "outcome_unknown");
    const nonError = { workflow: { getHandle: () => ({ signal: async () => { throw "unknown"; } }) } };
    assert.equal(await dispatchClaim(nonError, queue, claim), "outcome_unknown");
    assert.deepEqual(outcomes, [["retry", "FactoryPreSendError"], ["outcome_unknown", "Error"], ["outcome_unknown", "TypeError"], ["outcome_unknown", "UNKNOWN"]]);
  });

  it("settles an uncertain send as delivered when the workflow receipt confirms it", async () => {
    const outcomes = [];
    const value = command("decision");
    const queue = { claim: async () => null, settle: async (_claim, outcome, code) => outcomes.push([outcome, code]) };
    let signals = 0;
    const client = {
      workflow: {
        getHandle: () => ({
          signal: async () => {
            signals += 1;
            throw new Error("connection closed after acknowledgement");
          },
          query: async () => ({ acknowledgedSequence: 1, pending: [] }),
        }),
      },
    };
    assert.equal(await dispatchClaim(client, queue, { claimToken: "token", command: value }), "delivered");
    assert.equal(signals, 1);
    assert.deepEqual(outcomes, [["delivered", undefined]]);
  });
});
