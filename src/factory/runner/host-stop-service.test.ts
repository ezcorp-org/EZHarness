/**
 * The host stop route stops only the guests of the tenant its caller is bound
 * to (W01i).
 *
 * The guest's tenant is the one the host recorded when the guest was launched
 * or reattached, else the one the stop request names. Every refusal happens
 * before the supervisor is called, so no process group is touched for it.
 */
import { afterAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryPrivateRequest } from "../private-https";
import { FACTORY_HOST_STOP_PATH, createFactoryHostStopRouteHandler, type FactoryHostStopCommand } from "./host-stop-service";
import { FactoryHostGuestTenants } from "./host-peer-tenants";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))); });

const hostId = "stop-host";
const workerId = "worker-stop";
const peerTenants = { "peer-a": "tenant-a", "peer-b": "tenant-b" };
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });

async function signingKey() {
  const root = await mkdtemp(join(tmpdir(), "factory-host-stop-tenant-"));
  directories.push(root);
  const privateKeyPath = join(root, "host.pem");
  const keyIdPath = join(root, "host.kid");
  await writeFile(privateKeyPath, key.privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
  await writeFile(keyIdPath, "stop-key\n", { mode: 0o600 });
  return { hostId, privateKeyPath, keyIdPath };
}

async function route(recorded?: string) {
  const stops: FactoryHostStopCommand[] = [];
  const guestTenants = new FactoryHostGuestTenants();
  if (recorded !== undefined) guestTenants.record(workerId, recorded);
  const handle = createFactoryHostStopRouteHandler({
    hostId,
    peerTenants,
    guestTenants,
    signingKey: await signingKey(),
    supervisor: {
      async stop(command) {
        stops.push(command);
        const { tenantId: _tenant, ...coordinates } = command;
        return { schemaVersion: "factory.physical-stop.v1", ...coordinates, processGroupAbsent: true, stoppedAtMs: 1 };
      },
    },
  });
  return { handle, stops };
}

function stop(peerIdentity: string, tenantId?: string): FactoryPrivateRequest {
  const body = { attemptId: "attempt-stop", reservationId: "reservation-stop", workerId, holderGeneration: 1, allocationGeneration: 1, hostId, reason: "cancelled", ...(tenantId === undefined ? {} : { tenantId }) };
  return { peerIdentity, method: "POST", path: FACTORY_HOST_STOP_PATH, headers: { "x-ezcorp-factory-version": "1", "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) };
}

const answer = (response: { status: number; body: Uint8Array }) => ({ status: response.status, body: JSON.parse(Buffer.from(response.body).toString("utf8")) as unknown });
const forbidden = { status: 403, body: { error: "forbidden_tenant" } };

test("the recorded tenant decides a stop that names none: its own peer stops it, another tenant's peer cannot", async () => {
  const { handle, stops } = await route("tenant-a");
  expect(answer(await handle(stop("peer-b")))).toEqual(forbidden);
  expect(stops).toEqual([]);
  const own = answer(await handle(stop("peer-a")));
  expect(own.status).toBe(200);
  expect(own.body).toMatchObject({ workerId, hostId, processGroupAbsent: true, hostKeyId: "stop-key" });
  expect(stops).toHaveLength(1);
});

test("a named tenant decides a stop for a guest this host has no record of", async () => {
  const { handle, stops } = await route();
  // Named as another tenant's guest by a peer bound to tenant-a: refused.
  expect(answer(await handle(stop("peer-a", "tenant-b")))).toEqual(forbidden);
  expect(stops).toEqual([]);
  expect((await handle(stop("peer-a", "tenant-a"))).status).toBe(200);
  expect(stops.map((command) => command.tenantId)).toEqual(["tenant-a"]);
});

test("a named tenant never overrides the recorded one", async () => {
  const { handle, stops } = await route("tenant-b");
  // peer-a names its own tenant for tenant-b's guest: the record wins.
  expect(answer(await handle(stop("peer-a", "tenant-a")))).toEqual(forbidden);
  // Even the right peer is refused when the name contradicts the record.
  expect(answer(await handle(stop("peer-b", "tenant-a")))).toEqual(forbidden);
  expect(stops).toEqual([]);
  expect((await handle(stop("peer-b", "tenant-b"))).status).toBe(200);
});

test("a guest whose tenant is known neither way is refused, and an unknown peer stays 401", async () => {
  const { handle, stops } = await route();
  expect(answer(await handle(stop("peer-a")))).toEqual(forbidden);
  expect(answer(await handle(stop("peer-unknown", "tenant-a")))).toEqual({ status: 401, body: { error: "unauthorized" } });
  expect(answer(await handle(stop("peer-a", "")))).toEqual({ status: 400, body: { error: "invalid_tenant" } });
  expect(stops).toEqual([]);
});

test("the guest tenant record keeps a bounded window, oldest first", () => {
  const tenants = new FactoryHostGuestTenants(2);
  tenants.record("w1", "tenant-a");
  tenants.record("w2", "tenant-b");
  // Recording w1 again makes it the newest, so w2 is the oldest when w3 arrives.
  tenants.record("w1", "tenant-a");
  tenants.record("w3", "tenant-c");
  expect([tenants.of("w1"), tenants.of("w2"), tenants.of("w3")]).toEqual(["tenant-a", undefined, "tenant-c"]);
});
