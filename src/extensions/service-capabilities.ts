import { canonicalJson, sha256 } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import { getDb } from "../db/connection";
import type { MigrationDb } from "../db/migrations/types";
import { releaseRows } from "../db/queries/extension-releases";
import { firstMissingCapability, grantsToCapabilitySet, type CapabilitySet } from "./capability-types";
import { requestedReleaseGrants } from "./extension-control";
import { buildFullGrantFromManifest } from "./install-grant";
import { getReleaseRuntime, releaseBinding, resolveActiveRelease } from "./release-process";
import { isServiceInvocation, type ServiceInvocation } from "./service-invocation";

export async function assertServiceCapabilities(proof: ServiceInvocation, extensionId: string, needed: CapabilitySet, options: { toolName?: string; rbacScope?: string; database?: MigrationDb } = {}): Promise<string> {
  if (!isServiceInvocation(proof)) throw new Error("Service authority must be issued by the host");
  await proof.assertActive(options.database);
  const database = options.database ?? getDb();
  const target = await resolveActiveRelease(extensionId, getReleaseRuntime(), options.database);
  const binding = releaseBinding(target);
  const targetScope = target.installation.scope;
  if (target.installation.ownerId !== proof.consenterId || (target.installation.scope !== "global" && target.installation.scope !== `project:${proof.projectId}`)) throw new Error("Service cannot access this extension installation");
  if (canonicalJson([...new Set(target.installation.grants)].sort()) !== canonicalJson(requestedReleaseGrants(target.release.manifest))) throw new Error("Target release grants are no longer approved");
  const service = releaseRows<{ scopes: string[]; projectId: string | null }>(await database.execute(sql`SELECT scopes, project_id AS "projectId" FROM service_accounts WHERE id=${proof.serviceId} AND enabled=true FOR SHARE`))[0];
  const delegation = releaseRows<{ capabilities: Array<{ kind: string; value: string | null }> }>(await database.execute(sql`SELECT capability_set AS capabilities FROM workflow_delegations WHERE id=${proof.delegationId} AND owner_kind='service' AND owner_service_account_id=${proof.serviceId} AND consented_by_user_id=${proof.consenterId} AND enabled=true AND revoked_at IS NULL FOR SHARE`))[0];
  if (!service || !delegation || (service.projectId !== null && service.projectId !== proof.projectId)) throw new Error("Service delegation is no longer active");
  if (options.rbacScope && !service.scopes.includes(options.rbacScope)) throw new Error("Service lacks the declared extension RBAC scope");
  if (options.toolName && !delegation.capabilities.some(capability => capability.kind === "tool" && capability.value === options.toolName)) throw new Error("Tool is outside the service consent closure");
  const consent = delegation.capabilities.map(capability => ({ kind: capability.kind, ...(capability.value === null ? {} : { value: capability.value }) })) as CapabilitySet;
  const targetGrants = grantsToCapabilitySet(buildFullGrantFromManifest(target.release.manifest as unknown as import("./types").ExtensionManifestV2), null);
  if (firstMissingCapability(needed, consent) || firstMissingCapability(needed, targetGrants)) throw new Error("Capability is outside the live service consent or release grants");
  await proof.assertActive(options.database);
  const current = await resolveActiveRelease(extensionId, getReleaseRuntime(), options.database);
  if (releaseBinding(current) !== binding || current.installation.ownerId !== proof.consenterId || current.installation.scope !== targetScope) throw new Error("Service target release changed during authorization");
  return sha256(binding);
}
