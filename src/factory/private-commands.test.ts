import { expect, test } from "bun:test";
import type { KernelCommand } from "@ezcorp/factory-sdk";
import { FactoryPrivateCommands, type FactoryPrivateCommandStores } from "./private-commands";

test("private command routing rejects incomplete effect bindings before accepting work", () => {
  expect(() => new FactoryPrivateCommands({} as FactoryPrivateCommandStores)).toThrow("factory_private_commands_invalid");
});

test("private command routing uses stored kinds, captures references, and rejects local orchestration commands", async () => {
  const service = { tenantId: "tenant-a", subject: "orchestration" };
  const reference = { tenantId: "tenant-a", projectId: "project-a", logicalRunId: "run-a", interpreterId: "root", commandId: "command-a" };
  let kind: KernelCommand["kind"] = "request-admission";
  let storedCommandId = "command-a";
  const calls: unknown[] = [];
  const execute = async (identity: unknown, stored: unknown) => { calls.push({ identity, stored }); return null; };
  const inputResult = { kind: "start", id: "input-result", atMs: 1 } as const;
  const definitionSource = { definitionEncodedBytes: 1, manifest: { objectId: "manifest", digest: `sha256:${"c".repeat(64)}`, encodedBytes: 1 } };
  const options = {
    service,
    authority: { tenantId: service.tenantId, assertService(identity) { if (identity.tenantId !== service.tenantId || identity.subject !== service.subject) throw new Error("denied"); } },
    transitions: { async loadStoredCommand() { await Promise.resolve(); return { kind, id: storedCommandId } as KernelCommand; } },
    tasks: { async request(identity, stored) { await execute(identity, stored); return {} as never; } },
    execution: { async admit(identity, stored) { await execute(identity, stored); return {} as never; } },
    inputs: { async execute(identity, stored) { await execute(identity, stored); return inputResult; } },
    children: { async resolve(identity, stored) { await execute(identity, stored); return { ...definitionSource, definitionDigest: stored.factory.digest }; } },
    approvals: { tenantId: service.tenantId, execute: stored => execute(service, stored) },
    effects: { "cancel-node": execute, "request-acceptance": execute, "request-release": execute, "invalidate-partition": execute, "notify-partition": execute },
  } satisfies FactoryPrivateCommandStores;
  for (const invalid of [
    { ...options, service: { ...service, tenantId: "foreign" } },
    { ...options, approvals: { ...options.approvals, tenantId: "foreign" } },
    { ...options, effects: { ...options.effects, extra: execute } },
    { ...options, tasks: {} },
    { ...options, effects: { ...options.effects, "request-release": undefined } },
  ]) expect(() => new FactoryPrivateCommands(invalid as FactoryPrivateCommandStores)).toThrow("factory_private_commands_invalid");
  const router = new FactoryPrivateCommands(options);
  options.effects["notify-partition"] = async () => { throw new Error("mutated handler"); };
  for (const selected of ["request-admission", "dispatch-node", "read-input-value", "read-input-page", "request-approval", "cancel-node", "request-acceptance", "request-release", "invalidate-partition", "notify-partition"] as const) {
    kind = selected;
    const mutable = { ...reference };
    const pending = router.execute(service, mutable);
    mutable.logicalRunId = "changed-run";
    expect(await pending).toEqual(selected.startsWith("read-input-") ? inputResult : null);
    expect(calls.at(-1)).toEqual({ identity: service, stored: reference });
  }
  expect(calls).toHaveLength(10);
  for (const selected of ["start-timer", "run-child", "complete-run", "complete-partition", "fail-run", "cancel-run"] as const) {
    kind = selected;
    await expect(router.execute(service, reference)).rejects.toMatchObject({ code: "factory_private_command_forbidden" });
  }
  await expect(router.execute({ ...service, subject: "foreign" }, reference)).rejects.toMatchObject({ code: "factory_private_command_forbidden" });
  await expect(router.execute(service, { ...reference, tenantId: "foreign" })).rejects.toMatchObject({ code: "factory_private_command_forbidden" });
  storedCommandId = "changed-command";
  kind = "request-admission";
  await expect(router.execute(service, reference)).rejects.toMatchObject({ code: "factory_private_command_forbidden" });
  expect(calls).toHaveLength(10);
  const factory = { id: "child", version: "1", digest: `sha256:${"a".repeat(64)}` };
  const request = { ...reference, factory: { ...factory } };
  const pending = router.resolveFactory(service, request);
  request.factory.digest = `sha256:${"b".repeat(64)}`;
  expect(await pending).toEqual({ ...definitionSource, definitionDigest: factory.digest });
  expect(calls.at(-1)).toEqual({ identity: service, stored: { ...reference, factory } });
});

const SERVICE = { tenantId: "tenant-a", subject: "orchestration" };
const REFERENCE = { tenantId: "tenant-a", projectId: "project-a", logicalRunId: "run-a", interpreterId: "root", commandId: "command-a" };

/** A router whose every handler throws `state.failure`, over a stored command of the current `kind`. */
function refusingRouter(dispatch?: FactoryPrivateCommandStores["execution"]["dispatch"]) {
  const state: { kind: KernelCommand["kind"]; failure: unknown } = { kind: "dispatch-node", failure: Object.assign(new Error("quarantined"), { code: "factory_package_quarantined" }) };
  const fail = async () => { throw state.failure; };
  const router = new FactoryPrivateCommands({
    service: SERVICE,
    authority: { tenantId: SERVICE.tenantId, assertService() {} } as never,
    transitions: { async loadStoredCommand() { return { kind: state.kind, id: "command-a", nodeId: "work", candidateGeneration: 2, attempt: 3 } as KernelCommand; } },
    tasks: { request: fail as never },
    execution: { admit: fail as never, ...(dispatch === undefined ? {} : { dispatch }) },
    inputs: { execute: fail as never },
    children: { resolve: fail as never },
    approvals: { tenantId: SERVICE.tenantId, execute: fail as never },
    effects: { "cancel-node": fail, "request-acceptance": fail, "request-release": fail, "invalidate-partition": fail, "notify-partition": fail },
  });
  return { router, state };
}

test("a named refusal on any effect or cancel is answered as the command-failed event that carries its name", async () => {
  const { router, state } = refusingRouter();
  for (const kind of ["cancel-node", "request-acceptance", "request-release", "invalidate-partition", "notify-partition"] as const) {
    state.kind = kind;
    const before = Date.now();
    const event = await router.execute(SERVICE, REFERENCE);
    expect(event).toMatchObject({ kind: "command-failed", id: "command-a:command-failed", commandId: "command-a", error: `FACTORY_COMMAND_FAILED: ${kind} command-a: factory_package_quarantined` });
    expect((event as { atMs: number }).atMs).toBeGreaterThanOrEqual(before);
  }
});

test("a dispatch refused with nothing queued, decided atomically, ends its node: admission_denied with the refusal's name", async () => {
  const seen: unknown[] = [];
  const { router } = refusingRouter(async (service, reference) => { seen.push([service, reference]); return { refused: "factory_package_quarantined", queued: false }; });
  expect(await router.execute(SERVICE, REFERENCE)).toMatchObject({
    kind: "node-failed", id: "command-a:admission-refused", nodeId: "work", commandId: "command-a", candidateGeneration: 2, attempt: 3,
    error: "factory_package_quarantined", failureKind: "admission_denied",
  });
  expect(seen).toEqual([[SERVICE, REFERENCE]]);
});

test("a dispatch refused after its attempt was queued keeps command-failed, so the kernel still cancels", async () => {
  const { router } = refusingRouter(async () => ({ refused: "factory_task_execution_conflict", queued: true }));
  expect(await router.execute(SERVICE, REFERENCE)).toMatchObject({ kind: "command-failed", error: "FACTORY_COMMAND_FAILED: dispatch-node command-a: factory_task_execution_conflict" });
});

test("an admitted dispatch answers nothing; without the atomic decision, or refused before it, a dispatch keeps command-failed", async () => {
  const admitted = refusingRouter(async () => ({ admitted: {} as never }));
  expect(await admitted.router.execute(SERVICE, REFERENCE)).toBeNull();
  const unread = refusingRouter();
  expect(await unread.router.execute(SERVICE, REFERENCE)).toMatchObject({ kind: "command-failed", error: "FACTORY_COMMAND_FAILED: dispatch-node command-a: factory_package_quarantined" });
  const stale = refusingRouter(async () => { throw Object.assign(new Error("stale"), { code: "factory_command_stale" }); });
  expect(await stale.router.execute(SERVICE, REFERENCE)).toMatchObject({ kind: "command-failed", error: "FACTORY_COMMAND_FAILED: dispatch-node command-a: factory_command_stale" });
});

test("anything that is not a named refusal, and every command off those two routes, still throws", async () => {
  const boom = new Error("internal");
  const failing = refusingRouter(async () => { throw boom; });
  await expect(failing.router.execute(SERVICE, REFERENCE)).rejects.toBe(boom);
  const { router, state } = refusingRouter();
  const foreign = Object.assign(new Error("reset"), { code: "ECONNRESET" });
  state.failure = foreign;
  await expect(router.execute(SERVICE, REFERENCE)).rejects.toBe(foreign);
  state.failure = Object.assign(new Error("quarantined"), { code: "factory_package_quarantined" });
  for (const kind of ["request-admission", "read-input-value", "request-approval"] as const) {
    state.kind = kind;
    await expect(router.execute(SERVICE, REFERENCE)).rejects.toMatchObject({ code: "factory_package_quarantined" });
  }
});
