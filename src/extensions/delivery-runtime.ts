import { canonicalJson, sha256 } from "@ezcorp/extension-contract";
import { registerCallProvenance, releaseCallProvenance, resolveCallProvenance, type CallProvenance } from "./call-provenance";
import type { ExtensionProcess } from "./subprocess";
import { extensionLogger } from "../logger";
import { LifecycleError } from "./v4/types";
import type { ExtensionDelivery } from "./v4/deliveries";
import { capabilityToolsDisabled } from "./capability-flags";
import { loopsKillSwitchEngaged } from "./loops-kill-switch";

const log = extensionLogger("delivery", "runtime");
let wireProcess: ((extensionId: string, process: ExtensionProcess) => void) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let draining: Promise<void> | undefined;

interface DeliveryInput { method: string; params: Record<string, unknown>; provenance: CallProvenance }

async function resolveDeliveryProject(installationId: string, principalId: string, conversationId: string | null): Promise<Pick<CallProvenance, "projectId" | "projectBindingId">> {
  let context: Pick<CallProvenance, "projectId" | "projectBindingId"> = {};
  if (conversationId) {
    const { getConversation } = await import("../db/queries/conversations");
    const conversation = await getConversation(conversationId);
    if (conversation?.userId !== principalId) throw new LifecycleError("delivery_revoked", "Delivery conversation ownership changed.");
    if (conversation.projectId) context = { projectId: conversation.projectId };
  } else {
    const { getExtensionProjectBinding } = await import("./project-binding");
    const binding = await getExtensionProjectBinding(installationId);
    if (binding) {
      if (binding.ownerId !== principalId) throw new LifecycleError("delivery_revoked", "Delivery project owner changed.");
      context = { projectId: binding.projectId, projectBindingId: binding.id };
    }
  }
  if (context.projectId) {
    const { getUserById } = await import("../db/queries/users");
    const { checkProjectRole } = await import("../auth/middleware");
    const user = await getUserById(principalId);
    if (user?.status !== "active" || await checkProjectRole({ user }, context.projectId, "member") instanceof Response) throw new LifecycleError("delivery_revoked", "Delivery project membership changed.");
  }
  return context;
}

export function startExtensionDeliveryRuntime(wire: NonNullable<typeof wireProcess>): void {
  wireProcess = wire;
  if (timer) clearInterval(timer);
  timer = setInterval(() => { void drainExtensionDeliveries().catch((cause) => log.error("Extension delivery drain failed", { code: cause instanceof LifecycleError ? cause.code : "delivery_failed" })); }, 1000);
  timer.unref();
}

export async function stopExtensionDeliveryRuntime(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  await draining;
  wireProcess = undefined;
}

async function dispatch(delivery: ExtensionDelivery): Promise<void> {
  if (!wireProcess) throw new LifecycleError("delivery_unconfigured", "Extension delivery runtime is not configured.");
  const input = delivery.input as DeliveryInput;
  if (!input || typeof input.method !== "string" || !input.params || input.provenance?.actorExtensionId !== delivery.installationId || !input.provenance.onBehalfOf) throw new LifecycleError("invalid_delivery", "Stored delivery context is invalid.");
  const { getUserById } = await import("../db/queries/users");
  const user = await getUserById(input.provenance.onBehalfOf);
  if (user?.status !== "active") throw new LifecycleError("delivery_revoked", "Delivery principal is no longer active.");
  if (input.method.startsWith("ezcorp/event/")) {
    const { getConversationExtensionIds } = await import("../db/queries/conversation-extensions");
    const { getExtension } = await import("../db/queries/extensions");
    const extension = await getExtension(delivery.installationId);
    const wired = input.provenance.conversationId ? await getConversationExtensionIds(input.provenance.conversationId) : [];
    if (!extension?.enabled || !wired.includes(delivery.installationId) || !extension.grantedPermissions.eventSubscriptions?.includes(input.method.slice("ezcorp/event/".length))) throw new LifecycleError("delivery_revoked", "Event subscription or conversation wiring was revoked.");
  }
  const project = await resolveDeliveryProject(delivery.installationId, user.id, input.provenance.conversationId);
  if (project.projectId !== input.provenance.projectId || project.projectBindingId !== input.provenance.projectBindingId) throw new LifecycleError("delivery_revoked", "Delivery project approval changed.");
  const { ExtensionRegistry } = await import("./registry");
  const process = await ExtensionRegistry.getInstance().getProcess(delivery.installationId);
  wireProcess(delivery.installationId, process);
  const token = registerCallProvenance(input.provenance);
  try {
    const response = await process.call(input.method, { ...delivery.transportContext, ...input.params, _meta: { ezCallId: token, releaseId: delivery.releaseId, expectedGeneration: delivery.generation } });
    if (response.error) throw new LifecycleError("delivery_rejected", "Extension rejected its delivery.");
  } finally { releaseCallProvenance(token); }
}

export async function drainExtensionDeliveries(): Promise<void> {
  if (!wireProcess) return;
  if (capabilityToolsDisabled() || await loopsKillSwitchEngaged()) return;
  if (draining) return draining;
  draining = (async () => {
    const { getExtensionDeliveryQueue } = await import("./extension-lifecycle-service");
    const queue = await getExtensionDeliveryQueue();
    for (let count = 0; count < 100; count++) {
      if (capabilityToolsDisabled() || await loopsKillSwitchEngaged()) break;
      if (!(await queue.dispatch(dispatch))) break;
    }
  })();
  try { await draining; } finally { draining = undefined; }
}

export async function enqueueExtensionNotification(extensionId: string, method: string, params: Record<string, unknown>): Promise<void> {
  const meta = params._meta as Record<string, unknown> | undefined;
  const token = typeof meta?.ezCallId === "string" ? meta.ezCallId : undefined;
  const provenance = token ? resolveCallProvenance(token) : undefined;
  if (!provenance || provenance.actorExtensionId !== extensionId) throw new LifecycleError("invalid_delivery", "A host-issued delivery context is required.");
  const { getExtensionDeliveryQueue, getExtensionInstallationState } = await import("./extension-lifecycle-service");
  const state = await getExtensionInstallationState(extensionId);
  const installation = state?.installation;
  if (!installation?.enabled || !installation.activeReleaseId) throw new LifecycleError("delivery_revoked", "Installation is not active.");
  const principalId = provenance.ownerless ? installation.ownerId : provenance.onBehalfOf;
  if (!principalId) throw new LifecycleError("invalid_delivery", "A delivery principal is required.");
  const { projectId: _projectId, projectBindingId: _projectBindingId, ...identity } = provenance;
  const owned = { ...identity, onBehalfOf: principalId, ownerless: false, ...await resolveDeliveryProject(extensionId, principalId, provenance.conversationId) };
  const transientKeys = new Set(["ezcorp/webhook-fire", "ezcorp/schedule-fire", "ezcorp/trigger-fire"].includes(method) ? ["catchUp", "attempt", "retry", "firedAt"] : []);
  const cleanParams = Object.fromEntries(Object.entries(params).filter(([key]) => key !== "_meta" && !transientKeys.has(key)));
  const transportContext = Object.fromEntries(Object.entries(params).filter(([key]) => transientKeys.has(key)));
  const sourceId = meta?.deliveryId ?? params.deliveryId ?? params.fireId ?? params.id;
  const deduplicationId = typeof sourceId === "string" ? await sha256(canonicalJson([method, sourceId, owned.onBehalfOf])) : crypto.randomUUID();
  const queue = await getExtensionDeliveryQueue();
  const delivery = await queue.enqueue({ installationId: extensionId, releaseId: installation.activeReleaseId, generation: installation.generation, principalId: installation.ownerId, scope: installation.scope, deduplicationId, kind: method.includes("webhook") ? "webhook" : method.includes("schedule") || method.includes("trigger-fire") ? "schedule" : "event", input: { method, params: cleanParams, provenance: owned } satisfies DeliveryInput, transportContext });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await drainExtensionDeliveries();
    const current = await queue.inspect(extensionId, delivery.id);
    if (current?.state === "delivered") return;
    if (!current || ["cancelled", "dead_letter", "outcome_unknown"].includes(current.state)) throw new LifecycleError("delivery_outcome_unknown", "Delivery did not complete. It will not repeat uncertain effects.");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new LifecycleError("delivery_pending", "Delivery remains durably queued.");
}
