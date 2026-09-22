import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { certificates, type Certificates } from "../../__tests__/helpers/factory-certificates";
import { startFactoryPrivateHttps, type FactoryPrivateResponse } from "../private-https";
import { createPoolCheckpointClient, type PoolCheckpointClient } from "./client";

const directories: string[] = [];
let client: PoolCheckpointClient;
let server: ReturnType<typeof startFactoryPrivateHttps>;
let reply: FactoryPrivateResponse;
let certs: Certificates;
const bodies: unknown[] = [];

const json = (value: unknown, status = 200): FactoryPrivateResponse => ({ status, body: Buffer.from(JSON.stringify(value)) });

beforeAll(async () => {
  certs = await certificates(directories);
  const directory = directories.at(-1)!;
  const tokenPath = join(directory, "pool-token");
  await writeFile(tokenPath, "pool-client-token", { mode: 0o600 });
  server = startFactoryPrivateHttps({
    tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca },
    async handle(input) { bodies.push(JSON.parse(Buffer.from(input.body).toString())); return reply; },
  });
  client = await createPoolCheckpointClient({ tenantId: "tenant-a", baseUrl: server.url, serverName: "localhost", requestTimeoutMs: 2_000, tls: { caPath: join(directory, "ca.pem"), certificatePath: join(directory, "client.pem"), privateKeyPath: join(directory, "client.key"), serviceTokenPath: tokenPath } });
});
afterAll(async () => { server?.stop(); await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); });

describe("the pool checkpoint client", () => {
  test("reads a page and refuses another tenant's rows or a malformed page", async () => {
    reply = json({ position: "0/1", rows: [{ reservation_id: "r-1", tenant_id: "tenant-a" }], next: "r-1" });
    expect(await client.checkpoint(null)).toEqual({ position: "0/1", rows: [{ reservation_id: "r-1", tenant_id: "tenant-a" }], next: "r-1" });
    expect(bodies.at(-1)).toEqual({ after: null });
    reply = json({ position: "0/2", rows: [], next: null });
    expect((await client.checkpoint("r-1")).next).toBeNull();
    expect(bodies.at(-1)).toEqual({ after: "r-1" });
    reply = json({ position: "0/1", rows: [{ reservation_id: "r-9", tenant_id: "tenant-b" }], next: null });
    await expect(client.checkpoint(null)).rejects.toThrow("another tenant");
    reply = json({ position: "0/1", rows: "no", next: null });
    await expect(client.checkpoint(null)).rejects.toThrow();
    reply = json({ position: "0/1", rows: [], next: null, extra: 1 });
    await expect(client.checkpoint(null)).rejects.toThrow();
    reply = { status: 200, body: Buffer.from("{not json") };
    await expect(client.checkpoint(null)).rejects.toThrow("invalid checkpoint page");
  });

  test("sends a restore import and validates the three lists", async () => {
    reply = json({ present: ["r-1"], imported: ["r-2"], overcommitted: ["r-3"] });
    expect(await client.restoreImport([{ reservation_id: "r-2" }])).toEqual({ present: ["r-1"], imported: ["r-2"], overcommitted: ["r-3"] });
    expect(bodies.at(-1)).toEqual({ rows: [{ reservation_id: "r-2" }] });
    reply = json({ present: "r-1", imported: [], overcommitted: [] });
    await expect(client.restoreImport([])).rejects.toThrow("invalid present reservations");
    reply = json({ error: "forbidden" }, 403);
    await expect(client.restoreImport([])).rejects.toThrow();
  });
});
