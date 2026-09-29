/**
 * The operator-only hosted control plane (C12).
 *
 * A separate trusted service. It holds the tenant directory — tenant ID,
 * hostname, installation identity, contact, plan limits, membership references
 * — and the provisioning ledger, and nothing else about any customer: no
 * product fact, no artifact, no provider secret. It is reachable only over
 * mutual TLS by a client certificate the operator's authority issued to a
 * named operator; there is no tenant route to it and no route on it that
 * grants product access or consent.
 *
 * Every route is listed in `FACTORY_CONTROL_PLANE_ROUTES`, which the test
 * suite reads: an added route that reaches product state, consent, or a
 * credential value fails there.
 */
import { startFactoryPrivateHttps, type FactoryPrivateRequest, type FactoryPrivateResponse } from "../private-https";
import type { FactoryInstallationRecord } from "./ledger";
import type { FactoryBootstrapObserver, FactoryOperationActor, FactoryPurgeChecks, FactoryPurgeRequest, FactoryTeardownOutcome, LocalInstallation } from "./local";
import { FactoryProvisioningError, FACTORY_PROVISIONING_STEP_NAMES, factoryStepFailure, type FactoryProvisioningStepName } from "./steps";

/** What the control plane may do. Every route is an operator action on infrastructure. */
export const FACTORY_CONTROL_PLANE_ROUTES = Object.freeze([
  { method: "GET", path: "/v1/directory", action: "list the tenant directory" },
  { method: "GET", path: "/v1/installations/:tenant", action: "read one installation's phase, steps, and events" },
  { method: "POST", path: "/v1/installations/:tenant/provision", action: "provision or resume one installation" },
  { method: "POST", path: "/v1/installations/:tenant/observe", action: "record an observed human bootstrap" },
  { method: "POST", path: "/v1/installations/:tenant/rotate/:step", action: "rotate one step's credential" },
  { method: "POST", path: "/v1/installations/:tenant/teardown", action: "tear one installation down" },
  { method: "POST", path: "/v1/installations/:tenant/purge", action: "purge a torn-down installation under an administrator's installation-issued approval" },
] as const);

/** The directory fields the control plane may publish. Anything else is refused at the boundary. */
export const FACTORY_DIRECTORY_FIELDS = Object.freeze(["tenantId", "fleetId", "installationId", "hostname", "administratorEmail", "invitationId", "phase", "planLimits", "membershipRefs"] as const);

/** The provisioner surface the control plane drives. `LocalFactoryProvisioner` satisfies it. */
export interface FactoryControlPlaneProvisioner {
  provision(request: { readonly tenantId: string; readonly hostname: string; readonly administratorEmail: string }, options?: { readonly through?: FactoryProvisioningStepName; readonly planLimits?: Readonly<Record<string, number>> } & FactoryOperationActor): Promise<LocalInstallation>;
  observeBootstrap(tenantId: string, observer: FactoryBootstrapObserver, who?: FactoryOperationActor): Promise<LocalInstallation>;
  rotate(tenantId: string, step: Exclude<FactoryProvisioningStepName, "ingress">, who?: FactoryOperationActor): Promise<LocalInstallation>;
  teardown(tenantId: string, input: { readonly reason: string } & FactoryOperationActor): Promise<FactoryTeardownOutcome>;
  purge(tenantId: string, request: FactoryPurgeRequest & FactoryOperationActor, checks: FactoryPurgeChecks): Promise<LocalInstallation>;
  status(tenantId: string): Promise<LocalInstallation>;
  readonly ledger: { directory(): Promise<readonly FactoryInstallationRecord[]>; events(tenantId: string): Promise<readonly unknown[]> };
}

export interface FactoryControlPlaneOptions {
  readonly provisioner: FactoryControlPlaneProvisioner;
  /** Client-certificate common names of the operators allowed to call. */
  readonly operators: readonly string[];
  readonly observer: FactoryBootstrapObserver;
  readonly purgeChecks: FactoryPurgeChecks;
  readonly hostnameFor: (tenantId: string) => string;
}

const TENANT = /^tenant-\d{2}$/;
const MAX_BODY_BYTES = 16 * 1024;
/**
 * At most this many tenant operations run at once. Each holds one pooled
 * connection for its tenant lock and uses others for its work, so the cap
 * stays well under the provisioner's pool (8): four at once could hold every
 * connection and wait on each other.
 */
export const FACTORY_CONTROL_PLANE_CONCURRENCY = 3;

function respond(status: number, value: unknown): FactoryPrivateResponse {
  return { status, body: Buffer.from(JSON.stringify(value)), contentType: "application/json" };
}

/** A directory entry reduced to exactly the published fields. */
export function factoryDirectoryEntry(record: FactoryInstallationRecord): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(FACTORY_DIRECTORY_FIELDS.map((field) => [field, record[field]])));
}

/** A status reduced to references: step states and failure codes, never a resource value's secret. */
function statusView(installation: LocalInstallation): Readonly<Record<string, unknown>> {
  return Object.freeze({
    tenantId: installation.tenantId, installationId: installation.installationId, hostname: installation.hostname, phase: installation.phase,
    steps: installation.steps.map((step) => ({ step: step.step, ordinal: step.ordinal, owner: step.owner, state: step.state, attempts: step.attempts, failure: step.failure })),
  });
}

function body(request: FactoryPrivateRequest): Record<string, unknown> {
  if (request.body.byteLength === 0) return {};
  if (request.headers["content-type"] !== "application/json") throw new FactoryProvisioningError("control_request_invalid", "Control plane requests are JSON.");
  const parsed = JSON.parse(request.body.toString("utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new FactoryProvisioningError("control_request_invalid", "Control plane request bodies are JSON objects.");
  return parsed as Record<string, unknown>;
}

/**
 * The request handler, separate from the listener so every refusal is tested
 * without a socket. The listener has already verified the client certificate
 * against the operator authority; this checks the operator is named.
 */
export function factoryControlPlaneHandler(options: FactoryControlPlaneOptions): (request: FactoryPrivateRequest) => Promise<FactoryPrivateResponse> {
  const operators = new Set(options.operators);
  // An operation outlives any request (provisioning takes minutes), so a
  // mutating route ACCEPTS it and returns 202; the ledger is the progress
  // record, read back through GET. One operation per tenant at a time.
  const running = new Map<string, { readonly action: string; readonly done: Promise<void> }>();
  const last = new Map<string, { readonly action: string; readonly outcome: unknown }>();
  const accept = (tenantId: string, action: string, work: () => Promise<unknown>): FactoryPrivateResponse => {
    if (running.has(tenantId)) return respond(409, { error: "operation_in_progress", action: running.get(tenantId)!.action });
    if (running.size >= FACTORY_CONTROL_PLANE_CONCURRENCY) return respond(429, { error: "control_plane_busy", running: running.size });
    const done = work().then(
      (outcome) => { last.set(tenantId, { action, outcome }); },
      (error: unknown) => { const failure = factoryStepFailure(error); last.set(tenantId, { action, outcome: { error: error instanceof FactoryProvisioningError ? failure.code : "control_plane_failed", message: failure.message } }); },
    ).finally(() => { running.delete(tenantId); });
    running.set(tenantId, { action, done });
    return respond(202, { accepted: action, tenantId });
  };
  return async (request) => {
    if (!operators.has(request.peerIdentity)) return respond(403, { error: "operator_required" });
    if (request.body.byteLength > MAX_BODY_BYTES) return respond(413, { error: "request_too_large" });
    try {
      const segments = request.path.split("?")[0]!.split("/").filter(Boolean);
      if (request.method === "GET" && segments.join("/") === "v1/directory") return respond(200, { directory: (await options.provisioner.ledger.directory()).map(factoryDirectoryEntry) });
      if (segments[0] !== "v1" || segments[1] !== "installations" || !TENANT.test(segments[2] ?? "")) return respond(404, { error: "not_found" });
      const tenantId = segments[2]!;
      const action = segments.slice(3).join("/");
      if (request.method === "GET" && action === "") return respond(200, { installation: statusView(await options.provisioner.status(tenantId)), events: await options.provisioner.ledger.events(tenantId), running: running.get(tenantId)?.action ?? null, last: last.get(tenantId) ?? null });
      if (request.method !== "POST") return respond(405, { error: "method_not_allowed" });
      const input = body(request);
      // Every mutation is attributed on the ledger to the operator certificate that asked for it.
      const who: FactoryOperationActor = { actor: `operator:${request.peerIdentity}` };
      if (action === "provision") {
        const through = input.through;
        if (through !== undefined && !FACTORY_PROVISIONING_STEP_NAMES.includes(through as FactoryProvisioningStepName)) return respond(400, { error: "step_unknown" });
        if (typeof input.administratorEmail !== "string") return respond(400, { error: "administrator_email_required" });
        const planLimits = input.planLimits as Record<string, number> | undefined;
        const administratorEmail = input.administratorEmail;
        return accept(tenantId, "provision", async () => statusView(await options.provisioner.provision({ tenantId, hostname: options.hostnameFor(tenantId), administratorEmail }, { ...who, ...(through ? { through: through as FactoryProvisioningStepName } : {}), ...(planLimits ? { planLimits } : {}) })));
      }
      if (action === "observe") return accept(tenantId, "observe", async () => statusView(await options.provisioner.observeBootstrap(tenantId, options.observer, who)));
      if (segments[3] === "rotate" && segments.length === 5) {
        const step = segments[4] as FactoryProvisioningStepName;
        if (!FACTORY_PROVISIONING_STEP_NAMES.includes(step) || step === "ingress") return respond(400, { error: "step_not_rotatable" });
        return accept(tenantId, `rotate/${step}`, async () => statusView(await options.provisioner.rotate(tenantId, step, who)));
      }
      if (action === "teardown") {
        if (typeof input.reason !== "string" || input.reason.length === 0) return respond(400, { error: "reason_required" });
        const reason = input.reason;
        return accept(tenantId, "teardown", async () => { const outcome = await options.provisioner.teardown(tenantId, { reason, ...who }); return { installation: statusView(outcome.installation), residues: outcome.residues }; });
      }
      if (action === "purge") {
        if (typeof input.approvalId !== "string" || typeof input.reason !== "string") return respond(400, { error: "approval_required" });
        const purge = { approvalId: input.approvalId, reason: input.reason, ...who };
        return accept(tenantId, "purge", async () => statusView(await options.provisioner.purge(tenantId, purge, options.purgeChecks)));
      }
      return respond(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof FactoryProvisioningError) return respond(409, { error: error.code, message: error.message });
      if (error instanceof SyntaxError) return respond(400, { error: "request_invalid" });
      return respond(500, { error: "control_plane_failed" });
    }
  };
}

export interface FactoryControlPlaneListenerOptions extends FactoryControlPlaneOptions {
  readonly tls: { readonly key: string; readonly cert: string; readonly ca: string };
  readonly hostname: string;
  readonly port: number;
}

/** Bind the control plane: mutual TLS against the operator authority, loopback or a private interface only. */
export function startFactoryControlPlane(options: FactoryControlPlaneListenerOptions): { readonly url: string; stop(): void } {
  return startFactoryPrivateHttps({ tls: options.tls, hostname: options.hostname, port: options.port, maxBodyBytes: MAX_BODY_BYTES, maxResponseBytes: 4 * 1024 * 1024, handle: factoryControlPlaneHandler(options) });
}
