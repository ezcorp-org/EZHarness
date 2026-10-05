import { canonicalRecoveryJson } from "./incus-create-noeffect-recovery";
import { isStableStartCleanup, requireFencedCleanupPinVersion, requireStableStartCleanupPins, type FencedCleanupPayload, type NativeFencedCleanupPins, type FencedCleanupProofPins } from "./incus-fenced-cleanup-recovery";
import { incusLiveReadbackCommand, incusLiveReadbackPolicy, type LiveReadbackContext } from "./incus-transport/live-readback";
import { metadata, resourceName, withSession } from "./incus-transport/lifecycle";
import { object, verifiedHttpsRequest, type HostConnectionResolver, type PinnedFetch } from "./incus-transport/transport";

export type FencedCleanupPins = NativeFencedCleanupPins;
export type FencedCleanupTarget = Pick<FencedCleanupPayload, "scope" | "fixtureOperationId"
  | "bindingId" | "operationId" | "generation" | "connectionRevision">;

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`fenced cleanup observation denied: ${message}`);
}

/** Four exact GETs for native operations; three for stable START intents. Observations are collected by the sealed operator process;
 * a control request cannot supply their values or request any mutation. */
export async function observeFencedCleanup(connections: HostConnectionResolver,
  context: LiveReadbackContext, target: FencedCleanupTarget, pins: FencedCleanupProofPins,
  http: PinnedFetch = verifiedHttpsRequest) {
  const stable = isStableStartCleanup(pins);
  if (stable) {
    requireFencedCleanupPinVersion(2, pins);
    requireStableStartCleanupPins(target, pins);
  }
  const command = incusLiveReadbackCommand(context, target.bindingId);
  requireFact(canonicalRecoveryJson(context.scope) === canonicalRecoveryJson({
    installationId: target.scope.installationId, releaseId: target.scope.releaseId,
    connectionId: target.scope.connectionId })
    && target.scope.presetId === context.preset.id && target.connectionRevision === context.connection.revision
    && context.connection.project === pins.project
    && pins.presetDigest === context.presetDigest && pins.effectiveSettingsDigest === context.effectiveSettingsDigest
    && pins.imageFingerprint === context.preset.imageDigest && pins.helperVersion === context.connection.configuration.helperVersion
    && pins.serverCertificateSha256 === command.pins.serverCertificateSha256
    && (stable || !isStableStartCleanup(pins) && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(pins.nativeOperationId)
      && pins.providerOperationId === `incus-setPower-${pins.nativeOperationId}`), "sealed target pins changed");
  const sealedConnections: HostConnectionResolver = { resolveForHost: async input => {
    const resolved = await connections.resolveForHost(input);
    requireFact(resolved.endpoint === pins.endpoint && resolved.project === pins.project, "operator connection endpoint changed");
    return resolved;
  } };
  return withSession(sealedConnections, incusLiveReadbackPolicy(context), http, command, async session => {
    const project = encodeURIComponent(context.connection.project);
    const path = `/1.0/instances/${resourceName(target.scope.connectionId, target.bindingId)}?project=${project}`;
    const instance = object(metadata(await session.request("GET", path)));
    const config = object(instance.config);
    const profiles = instance.profiles;
    const providerGeneration = Number(config["user.ezharness.generation"]);
    requireFact(instance.name === command.sandboxName && instance.type === "container" && instance.status === "Stopped"
      && config["user.ezharness.managed_by"] === "ezharness-incus-sandbox"
      && config["user.ezharness.connection_id"] === target.scope.connectionId
      && config["user.ezharness.sandbox_id"] === target.bindingId
      && config["user.ezharness.profile"] === context.preset.profile && config["user.ezharness.preset_id"] === context.preset.id
      && config["volatile.base_image"] === pins.imageFingerprint
      && config["user.ezharness.operation_id"] === pins.operationTag
      && Array.isArray(profiles) && profiles.length === 1 && profiles[0] === context.recipe.profile.name
      && Number.isSafeInteger(providerGeneration) && providerGeneration > 0, "owned stopped instance changed");
    if (stable) requireFact(config["user.ezharness.desired_state"] === "running"
      && providerGeneration === pins.expectedProviderGeneration, "stable START intent generation or desired state changed");
    if (!isStableStartCleanup(pins)) {
    const operation = await session.request("GET", `/1.0/operations/${pins.nativeOperationId}?project=${project}`);
    requireFact(operation.status === 404, "native operation still exists or cannot be checked");
    }
    const listed = await session.request("GET", `/1.0/operations?project=${project}`);
    if (stable) requireFact(listed.status === 200 && listed.envelope.type === "sync"
      && listed.envelope.metadata !== null && typeof listed.envelope.metadata === "object"
      && !Array.isArray(listed.envelope.metadata), "operation list response changed");
    const operations = object(metadata(listed));
    requireFact(Object.values(operations).every(value => Array.isArray(value) && value.length === 0), "another active operation exists");
    // Re-read after both operation checks so a moving instance cannot attest a
    // stale ownership or generation observation.
    const second = object(metadata(await session.request("GET", path)));
    requireFact(canonicalRecoveryJson(second) === canonicalRecoveryJson(instance), "instance changed during observation");
    if (stable) return { instanceState: "stopped" as const, noActiveOperations: true as const, providerGeneration, pins };
    return { instanceState: "stopped" as const, nativeOperationAbsent: true as const,
      activeOperations: [] as [], providerGeneration, pins };
  });
}
