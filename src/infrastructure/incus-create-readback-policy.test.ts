import { expect, test } from "bun:test";
import type { SandboxBinding, SandboxOperation } from "../db/schema";
import { permitsCreateReadbackDuringQueuedCleanup as permits } from "./incus-create-readback-policy";

const binding = { id: "binding", tombstonedAt: new Date(0), desiredState: "ABSENT" } as SandboxBinding;
const create = { generation: 1 } as SandboxOperation;
const cleanup = { bindingId: "binding", kind: "DESTROY", generation: 1, state: "JOURNALED",
  providerOperationId: null, requestPayload: { expectedGeneration: 1 } } as SandboxOperation;

test("permits only the queued exact-generation cleanup shape", () => {
  expect(permits(binding, create, cleanup)).toBe(true);
  expect(permits(binding, create, undefined)).toBe(false);
  for (const patch of [
    { bindingId: "foreign" }, { kind: "CREATE" }, { generation: 2 }, { state: "DISPATCHING" },
    { providerOperationId: "provider-operation" }, { requestPayload: { expectedGeneration: 2 } },
    { requestPayload: { expectedGeneration: 1, extra: true } }, { requestPayload: {} },
  ]) expect(permits(binding, create, { ...cleanup, ...patch } as SandboxOperation)).toBe(false);
  expect(permits({ ...binding, tombstonedAt: null }, create, cleanup)).toBe(false);
  expect(permits({ ...binding, desiredState: "STOPPED" }, create, cleanup)).toBe(false);
});
