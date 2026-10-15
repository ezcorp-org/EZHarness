import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { factoryRejection, makeFactoryPrivateRoot, removeFactoryPrivateRoot, writeModeFile } from "../../__tests__/helpers/factory-private-root";
import { FACTORY_TEMPORAL_CONTROL_SUBJECT, type FactoryTemporalAuthorityPaths, type FactoryTemporalClientCredential } from "./temporal";
import { factoryTemporalAccessProbe, factoryTemporalNamespaceAdmin, loadFactoryTemporalClient, type FactoryTemporalControlIdentity, type FactoryTemporalEndpoint } from "./temporal-client";

let tokenKeyPem: string;
let publicKeyPem: string;
beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  tokenKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
});

let root: string;
let endpoint: FactoryTemporalEndpoint;
let control: FactoryTemporalControlIdentity;
let authority: FactoryTemporalAuthorityPaths;
let credential: FactoryTemporalClientCredential;

beforeEach(async () => {
  root = await makeFactoryPrivateRoot();
  const operator = join(root, "operator"), tenant = join(root, "tenant");
  await mkdir(operator, { mode: 0o700 });
  await mkdir(tenant, { mode: 0o700 });
  endpoint = { address: "127.0.0.1:7233", serverName: "temporal.local", caCertificatePath: await writeModeFile(join(operator, "server-ca.crt"), "OPERATOR-CA") };
  control = { certificatePath: await writeModeFile(join(operator, "control.crt"), "CONTROL-CRT"), privateKeyPath: await writeModeFile(join(operator, "control.key"), "CONTROL-KEY") };
  authority = { caCertificatePath: endpoint.caCertificatePath, caKeyPath: join(operator, "ca.key"), tokenKeyPath: await writeModeFile(join(operator, "token.key"), tokenKeyPem), tokenKeyId: "factory-local", revocationsPath: join(operator, "revocations.json") };
  credential = {
    caCertificatePath: await writeModeFile(join(tenant, "temporal-ca.crt"), "TENANT-CA"),
    certificatePath: await writeModeFile(join(tenant, "temporal-client.crt"), "TENANT-CRT"),
    privateKeyPath: await writeModeFile(join(tenant, "temporal-client.key"), "TENANT-KEY"),
    tokenPath: await writeModeFile(join(tenant, "temporal-token"), "tenant.token.value\n"),
  };
});
afterEach(async () => { await removeFactoryPrivateRoot(root); });

type Call = { method: "register" | "describe"; request: Record<string, unknown> };

/** A fake `@temporalio/client`: records every connect, call, and close. */
function fakeClient(behaviour: { connect?: () => Promise<never>; register?: () => Promise<unknown>; describe?: () => Promise<{ namespaceInfo?: { description?: string | null } | null }> } = {}) {
  const connects: Array<Record<string, unknown>> = [];
  const calls: Call[] = [];
  let closed = 0;
  const module = {
    Connection: {
      async connect(options: Record<string, unknown>) {
        connects.push(options);
        if (behaviour.connect) return behaviour.connect();
        return {
          workflowService: {
            async registerNamespace(request: Record<string, unknown>) { calls.push({ method: "register", request }); return behaviour.register ? behaviour.register() : {}; },
            async describeNamespace(request: { namespace: string }) { calls.push({ method: "describe", request }); return behaviour.describe ? behaviour.describe() : { namespaceInfo: { description: "marker" } }; },
          },
          async close() { closed += 1; },
        };
      },
    },
  };
  return { client: async () => module, connects, calls, closed: () => closed };
}

function grpcError(code: unknown): Error { return Object.assign(new Error(`grpc ${String(code)}`), { code }); }

function tokenClaims(authorization: string): Record<string, unknown> {
  const token = authorization.replace(/^Bearer /, "");
  const [header, payload, signature] = token.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  expect(verifier.verify(createPublicKey(publicKeyPem), Buffer.from(signature!, "base64url"))).toBe(true);
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("factoryTemporalNamespaceAdmin", () => {
  test("register connects with the control identity and a short-lived control token, then closes", async () => {
    const fake = fakeClient();
    await factoryTemporalNamespaceAdmin(endpoint, control, authority, fake.client).register("tenant-01.fleet-a", "factory-provisioner:fleet-a:inst-1");
    expect(fake.calls).toEqual([{ method: "register", request: {
      namespace: "tenant-01.fleet-a", description: "factory-provisioner:fleet-a:inst-1", workflowExecutionRetentionPeriod: { seconds: 30 * 24 * 60 * 60 },
      historyArchivalState: 2, historyArchivalUri: "file:///tmp/factory-temporal-archival/history/tenant-01.fleet-a",
      visibilityArchivalState: 2, visibilityArchivalUri: "file:///tmp/factory-temporal-archival/visibility/tenant-01.fleet-a",
    } }]);
    expect(fake.closed()).toBe(1);
    const options = fake.connects[0] as { address: string; tls: { serverNameOverride: string; serverRootCACertificate: Buffer; clientCertPair: { crt: Buffer; key: Buffer } }; metadata: { authorization: string }; connectTimeout: number };
    expect(options.address).toBe("127.0.0.1:7233");
    expect(options.connectTimeout).toBe(10_000);
    expect(options.tls.serverNameOverride).toBe("temporal.local");
    expect(options.tls.serverRootCACertificate.toString()).toBe("OPERATOR-CA");
    expect(options.tls.clientCertPair.crt.toString()).toBe("CONTROL-CRT");
    expect(options.tls.clientCertPair.key.toString()).toBe("CONTROL-KEY");
    const claims = tokenClaims(options.metadata.authorization);
    expect(claims.sub).toBe(FACTORY_TEMPORAL_CONTROL_SUBJECT);
    expect(claims.permissions).toEqual(["admin:temporal-system"]);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
  });

  test("register treats ALREADY_EXISTS (6) as success", async () => {
    const fake = fakeClient({ register: async () => { throw grpcError(6); } });
    expect(await factoryTemporalNamespaceAdmin(endpoint, control, authority, fake.client).register("ns", "m")).toBeUndefined();
    expect(fake.closed()).toBe(1);
  });

  for (const code of [7, "6", undefined]) {
    test(`register fails by name on code ${String(code)} and still closes`, async () => {
      const fake = fakeClient({ register: async () => { throw grpcError(code); } });
      const error = await factoryRejection(factoryTemporalNamespaceAdmin(endpoint, control, authority, fake.client).register("ns", "m"));
      expect(error.code).toBe("temporal_register_failed");
      expect(error.message).toBe("Namespace ns could not be registered.");
      expect(fake.closed()).toBe(1);
    });
  }

  test("register fails by name when the service throws null", async () => {
    const fake = fakeClient({ register: async () => { throw null; } });
    expect((await factoryRejection(factoryTemporalNamespaceAdmin(endpoint, control, authority, fake.client).register("ns", "m"))).code).toBe("temporal_register_failed");
  });

  test("owner returns the recorded description", async () => {
    const fake = fakeClient({ describe: async () => ({ namespaceInfo: { description: "factory-provisioner:fleet-a:inst-1" } }) });
    expect(await factoryTemporalNamespaceAdmin(endpoint, control, authority, fake.client).owner("tenant-01.fleet-a")).toBe("factory-provisioner:fleet-a:inst-1");
    expect(fake.calls).toEqual([{ method: "describe", request: { namespace: "tenant-01.fleet-a" } }]);
    expect(fake.closed()).toBe(1);
  });

  for (const [name, answer] of [["no namespace info", {}], ["null namespace info", { namespaceInfo: null }], ["a null description", { namespaceInfo: { description: null } }]] as const) {
    test(`owner of an existing namespace with ${name} is the empty marker, never undefined`, async () => {
      const fake = fakeClient({ describe: async () => answer });
      expect(await factoryTemporalNamespaceAdmin(endpoint, control, authority, fake.client).owner("ns")).toBe("");
    });
  }

  test("owner of an absent namespace (NOT_FOUND, 5) is undefined", async () => {
    const fake = fakeClient({ describe: async () => { throw grpcError(5); } });
    expect(await factoryTemporalNamespaceAdmin(endpoint, control, authority, fake.client).owner("ns")).toBeUndefined();
    expect(fake.closed()).toBe(1);
  });

  test("owner fails by name on any other code, and names the code", async () => {
    const fake = fakeClient({ describe: async () => { throw grpcError(14); } });
    const error = await factoryRejection(factoryTemporalNamespaceAdmin(endpoint, control, authority, fake.client).owner("ns"));
    expect(error.code).toBe("temporal_describe_failed");
    expect(error.message).toBe("Namespace ns could not be described (code 14).");
  });

  test("owner names an error without a numeric code as unknown", async () => {
    const fake = fakeClient({ describe: async () => { throw new Error("socket hang up"); } });
    expect((await factoryRejection(factoryTemporalNamespaceAdmin(endpoint, control, authority, fake.client).owner("ns"))).message).toBe("Namespace ns could not be described (code unknown).");
  });

  test("a missing token key fails before any connection is opened", async () => {
    const fake = fakeClient();
    const error = await factoryRejection(factoryTemporalNamespaceAdmin(endpoint, control, { ...authority, tokenKeyPath: join(root, "operator", "absent.key") }, fake.client).owner("ns"));
    expect(error.code).toBe("ENOENT");
    expect(fake.connects).toEqual([]);
  });

  test("a connection failure propagates from administration", async () => {
    const fake = fakeClient({ connect: async () => { throw grpcError(14); } });
    expect((await factoryRejection(factoryTemporalNamespaceAdmin(endpoint, control, authority, fake.client).register("ns", "m"))).message).toBe("grpc 14");
  });
});

describe("factoryTemporalAccessProbe", () => {
  test("a credential that can describe its namespace answers true, presenting the tenant's own pair and trimmed token", async () => {
    const fake = fakeClient();
    expect(await factoryTemporalAccessProbe(endpoint, fake.client).describe("tenant-01.fleet-a", credential)).toBe(true);
    const options = fake.connects[0] as { tls: { serverNameOverride: string; serverRootCACertificate: Buffer; clientCertPair: { crt: Buffer; key: Buffer } }; metadata: { authorization: string } };
    expect(options.tls.serverRootCACertificate.toString()).toBe("TENANT-CA");
    expect(options.tls.clientCertPair.crt.toString()).toBe("TENANT-CRT");
    expect(options.tls.clientCertPair.key.toString()).toBe("TENANT-KEY");
    expect(options.tls.serverNameOverride).toBe("temporal.local");
    expect(options.metadata.authorization).toBe("Bearer tenant.token.value");
    expect(fake.calls).toEqual([{ method: "describe", request: { namespace: "tenant-01.fleet-a" } }]);
    expect(fake.closed()).toBe(1);
  });

  for (const code of [7, 16, 5]) {
    test(`a denial with code ${code} answers false and closes`, async () => {
      const fake = fakeClient({ describe: async () => { throw grpcError(code); } });
      expect(await factoryTemporalAccessProbe(endpoint, fake.client).describe("ns", credential)).toBe(false);
      expect(fake.closed()).toBe(1);
    });
  }

  test("a credential the gateway refuses at connect answers false", async () => {
    const fake = fakeClient({ connect: async () => { throw grpcError(16); } });
    expect(await factoryTemporalAccessProbe(endpoint, fake.client).describe("ns", credential)).toBe(false);
    expect(fake.closed()).toBe(0);
  });

  test("any other failure is not a denial: it fails by name with the code", async () => {
    const fake = fakeClient({ describe: async () => { throw grpcError(13); } });
    const error = await factoryRejection(factoryTemporalAccessProbe(endpoint, fake.client).describe("ns", credential));
    expect(error.code).toBe("temporal_probe_failed");
    expect(error.message).toBe("The namespace probe failed with code 13.");
    expect(fake.closed()).toBe(1);
  });

  test("a failure without a code is named unknown", async () => {
    const fake = fakeClient({ describe: async () => { throw "boom"; } });
    expect((await factoryRejection(factoryTemporalAccessProbe(endpoint, fake.client).describe("ns", credential))).message).toBe("The namespace probe failed with code unknown.");
  });

  test("a missing token fails before connecting", async () => {
    const fake = fakeClient();
    expect((await factoryRejection(factoryTemporalAccessProbe(endpoint, fake.client).describe("ns", { ...credential, tokenPath: join(root, "tenant", "absent") }))).code).toBe("ENOENT");
    expect(fake.connects).toEqual([]);
  });
});

describe("loadFactoryTemporalClient and the default client", () => {
  let refusing: Server;
  let refusingPort = 0;
  beforeAll(async () => {
    refusing = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve_) => refusing.listen(0, "127.0.0.1", () => resolve_()));
    refusingPort = (refusing.address() as { port: number }).port;
  });
  afterAll(async () => { await new Promise<void>((resolve_) => refusing.close(() => resolve_())); });

  test("resolves @temporalio/client from the orchestrator package, once", async () => {
    const first = loadFactoryTemporalClient();
    const module = await first;
    expect(typeof module.Connection.connect).toBe("function");
    expect(loadFactoryTemporalClient("/nonexistent-root")).toBe(first);
  });

  test("the default access probe loads the real client and answers false when the gateway drops the connection", async () => {
    expect(await factoryTemporalAccessProbe({ ...endpoint, address: `127.0.0.1:${refusingPort}` }).describe("ns", credential)).toBe(false);
  });

  test("the default admin loads the real client and propagates a failed connection", async () => {
    const error = await factoryRejection(factoryTemporalNamespaceAdmin({ ...endpoint, address: `127.0.0.1:${refusingPort}` }, control, authority).owner("ns"));
    expect(error).toBeInstanceOf(Error);
    expect(error.message.length).toBeGreaterThan(0);
  });
});
