import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certificates } from "../__tests__/helpers/factory-certificates";
import { factoryLaunchTenant } from "../__tests__/helpers/factory-attempt-launch-fixture";
import { createFactoryHostPreparationClient } from "./host-preparation-client";
import { FactoryHostPreparationError } from "./package-preparation";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))); });

test("before its first build the supervisor client answers host_preparation_not_built, the one answer on which a preparation builds (W4H-32)", async () => {
  const certs = await certificates(directories, "tenant-a");
  const root = await mkdtemp(join(tmpdir(), "factory-host-preparation-client-"));
  directories.push(root);
  const tls = { caPath: join(root, "ca.pem"), certificatePath: join(root, "client.pem"), privateKeyPath: join(root, "client.key"), serviceTokenPath: join(root, "token") };
  await writeFile(tls.caPath, certs.ca);
  await writeFile(tls.certificatePath, certs.clientCert);
  await writeFile(tls.privateKeyPath, certs.clientKey);
  await writeFile(tls.serviceTokenPath, "unused-by-the-host-route");
  // No request is sent: the answer comes from the client's own record of what it has built.
  const client = await createFactoryHostPreparationClient({ baseUrl: "https://localhost:9/", serverName: "localhost", tls, tenantId: factoryLaunchTenant });
  const answer = await client.collectArtifacts("a".repeat(64)).catch((error: unknown) => error);
  expect(answer).toBeInstanceOf(FactoryHostPreparationError);
  expect(answer).toMatchObject({ code: "host_preparation_not_built" });
});
