import { verifyPoolToken, type PoolTokenVerifierOptions } from "./service-token";
import { FactoryPoolLedger, type PoolDecision, type PoolLease, type PoolLeaseStatus, type PoolResourceVector, type PoolSql, setupFactoryPoolLedger } from "./ledger";

export interface PoolTenantCertificate { tenantId: string; tokenSubject: string }
export interface PoolSupervisorCertificate { supervisorId: string; tokenSubject: string; hostIds: readonly string[] }
export interface PoolAdmissionIdentityConfig { tenants: Readonly<Record<string, PoolTenantCertificate>>; supervisors: Readonly<Record<string, PoolSupervisorCertificate>> }
export type PoolPrincipal = { kind: "tenant"; tenantId: string; subject: string; scopes: readonly string[] } | { kind: "supervisor"; supervisorId: string; subject: string; hostIds: readonly string[]; scopes: readonly string[] };
export interface PoolAdmissionRequest { reservationId: string; grantRevision: number; grantScope: string; resources: PoolResourceVector; admissionDeadline: string; priority?: number; readySequence?: number; nodeId?: string }
export interface PoolLeaseFenceInput { reservationId: string; grantRevision: number; allocationGeneration: number; allocationToken: string }
export interface PoolStopInput { reservationId: string; holderGeneration: number; hostId: string }
export interface PoolReimageInput extends PoolStopInput { receipt: string }

function opaque(value: string, label: string): void { if (typeof value !== "string" || value.length === 0 || value.length > 256 || [...value].some(character => character.codePointAt(0)! < 32)) throw new Error(`Pool ${label} is malformed.`); }
function counter(value: number, label: string, minimum = 0): void { if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Pool ${label} is malformed.`); }
function deadline(value: string): Date { const result = new Date(value); if (!Number.isFinite(result.getTime())) throw new Error("Pool admission deadline is malformed."); return result; }
function tenant(principal: PoolPrincipal): Extract<PoolPrincipal, { kind: "tenant" }> { if (principal.kind !== "tenant") throw new Error("Pool tenant endpoint requires a tenant certificate."); return principal; }
function supervisor(principal: PoolPrincipal): Extract<PoolPrincipal, { kind: "supervisor" }> { if (principal.kind !== "supervisor") throw new Error("Pool supervisor endpoint requires a supervisor certificate."); return principal; }
function scope(principal: PoolPrincipal, expected: string): void { if (!principal.scopes.includes(expected)) throw new Error("Pool token scope is denied."); }

/** A peer certificate chooses the configured role. The signed token must bind the same subject and audience. */
export function authenticatePoolPrincipal(certificateCommonName: string, bearerToken: string, identities: PoolAdmissionIdentityConfig, verifier: PoolTokenVerifierOptions): PoolPrincipal {
  opaque(certificateCommonName, "certificate identity");
  const claims = verifyPoolToken(bearerToken, verifier);
  const tenantIdentity = identities.tenants[certificateCommonName];
  if (tenantIdentity) {
    if (claims.sub !== tenantIdentity.tokenSubject) throw new Error("Pool token subject does not match the tenant certificate.");
    const principal: PoolPrincipal = { kind: "tenant", tenantId: tenantIdentity.tenantId, subject: claims.sub, scopes: claims.scope };
    scope(principal, `pool:tenant:${tenantIdentity.tenantId}`); return principal;
  }
  const supervisorIdentity = identities.supervisors[certificateCommonName];
  if (!supervisorIdentity || claims.sub !== supervisorIdentity.tokenSubject) throw new Error("Pool certificate identity is untrusted.");
  const principal: PoolPrincipal = { kind: "supervisor", supervisorId: supervisorIdentity.supervisorId, subject: claims.sub, hostIds: supervisorIdentity.hostIds, scopes: claims.scope };
  scope(principal, `pool:supervisor:${supervisorIdentity.supervisorId}`); return principal;
}

/** Authenticated C03 façade. Tenant IDs are derived only from a certificate/token identity, never request JSON. */
export class PoolAdmissionService {
  readonly ledger: FactoryPoolLedger;
  constructor(private readonly database: PoolSql, ledger?: FactoryPoolLedger) { this.ledger = ledger ?? new FactoryPoolLedger(database); }
  async setup(): Promise<void> { await setupFactoryPoolLedger(this.database); await this.database.unsafe("CREATE TABLE IF NOT EXISTS factory_pool_admission_grants (reservation_id text PRIMARY KEY, tenant_id text NOT NULL, grant_revision integer NOT NULL, grant_scope text NOT NULL, admission_deadline timestamptz NOT NULL)"); }
  async request(principal: PoolPrincipal, input: PoolAdmissionRequest): Promise<PoolDecision> {
    const identity = tenant(principal); opaque(input.reservationId, "reservation id"); opaque(input.grantScope, "grant scope"); counter(input.grantRevision, "grant revision", 1);
    const grantScope = input.grantScope;
    const expectedScope = `pool:grant:${grantScope}`; if (!grantScope.startsWith(`${identity.tenantId}:`)) throw new Error("Pool grant scope is not owned by the tenant."); scope(identity, expectedScope);
    const request = this.ledger.validateRequest({ reservationId: input.reservationId, tenantId: identity.tenantId, grantRevision: input.grantRevision, resources: input.resources, priority: input.priority, readySequence: input.readySequence, nodeId: input.nodeId, admissionDeadline: deadline(input.admissionDeadline) });
    await this.database.unsafe("INSERT INTO factory_pool_admission_grants(reservation_id, tenant_id, grant_revision, grant_scope, admission_deadline) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (reservation_id) DO NOTHING", [request.reservationId, request.tenantId, request.grantRevision, grantScope, request.admissionDeadline.toISOString()]);
    const existing = (await this.database.unsafe("SELECT tenant_id, grant_revision, grant_scope, admission_deadline FROM factory_pool_admission_grants WHERE reservation_id = $1", [request.reservationId])) as Array<{ tenant_id: string; grant_revision: number | string; grant_scope: string; admission_deadline: string }>;
    if (!existing[0] || existing[0].tenant_id !== request.tenantId || Number(existing[0].grant_revision) !== request.grantRevision || existing[0].grant_scope !== grantScope || new Date(existing[0].admission_deadline).getTime() !== request.admissionDeadline.getTime()) throw new Error("Pool reservation conflicts with a different authenticated grant.");
    const result = await this.ledger.request(request); await this.ledger.schedule(); return result;
  }
  async status(principal: PoolPrincipal, reservationId: string): Promise<PoolLeaseStatus | undefined> { const identity = tenant(principal); const value = await this.ledger.status(reservationId); if (value && value.tenantId !== identity.tenantId) throw new Error("Pool reservation is not owned by this tenant."); return value; }
  async acknowledgeStart(principal: PoolPrincipal, input: PoolLeaseFenceInput): Promise<PoolLease> { return this.ledger.acknowledgeStart({ ...this.fence(tenant(principal), input) }); }
  async renew(principal: PoolPrincipal, input: PoolLeaseFenceInput): Promise<PoolLease> { return this.ledger.renew({ ...this.fence(tenant(principal), input) }); }
  async cancel(principal: PoolPrincipal, reservationId: string, allocationGeneration: number): Promise<PoolLeaseStatus> { const identity = tenant(principal); const current = await this.status(identity, reservationId); if (!current) throw new Error("Pool reservation does not exist."); counter(allocationGeneration, "allocation generation", 1); const result = await this.ledger.cancel(reservationId, allocationGeneration); await this.ledger.schedule(); return result; }
  async confirmStopped(principal: PoolPrincipal, input: PoolStopInput): Promise<PoolLeaseStatus> { const identity = supervisor(principal); this.host(identity, input.hostId); const result = await this.ledger.confirmStopped(input); await this.ledger.schedule(); return result; }
  async confirmReimage(principal: PoolPrincipal, input: PoolReimageInput): Promise<PoolLeaseStatus> { const identity = supervisor(principal); this.host(identity, input.hostId); const result = await this.ledger.confirmGpuReimage(input); await this.ledger.schedule(); return result; }
  private fence(identity: Extract<PoolPrincipal, { kind: "tenant" }>, input: PoolLeaseFenceInput) { opaque(input.reservationId, "reservation id"); opaque(input.allocationToken, "allocation token"); counter(input.grantRevision, "grant revision", 1); counter(input.allocationGeneration, "allocation generation", 1); return { ...input, tenantId: identity.tenantId }; }
  private host(identity: Extract<PoolPrincipal, { kind: "supervisor" }>, hostId: string): void { opaque(hostId, "host id"); if (!identity.hostIds.includes(hostId)) throw new Error("Pool supervisor is not authorized for this host."); }
}
