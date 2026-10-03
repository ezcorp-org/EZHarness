/**
 * Which tenant each mutual-TLS peer of a host acts for (W01i).
 *
 * A host serves every installation of its fleet, and each installation is one
 * tenant. The host's launch and stop routes used to authorize by peer only, so
 * one installation could launch, reattach to, read, or stop a guest attributed
 * to another tenant. Every peer is now bound to exactly one tenant, and a
 * request for another tenant's guest is refused `403 forbidden_tenant` before
 * the supervisor is called: no admission, lease acknowledgement, container
 * start, or stop happens for it.
 *
 * A leaf: the launch route, the stop route and the supervisor's document parser
 * read the same definition.
 */

/** mTLS peer identity to the one tenant that peer acts for. */
export type FactoryHostPeerTenants = Readonly<Record<string, string>>;

/** The refusal for a request whose guest belongs to a tenant the peer does not act for. */
export const FACTORY_HOST_FORBIDDEN_TENANT = "forbidden_tenant";

/** At most this many peers per host: one per installation the host serves. */
export const FACTORY_HOST_MAX_PEERS = 64;

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value
    && [...value].every((character) => (character.codePointAt(0) ?? 0) >= 0x20);
}

/** Whether `value` is a complete peer-to-tenant map: 1 to 64 entries, every key and value an exact identity. */
export function isFactoryHostPeerTenants(value: unknown): value is FactoryHostPeerTenants {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length >= 1 && entries.length <= FACTORY_HOST_MAX_PEERS && entries.every(([peer, tenant]) => identity(peer) && identity(tenant));
}

/** A frozen lookup over a validated map. Throws when the map binds no peer or is malformed. */
export function factoryHostPeerTenantLookup(value: FactoryHostPeerTenants): ReadonlyMap<string, string> {
  if (!isFactoryHostPeerTenants(value)) throw new Error("Factory host services need at least one authorized peer bound to its tenant.");
  return new Map(Object.entries(value));
}

/**
 * The tenant each guest this host process launched or reattached belongs to.
 *
 * The launch route records it once the intent's tenant matched the peer's, and
 * the stop route reads it for a stop request that names no tenant. It is
 * bounded: the oldest record goes first, and a guest older than the bound is
 * stopped only by a request that names its tenant.
 */
export class FactoryHostGuestTenants {
  readonly #tenants = new Map<string, string>();
  // An explicit field, not a parameter property, so Node's type stripping can run this file.
  readonly #limit: number;
  constructor(limit = 4_096) { this.#limit = limit; }

  record(workerId: string, tenantId: string): void {
    this.#tenants.delete(workerId);
    this.#tenants.set(workerId, tenantId);
    if (this.#tenants.size > this.#limit) this.#tenants.delete(this.#tenants.keys().next().value as string);
  }

  of(workerId: string): string | undefined {
    return this.#tenants.get(workerId);
  }
}
