import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { createFactoryLaunchFixture, factoryLaunchLease, factoryLaunchPackage, factoryLaunchRequest, type FactoryLaunchFixture } from "../../__tests__/helpers/factory-attempt-launch-fixture";
import { FactoryAttemptRuntimeError, FactoryDatabaseAttemptLaunchStore, type FactoryAttemptDeviceAuthorization } from "./attempt-runtime";

const gpu: FactoryAttemptDeviceAuthorization = { gpuHosts: 1, devices: ["/dev/kfd", "/dev/dri/renderD128"] };
const otherGpu: FactoryAttemptDeviceAuthorization = { gpuHosts: 1, devices: ["/dev/dri/renderD129"] };

let fixture: FactoryLaunchFixture;
let store: FactoryDatabaseAttemptLaunchStore;
let first: FactoryRunnerRequest;

/** Two admitted attempts that the same host could try to run at the same time. */
async function second(attemptId: string): Promise<FactoryRunnerRequest> {
  const request = factoryLaunchRequest({ attemptId });
  await fixture.admit(request);
  return request;
}

beforeEach(async () => {
  first = factoryLaunchRequest({ attemptId: "attempt-device-a" });
  fixture = await createFactoryLaunchFixture(first);
  store = new FactoryDatabaseAttemptLaunchStore(fixture.db);
});
afterEach(async () => { await fixture.close(); });

test("a CPU attempt persists an empty grant and claims no device", async () => {
  const intent = await store.prepare(first, factoryLaunchLease, factoryLaunchPackage(first));
  expect(intent.devices.devices).toEqual([]);
  expect(intent.devices.cdiDevices).toEqual([]);
  expect(intent.devices.capabilities).toEqual([]);
  expect((await store.claimStart(first.authority.attemptId)).claimed).toBe(true);
  const stored = (await fixture.db.execute(sql`SELECT device_grant_json FROM factory_attempt_launches WHERE attempt_id=${first.authority.attemptId}`)) as unknown as { rows: { device_grant_json: unknown }[] };
  expect(stored.rows[0]!.device_grant_json).toEqual({ devices: [], cdiDevices: [], capabilities: [] });
});

test("two live attempts on one host cannot both hold the same device node", async () => {
  const other = await second("attempt-device-b");
  await store.prepare(first, factoryLaunchLease, factoryLaunchPackage(first), gpu);
  await store.prepare(other, factoryLaunchLease, factoryLaunchPackage(other), gpu);
  expect((await store.claimStart(first.authority.attemptId)).claimed).toBe(true);
  const denial = await store.claimStart(other.authority.attemptId).then(() => undefined, (error: unknown) => error);
  expect(denial).toBeInstanceOf(FactoryAttemptRuntimeError);
  expect((denial as FactoryAttemptRuntimeError).code).toBe("device_conflict");
  expect((denial as Error).message).toContain("attempt-device-a");
});

test("one overlapping node in a wider grant is enough to deny the second claim", async () => {
  const other = await second("attempt-device-b");
  await store.prepare(first, factoryLaunchLease, factoryLaunchPackage(first), { gpuHosts: 1, devices: ["/dev/dri/renderD128"] });
  await store.prepare(other, factoryLaunchLease, factoryLaunchPackage(other), gpu);
  await store.claimStart(first.authority.attemptId);
  await expect(store.claimStart(other.authority.attemptId)).rejects.toThrow("already holds one of these devices");
});

test("disjoint device nodes on the same host both claim", async () => {
  const other = await second("attempt-device-b");
  await store.prepare(first, factoryLaunchLease, factoryLaunchPackage(first), gpu);
  await store.prepare(other, factoryLaunchLease, factoryLaunchPackage(other), otherGpu);
  expect((await store.claimStart(first.authority.attemptId)).claimed).toBe(true);
  expect((await store.claimStart(other.authority.attemptId)).claimed).toBe(true);
});

test("the same device node on a different host is not a conflict", async () => {
  const other = await second("attempt-device-b");
  await store.prepare(first, factoryLaunchLease, factoryLaunchPackage(first), gpu);
  await store.prepare(other, { ...factoryLaunchLease, hostId: "host-elsewhere" }, factoryLaunchPackage(other), gpu);
  expect((await store.claimStart(first.authority.attemptId)).claimed).toBe(true);
  expect((await store.claimStart(other.authority.attemptId)).claimed).toBe(true);
});

test("a terminal holder releases its devices for the next attempt", async () => {
  const other = await second("attempt-device-b");
  await store.prepare(first, factoryLaunchLease, factoryLaunchPackage(first), gpu);
  await store.prepare(other, factoryLaunchLease, factoryLaunchPackage(other), gpu);
  await store.claimStart(first.authority.attemptId);
  await expect(store.claimStart(other.authority.attemptId)).rejects.toThrow("already holds one of these devices");
  await store.state(first.authority.attemptId, "terminal");
  expect((await store.claimStart(other.authority.attemptId)).claimed).toBe(true);
});

test("an uncertain holder still fences its devices", async () => {
  const other = await second("attempt-device-b");
  await store.prepare(first, factoryLaunchLease, factoryLaunchPackage(first), gpu);
  await store.prepare(other, factoryLaunchLease, factoryLaunchPackage(other), gpu);
  await store.claimStart(first.authority.attemptId);
  await store.state(first.authority.attemptId, "uncertain");
  await expect(store.claimStart(other.authority.attemptId)).rejects.toThrow("already holds one of these devices");
});

test("a repeat claim by the holder itself is never its own conflict", async () => {
  await store.prepare(first, factoryLaunchLease, factoryLaunchPackage(first), gpu);
  expect((await store.claimStart(first.authority.attemptId)).claimed).toBe(true);
  const repeat = await store.claimStart(first.authority.attemptId);
  expect(repeat.claimed).toBe(false);
  expect(repeat.intent.state).toBe("launching");
});

test("a stale lease cannot re-key an attempt that already has a durable grant", async () => {
  await store.prepare(first, factoryLaunchLease, factoryLaunchPackage(first), gpu);
  await expect(store.prepare(first, { ...factoryLaunchLease, holderGeneration: factoryLaunchLease.holderGeneration + 1 }, factoryLaunchPackage(first), gpu)).rejects.toThrow("conflicts with the durable attempt");
});

test("a device grant with no held gpu-host never reaches the durable store", async () => {
  await expect(store.prepare(first, factoryLaunchLease, factoryLaunchPackage(first), { devices: ["/dev/kfd"] })).rejects.toThrow("requires a held gpu-host allocation");
  await expect(store.prepare(first, factoryLaunchLease, factoryLaunchPackage(first), { gpuHosts: 1, devices: ["/dev/mem"] })).rejects.toThrow("outside the authorized runner profile");
});

test("a tampered durable device grant is refused rather than launched", async () => {
  await store.prepare(first, factoryLaunchLease, factoryLaunchPackage(first), gpu);
  await fixture.db.execute(sql`UPDATE factory_attempt_launches SET device_grant_json='{"devices":["/dev/kfd","/dev/dri/renderD128","/dev/dri/renderD129"],"cdiDevices":[],"capabilities":["compute","utility"]}'::jsonb WHERE attempt_id=${first.authority.attemptId}`);
  await expect(store.claimStart(first.authority.attemptId)).rejects.toThrow("device grant digest is invalid");
});
