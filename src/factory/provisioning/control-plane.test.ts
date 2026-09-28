import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { request as httpsRequest } from "node:https";
import {
  makeFactoryPrivateRoot,
  makeFactoryTestAuthority,
  removeFactoryPrivateRoot,
} from "../../__tests__/helpers/factory-private-root";
import type { FactoryPrivateRequest } from "../private-https";
import { issueFactoryCertificate, type FactoryIssuedCertificate } from "./certificates";
import {
  FACTORY_CONTROL_PLANE_CONCURRENCY,
  FACTORY_CONTROL_PLANE_ROUTES,
  FACTORY_DIRECTORY_FIELDS,
  factoryControlPlaneHandler,
  factoryDirectoryEntry,
  startFactoryControlPlane,
  type FactoryControlPlaneOptions,
  type FactoryControlPlaneProvisioner,
} from "./control-plane";
import type { FactoryInstallationRecord } from "./ledger";
import type { FactoryBootstrapObserver, FactoryPurgeChecks, LocalInstallation } from "./local";
import { FactoryProvisioningError } from "./steps";

const OPERATOR = "operator-alice";
const WHO = { actor: `operator:${OPERATOR}` };

function installation(tenantId: string, phase: LocalInstallation["phase"] = "deployment_ready"): LocalInstallation {
  return {
    tenantId, installationId: `inst-${tenantId}`, hostname: `${tenantId}.factory.example`, phase,
    productDatabase: "factory_product_x", productRole: "factory_role_x", temporalNamespace: `${tenantId}.fleet-a`, secretBundlePath: `/secret/${tenantId}`,
    steps: [{ step: "database", ordinal: 1, owner: "provisioner", state: "complete", attempts: 1, failure: null, resources: { credentialsPath: "/secret/x" } } as never],
    state: "ready",
  };
}

function record(tenantId: string): FactoryInstallationRecord {
  return {
    tenantId, fleetId: "fleet-a", installationId: `inst-${tenantId}`, hostname: `${tenantId}.factory.example`, administratorEmail: "admin@example.com", invitationId: `invite-${tenantId}`,
    productDatabase: "factory_product_secret_name", productRole: "factory_role_secret_name", temporalNamespace: `${tenantId}.fleet-a`,
    secretDirectory: "/secrets/tenant", operatorDirectory: "/operator/tenant", phase: "invitation_issued", planLimits: { runs: 5 }, membershipRefs: ["member-1"],
  };
}

interface Deferred { resolve(): void; reject(error: unknown): void; promise: Promise<void> }
function deferred(): Deferred {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((settle, fail) => { resolve = settle; reject = fail; });
  return { resolve, reject, promise };
}

/** A recording provisioner. `gate` holds an operation open; `failWith` makes the next operation reject. */
function fakeProvisioner() {
  const calls: { method: string; args: unknown[] }[] = [];
  const state = { gate: undefined as Deferred | undefined, failWith: undefined as unknown, statusFailure: undefined as unknown, directoryFailure: undefined as unknown };
  const operate = async (method: string, args: unknown[], tenantId: string): Promise<LocalInstallation> => {
    calls.push({ method, args });
    if (state.gate) await state.gate.promise;
    if (state.failWith !== undefined) throw state.failWith;
    return installation(tenantId);
  };
  const provisioner: FactoryControlPlaneProvisioner = {
    provision: (request, options) => operate("provision", [request, options], request.tenantId),
    observeBootstrap: (tenantId, observer, who) => operate("observeBootstrap", [tenantId, observer, who], tenantId),
    rotate: (tenantId, step, who) => operate("rotate", [tenantId, step, who], tenantId),
    teardown: async (tenantId, input) => ({ installation: await operate("teardown", [tenantId, input], tenantId), residues: [{ step: "storage", failure: { code: "storage_identity_residue", message: "seeded" } }] }),
    purge: (tenantId, request, checks) => operate("purge", [tenantId, request, checks], tenantId),
    status: async (tenantId) => { if (state.statusFailure !== undefined) throw state.statusFailure; return installation(tenantId); },
    ledger: {
      directory: async () => { if (state.directoryFailure !== undefined) throw state.directoryFailure; return [record("tenant-01"), record("tenant-02")]; },
      events: async (tenantId) => [{ tenantId, event: "step_completed" }],
    },
  };
  return { provisioner, calls, state };
}

const observer: FactoryBootstrapObserver = { observe: async () => ({ complete: true }) as never };
const purgeChecks: FactoryPurgeChecks = { census: { count: async () => ({ active: 0, uncertain: 0 }) }, approvals: { verify: async () => ({ approvedBy: "admin:admin@example.com" }) } };
const APPROVAL = "0f8b2f7a-1c1d-4a4e-9a0b-6d1f2e3c4b5a";

function setup(overrides: Partial<FactoryControlPlaneOptions> = {}) {
  const fake = fakeProvisioner();
  const handle = factoryControlPlaneHandler({ provisioner: fake.provisioner, operators: [OPERATOR], observer, purgeChecks, hostnameFor: (tenantId) => `${tenantId}.factory.example`, ...overrides });
  const call = async (method: string, path: string, body?: unknown, options: { peer?: string; contentType?: string; raw?: Buffer } = {}) => {
    const bytes = options.raw ?? (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)));
    const request: FactoryPrivateRequest = { peerIdentity: options.peer ?? OPERATOR, method, path, headers: bytes.byteLength > 0 ? { "content-type": options.contentType ?? "application/json" } : {}, body: bytes };
    const response = await handle(request);
    expect(response.contentType).toBe("application/json");
    return { status: response.status, body: JSON.parse(Buffer.from(response.body).toString("utf8")) as Record<string, unknown> };
  };
  /** Poll GET until the tenant has no running operation; yields to the event loop between reads. */
  const settled = async (tenantId: string) => {
    for (let poll = 0; poll < 1_000; poll++) {
      const view = await call("GET", `/v1/installations/${tenantId}`);
      if (view.body.running === null) return view.body;
      await new Promise((settle) => setImmediate(settle));
    }
    throw new Error(`operation on ${tenantId} never settled`);
  };
  return { ...fake, call, settled };
}

describe("route table", () => {
  test("no route reaches product state, consent, grants, secrets, or artifacts", () => {
    for (const route of FACTORY_CONTROL_PLANE_ROUTES) {
      for (const forbidden of ["factories", "projects", "runs", "grants", "consent", "secrets", "artifacts"]) expect(route.path).not.toContain(forbidden);
      expect(route.path.startsWith("/v1/")).toBe(true);
      expect(["GET", "POST"]).toContain(route.method);
    }
  });

  test("every listed route is served", async () => {
    const { call, settled } = setup();
    const bodies: Record<string, unknown> = { provision: { administratorEmail: "admin@example.com" }, teardown: { reason: "customer left" }, purge: { approvalId: APPROVAL, reason: "approved" } };
    for (const route of FACTORY_CONTROL_PLANE_ROUTES) {
      const path = route.path.replace(":tenant", "tenant-01").replace(":step", "storage");
      const action = path.split("/")[4] ?? "";
      const response = await call(route.method, path, bodies[action]);
      expect([200, 202]).toContain(response.status);
      await settled("tenant-01");
    }
  });
});

describe("factoryControlPlaneHandler: who and how much", () => {
  test("a caller that is not a named operator is refused before anything is read", async () => {
    const { call, calls } = setup();
    for (const peer of ["operator-mallory", "", "OPERATOR-ALICE"]) {
      expect(await call("GET", "/v1/directory", undefined, { peer })).toEqual({ status: 403, body: { error: "operator_required" } });
      expect((await call("POST", "/v1/installations/tenant-01/provision", { administratorEmail: "a@b.co" }, { peer })).status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  test("a body over 16 KiB is refused; exactly 16 KiB is accepted", async () => {
    const { call } = setup();
    const envelope = (size: number) => { const base = JSON.stringify({ administratorEmail: "admin@example.com", pad: "" }); return Buffer.from(JSON.stringify({ administratorEmail: "admin@example.com", pad: "x".repeat(size - base.length) })); };
    expect(envelope(16 * 1024).byteLength).toBe(16 * 1024);
    expect(await call("POST", "/v1/installations/tenant-01/provision", undefined, { raw: envelope(16 * 1024 + 1) })).toEqual({ status: 413, body: { error: "request_too_large" } });
    expect((await call("POST", "/v1/installations/tenant-01/provision", undefined, { raw: envelope(16 * 1024) })).status).toBe(202);
  });
});

describe("factoryControlPlaneHandler: the directory", () => {
  test("entries carry exactly the published fields, never database names or secret paths", async () => {
    const { call } = setup();
    const response = await call("GET", "/v1/directory?verbose=1");
    expect(response.status).toBe(200);
    const directory = response.body.directory as Record<string, unknown>[];
    expect(directory.length).toBe(2);
    for (const entry of directory) expect(Object.keys(entry).sort()).toEqual([...FACTORY_DIRECTORY_FIELDS].sort());
    expect(JSON.stringify(directory)).not.toContain("secret_name");
    expect(JSON.stringify(directory)).not.toContain("/secrets/tenant");
    expect(directory[0]).toEqual({ tenantId: "tenant-01", fleetId: "fleet-a", installationId: "inst-tenant-01", hostname: "tenant-01.factory.example", administratorEmail: "admin@example.com", invitationId: "invite-tenant-01", phase: "invitation_issued", planLimits: { runs: 5 }, membershipRefs: ["member-1"] });
  });

  test("factoryDirectoryEntry is frozen", () => {
    expect(Object.isFrozen(factoryDirectoryEntry(record("tenant-03")))).toBe(true);
  });
});

describe("factoryControlPlaneHandler: operations", () => {
  test("provision is accepted with 202, runs in the background, and GET shows running then the last outcome", async () => {
    const { call, calls, state, settled } = setup();
    state.gate = deferred();
    expect(await call("POST", "/v1/installations/tenant-01/provision", { administratorEmail: "admin@example.com", through: "storage", planLimits: { runs: 3 } })).toEqual({ status: 202, body: { accepted: "provision", tenantId: "tenant-01" } });
    const during = await call("GET", "/v1/installations/tenant-01");
    expect(during.body).toMatchObject({ running: "provision", last: null, events: [{ tenantId: "tenant-01", event: "step_completed" }] });
    expect(calls[0]).toEqual({ method: "provision", args: [{ tenantId: "tenant-01", hostname: "tenant-01.factory.example", administratorEmail: "admin@example.com" }, { ...WHO, through: "storage", planLimits: { runs: 3 } }] });
    state.gate.resolve();
    const after = await settled("tenant-01");
    expect(after.last).toMatchObject({ action: "provision", outcome: { tenantId: "tenant-01", phase: "deployment_ready" } });
    // The status view exposes step states, never a step's resource values.
    expect(JSON.stringify(after)).not.toContain("credentialsPath");
    expect((after.installation as { steps: unknown[] }).steps).toEqual([{ step: "database", ordinal: 1, owner: "provisioner", state: "complete", attempts: 1, failure: null }]);
  });

  test("provision without through or plan limits passes only the operator", async () => {
    const { call, calls, settled } = setup();
    await call("POST", "/v1/installations/tenant-02/provision", { administratorEmail: "admin@example.com" });
    await settled("tenant-02");
    expect(calls[0]!.args[1]).toEqual(WHO);
  });

  test("operations beyond the concurrency cap are refused 429 until one finishes", async () => {
    const { call, state, settled } = setup();
    state.gate = deferred();
    const tenants = Array.from({ length: FACTORY_CONTROL_PLANE_CONCURRENCY }, (_, index) => `tenant-${String(index + 10)}`);
    for (const tenantId of tenants) expect((await call("POST", `/v1/installations/${tenantId}/observe`)).status).toBe(202);
    expect(await call("POST", "/v1/installations/tenant-20/observe")).toEqual({ status: 429, body: { error: "control_plane_busy", running: FACTORY_CONTROL_PLANE_CONCURRENCY } });
    state.gate.resolve();
    for (const tenantId of tenants) await settled(tenantId);
    expect((await call("POST", "/v1/installations/tenant-20/observe")).status).toBe(202);
    await settled("tenant-20");
  });

  test("a second mutation on the same tenant is refused while one runs; another tenant is not blocked", async () => {
    const { call, state, settled } = setup();
    state.gate = deferred();
    expect((await call("POST", "/v1/installations/tenant-01/teardown", { reason: "leaving" })).status).toBe(202);
    expect(await call("POST", "/v1/installations/tenant-01/provision", { administratorEmail: "admin@example.com" })).toEqual({ status: 409, body: { error: "operation_in_progress", action: "teardown" } });
    expect((await call("POST", "/v1/installations/tenant-02/observe")).status).toBe(202);
    state.gate.resolve();
    expect((await settled("tenant-01")).last).toMatchObject({ action: "teardown", outcome: { residues: [{ step: "storage" }] } });
    await settled("tenant-02");
    expect((await call("POST", "/v1/installations/tenant-01/observe")).status).toBe(202);
    await settled("tenant-01");
  });

  test("observe, rotate, teardown and purge reach the provisioner with their inputs", async () => {
    const { call, calls, settled } = setup();
    for (const [path, body] of [["observe", undefined], ["rotate/database", undefined], ["rotate/deployment", undefined], ["teardown", { reason: "customer left" }], ["purge", { approvalId: APPROVAL, reason: "approved" }]] as const) {
      expect((await call("POST", `/v1/installations/tenant-01/${path}`, body)).status).toBe(202);
      await settled("tenant-01");
    }
    expect(calls).toEqual([
      { method: "observeBootstrap", args: ["tenant-01", observer, WHO] },
      { method: "rotate", args: ["tenant-01", "database", WHO] },
      { method: "rotate", args: ["tenant-01", "deployment", WHO] },
      { method: "teardown", args: ["tenant-01", { reason: "customer left", ...WHO }] },
      { method: "purge", args: ["tenant-01", { approvalId: APPROVAL, reason: "approved", ...WHO }, purgeChecks] },
    ]);
  });

  test("a failed operation is recorded as its error code; an unexpected one as control_plane_failed", async () => {
    const { call, state, settled } = setup();
    state.failWith = new FactoryProvisioningError("database_unreachable", "PostgreSQL refused.");
    await call("POST", "/v1/installations/tenant-01/rotate/storage");
    expect((await settled("tenant-01")).last).toEqual({ action: "rotate/storage", outcome: { error: "database_unreachable", message: "PostgreSQL refused." } });
    state.failWith = new TypeError("boom");
    await call("POST", "/v1/installations/tenant-01/observe");
    expect((await settled("tenant-01")).last).toEqual({ action: "observe", outcome: { error: "control_plane_failed", message: "boom" } });
    state.failWith = "a bare string";
    await call("POST", "/v1/installations/tenant-01/observe");
    expect((await settled("tenant-01")).last).toEqual({ action: "observe", outcome: { error: "control_plane_failed", message: "a bare string" } });
    state.failWith = new Error("connect postgres://factory:hunter2@127.0.0.1/db refused; password=hunter2");
    await call("POST", "/v1/installations/tenant-01/observe");
    const scrubbed = (await settled("tenant-01")).last;
    expect(scrubbed).toEqual({ action: "observe", outcome: { error: "control_plane_failed", message: "connect <url> refused; password=<redacted>" } });
    expect(JSON.stringify(scrubbed)).not.toContain("hunter2");
  });
});

describe("factoryControlPlaneHandler: refusals", () => {
  test("unknown paths and malformed tenants are not found", async () => {
    const { call, calls } = setup();
    for (const [method, path] of [["GET", "/"], ["GET", "/v2/directory"], ["GET", "/v1/installations"], ["GET", "/v1/installations/tenant-1"], ["GET", "/v1/installations/acme"], ["POST", "/v1/installations/tenant-01/unknown"], ["POST", "/v1/installations/tenant-01/rotate/storage/extra"], ["POST", "/v1/directory"], ["GET", "/v1/factories"]] as const) {
      expect(await call(method, path)).toEqual({ status: 404, body: { error: "not_found" } });
    }
    expect(calls).toEqual([]);
  });

  test("only GET reads and only POST mutates", async () => {
    const { call } = setup();
    for (const [method, path] of [["PUT", "/v1/installations/tenant-01"], ["DELETE", "/v1/installations/tenant-01/teardown"], ["GET", "/v1/installations/tenant-01/provision"]] as const) {
      expect(await call(method, path)).toEqual({ status: 405, body: { error: "method_not_allowed" } });
    }
  });

  test("bad step names are refused", async () => {
    const { call, calls } = setup();
    expect(await call("POST", "/v1/installations/tenant-01/provision", { administratorEmail: "a@b.co", through: "deploy" })).toEqual({ status: 400, body: { error: "step_unknown" } });
    for (const step of ["ingress", "nope", "consent"]) {
      expect(await call("POST", `/v1/installations/tenant-01/rotate/${step}`)).toEqual({ status: 400, body: { error: "step_not_rotatable" } });
    }
    expect(calls).toEqual([]);
  });

  test("missing fields are named", async () => {
    const { call, calls } = setup();
    expect(await call("POST", "/v1/installations/tenant-01/provision", {})).toEqual({ status: 400, body: { error: "administrator_email_required" } });
    expect(await call("POST", "/v1/installations/tenant-01/provision", { administratorEmail: 7 })).toEqual({ status: 400, body: { error: "administrator_email_required" } });
    for (const body of [undefined, {}, { reason: "" }, { reason: 1 }]) {
      expect(await call("POST", "/v1/installations/tenant-01/teardown", body)).toEqual({ status: 400, body: { error: "reason_required" } });
    }
    for (const body of [undefined, { approvalId: APPROVAL }, { reason: "approved" }, { approvalId: 1, reason: "approved" }, { approvedBy: "admin:a@b.co", reason: "approved" }]) {
      expect(await call("POST", "/v1/installations/tenant-01/purge", body)).toEqual({ status: 400, body: { error: "approval_required" } });
    }
    expect(calls).toEqual([]);
  });

  test("a body that is not JSON is 400; a JSON body that is not an object, or not declared JSON, is a named refusal", async () => {
    const { call } = setup();
    expect(await call("POST", "/v1/installations/tenant-01/teardown", undefined, { raw: Buffer.from("{reason:") })).toEqual({ status: 400, body: { error: "request_invalid" } });
    for (const raw of ["[1]", "null", "\"text\""]) {
      expect(await call("POST", "/v1/installations/tenant-01/teardown", undefined, { raw: Buffer.from(raw) })).toEqual({ status: 409, body: { error: "control_request_invalid", message: "Control plane request bodies are JSON objects." } });
    }
    expect(await call("POST", "/v1/installations/tenant-01/teardown", { reason: "x" }, { contentType: "text/plain" })).toEqual({ status: 409, body: { error: "control_request_invalid", message: "Control plane requests are JSON." } });
  });

  test("a provisioning error while reading is 409; any other failure is 500 without detail", async () => {
    const { call, state } = setup();
    state.statusFailure = new FactoryProvisioningError("installation_unknown", "No installation tenant-05.");
    expect(await call("GET", "/v1/installations/tenant-05")).toEqual({ status: 409, body: { error: "installation_unknown", message: "No installation tenant-05." } });
    state.directoryFailure = new Error("connection reset with password=hunter2");
    expect(await call("GET", "/v1/directory")).toEqual({ status: 500, body: { error: "control_plane_failed" } });
  });
});

describe("startFactoryControlPlane over mutual TLS", () => {
  let root: string;
  let authority: { certificatePath: string; keyPath: string; certificatePem: string };
  let clients: Record<"operator" | "intruder", FactoryIssuedCertificate>;
  let server: { readonly url: string; stop(): void };

  const send = (client: FactoryIssuedCertificate, method: string, path: string, body?: unknown) => new Promise<{ status: number; body: Record<string, unknown> }>((settle, fail) => {
    const url = new URL(server.url);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = httpsRequest({ host: url.hostname, port: Number(url.port), path, method, servername: "localhost", ca: authority.certificatePem, key: client.privateKeyPem, cert: client.certificatePem, headers: payload ? { "content-type": "application/json", "content-length": String(payload.byteLength) } : {} }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => settle({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.once("error", fail);
    request.end(payload);
  });

  beforeAll(async () => {
    root = await makeFactoryPrivateRoot();
    authority = await makeFactoryTestAuthority(root, "operator-ca");
    const serverCertificate = await issueFactoryCertificate(authority, { subject: "control-plane", usage: "server", dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"] });
    clients = {
      operator: await issueFactoryCertificate(authority, { subject: OPERATOR, usage: "client" }),
      intruder: await issueFactoryCertificate(authority, { subject: "operator-mallory", usage: "client" }),
    };
    const fake = fakeProvisioner();
    server = startFactoryControlPlane({
      provisioner: fake.provisioner, operators: [OPERATOR], observer, purgeChecks, hostnameFor: (tenantId) => `${tenantId}.factory.example`,
      tls: { key: serverCertificate.privateKeyPem, cert: serverCertificate.certificatePem, ca: authority.certificatePem }, hostname: "127.0.0.1", port: 0,
    });
  });
  afterAll(async () => {
    server?.stop();
    await removeFactoryPrivateRoot(root);
  });

  test("binds the requested loopback address on an ephemeral port", () => {
    const url = new URL(server.url);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("127.0.0.1");
    expect(Number(url.port)).toBeGreaterThan(0);
  });

  test("a named operator's client certificate reads the directory", async () => {
    const response = await send(clients.operator, "GET", "/v1/directory");
    expect(response.status).toBe(200);
    expect((response.body.directory as unknown[]).length).toBe(2);
  });

  test("a named operator's mutation is accepted", async () => {
    expect(await send(clients.operator, "POST", "/v1/installations/tenant-03/provision", { administratorEmail: "admin@example.com" })).toEqual({ status: 202, body: { accepted: "provision", tenantId: "tenant-03" } });
  });

  test("a client certificate from the same authority with an unlisted common name is refused 403", async () => {
    expect(await send(clients.intruder, "GET", "/v1/directory")).toEqual({ status: 403, body: { error: "operator_required" } });
  });
});
