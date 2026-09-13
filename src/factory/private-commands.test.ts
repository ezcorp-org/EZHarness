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
