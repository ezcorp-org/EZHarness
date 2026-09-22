/**
 * One installation as every provisioning step sees it, and the driver contract
 * each step implements.
 *
 * The context carries IDENTITIES and REFERENCES only. A step that generates a
 * credential writes it to the installation's private directory and records the
 * file's path; the value never enters the ledger, the directory, an error, or a
 * log line.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { FactoryProvisioningError, type FactoryProvisioningStepName } from "./steps";

export interface FactoryInstallationRequest {
  readonly tenantId: string;
  readonly hostname: string;
  readonly administratorEmail: string;
}

export interface FactoryInstallationContext extends FactoryInstallationRequest {
  /** The control plane this installation belongs to. Every derived name is scoped by it. */
  readonly fleetId: string;
  readonly installationId: string;
  readonly invitationId: string;
  readonly productDatabase: string;
  readonly productRole: string;
  readonly temporalNamespace: string;
  /** Private material delivered to the installation's own processes. */
  readonly secretDirectory: string;
  /** Operator-only material: the master key and the invitation outbox. Never delivered to a harness. */
  readonly operatorDirectory: string;
}

/** Resource REFERENCES a step records: names, paths, identifiers, digests. Never a credential value. */
export type FactoryStepResources = Readonly<Record<string, string>>;

/**
 * One C12 step.
 *
 * `ensure` is idempotent by installation: it completes the step's resources or
 * proves they already exist, and returns what it owns. `verify` re-proves a
 * completed step against its live service. `teardown` removes or revokes only
 * what `ensure` recorded as owned, and must succeed when run twice. `rotate`
 * replaces the step's credential and returns the new references; a step with
 * no credential omits it.
 */
export interface FactoryProvisioningDriver {
  readonly step: FactoryProvisioningStepName;
  ensure(installation: FactoryInstallationContext, recorded: FactoryStepResources | undefined): Promise<FactoryStepResources>;
  verify(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<void>;
  teardown(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<void>;
  rotate?(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<FactoryStepResources>;
}

const TENANT = /^tenant-\d{2}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,63}$/;
const FLEET = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;

export function assertFactoryInstallationRequest(request: FactoryInstallationRequest): void {
  if (!TENANT.test(request.tenantId)) throw new FactoryProvisioningError("provisioning_request_invalid", "Local provisioner requires a generated tenant-XX identity.");
  if (!HOSTNAME.test(request.hostname)) throw new FactoryProvisioningError("provisioning_request_invalid", "Installation hostname is malformed.");
  if (!EMAIL.test(request.administratorEmail)) throw new FactoryProvisioningError("provisioning_request_invalid", "First administrator email is malformed.");
}

export function assertFactoryFleetId(fleetId: string): void {
  if (!FLEET.test(fleetId)) throw new FactoryProvisioningError("provisioning_fleet_invalid", "Fleet identity must be a lowercase DNS label of 2 to 32 characters.");
}

/**
 * A deterministic resource name for one tenant in one fleet.
 *
 * Scoped by fleet as well as tenant: two control planes on one PostgreSQL
 * cluster must never derive the same database name, and a name derived from
 * the tenant alone collided with an earlier campaign's leftovers on this host.
 */
export function factoryFleetResourceName(prefix: string, fleetId: string, tenantId: string): string {
  return `${prefix}_${createHash("sha256").update(`${fleetId}\u0000${tenantId}`).digest("hex").slice(0, 20)}`;
}

export interface FactoryInstallationNames {
  readonly productDatabase: string;
  readonly productRole: string;
  readonly temporalNamespace: string;
  readonly secretDirectory: string;
  readonly operatorDirectory: string;
}

export function factoryInstallationNames(fleetId: string, tenantId: string, roots: { readonly secretsRoot: string; readonly operatorRoot: string }): FactoryInstallationNames {
  assertFactoryFleetId(fleetId);
  return Object.freeze({
    productDatabase: factoryFleetResourceName("factory_product", fleetId, tenantId),
    productRole: factoryFleetResourceName("factory_role", fleetId, tenantId),
    temporalNamespace: `${tenantId}.${fleetId}`,
    secretDirectory: resolve(roots.secretsRoot, tenantId),
    operatorDirectory: resolve(roots.operatorRoot, tenantId),
  });
}

/**
 * One service's private delivery directory. Every step that hands a file to a
 * running service writes it here, atomically, so the service's bind mount
 * (which pins the directory, not the file) sees the new file at once.
 */
export function factoryDeliveryDirectory(installation: Pick<FactoryInstallationContext, "secretDirectory">, service: "pool" | "gateway" | "harness" | "orchestrator" | "supervisor"): string {
  return resolve(installation.secretDirectory, "deliver", service);
}
