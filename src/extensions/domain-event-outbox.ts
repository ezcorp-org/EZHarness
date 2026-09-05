import { sql } from "drizzle-orm";
import { assertJson, canonicalJson, sha256, type InstallationRecord } from "@ezcorp/extension-contract";
import type { MigrationDb } from "../db/migrations/types";
import { releaseRows } from "../db/queries/extension-releases";
import type { AgentEvents } from "../types";
import type { EventBus } from "../runtime/events";
import { DIRECT_CARRIER_EVENT_TYPES, isRegisteredExtensionEvent } from "../runtime/sse-conversation-filter";
import { isGrantableEventSubscription } from "./clamp-permissions";
import { ExtensionDeliveryQueue, type ExtensionDelivery } from "./v4/deliveries";
import { LifecycleError } from "./v4/types";
import type { ExtensionPermissions } from "./types";

export interface DomainExtensionEvent {
  id: string;
  type: keyof AgentEvents & string;
  conversationId: string;
  payload: Record<string, unknown>;
  sourceExtensionName?: string;
}

const persistedPayloads = new WeakSet<object>();
const HEAVY_EVENTS = new Set(["tool:start", "tool:complete", "tool:error", "tool:permission_request"]);
const TERMINAL_EVENTS = new Set(["run:complete", "run:error", "run:cancel"]);

export function isPersistedDomainEvent(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && persistedPayloads.has(payload);
}

export function emitPersistedDomainEvent(bus: EventBus<AgentEvents> | undefined, event: DomainExtensionEvent): void {
  persistedPayloads.add(event.payload);
  bus?.emit(event.type, event.payload as AgentEvents[typeof event.type]);
}

export async function assertConversationEventOwner(transaction: MigrationDb, principalId: string, conversationId: string): Promise<void> {
  const owners = releaseRows<{ id: string }>(await transaction.execute(sql`SELECT c.id FROM conversations c JOIN users u ON u.id = c.user_id WHERE c.id = ${conversationId} AND c.user_id = ${principalId} AND u.status = 'active' AND (u.role = 'admin' OR c.project_id IS NULL OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = c.project_id AND pm.user_id = u.id AND pm.role IN ('member', 'owner'))) FOR SHARE OF c, u`));
  if (!owners.length) throw new LifecycleError("event_not_found", "Conversation not found.");
}

export async function admitConversationExtensionAction(principalId: string, extensionName: string, type: string, key: string, payload: Record<string, unknown>, bus: EventBus<AgentEvents>): Promise<void> {
  const { getDb } = await import("../db/connection");
  const { admitEventInTransaction } = await import("../db/queries/extension-event-receipts");
  const conversationId = payload.conversationId;
  if (typeof conversationId !== "string" || !conversationId || conversationId.length > 256) throw new LifecycleError("invalid_event", "A bounded conversation is required.");
  let event: DomainExtensionEvent | undefined;
  const result = await getDb().transaction(async (transaction: import("../db/connection").DbTransaction) => {
    await assertConversationEventOwner(transaction, principalId, conversationId);
    const sources = releaseRows<{ id: string; name: string }>(await transaction.execute(sql`SELECT id, name FROM extensions WHERE name = ${extensionName} AND enabled = true FOR SHARE`));
    const sourceExtensionName = sources[0]?.name;
    if (!sourceExtensionName || !type.startsWith(`${sourceExtensionName}:`) || !isRegisteredExtensionEvent(type) || DIRECT_CARRIER_EVENT_TYPES.has(type as never)) throw new LifecycleError("event_not_found", "Extension action not found.");
    return admitEventInTransaction(transaction, { principalId, namespace: type, key, scope: conversationId, payload: { extensionId: sources[0]!.id, payload } }, async id => {
      event = { id, type: type as DomainExtensionEvent["type"], conversationId, payload, sourceExtensionName };
      return publishDomainEvent(transaction, event);
    });
  });
  if (result.accepted && event) emitPersistedDomainEvent(bus, event);
}

export function sanitizeDomainEvent(type: string, payload: Record<string, unknown>, includeFullPayload: boolean): Record<string, unknown> {
  const { _meta, ...clean } = payload;
  if (includeFullPayload) return clean;
  if (TERMINAL_EVENTS.has(type) && clean.run && typeof clean.run === "object" && !Array.isArray(clean.run)) {
    const { logs, result, ...run } = clean.run as Record<string, unknown>;
    if (!result || typeof result !== "object" || Array.isArray(result)) return { ...clean, run };
    const { output, ...resultMetadata } = result as Record<string, unknown>;
    return { ...clean, run: { ...run, result: resultMetadata } };
  }
  if (!HEAVY_EVENTS.has(type)) return clean;
  const { input, output, ...metadata } = clean;
  return metadata;
}

interface TargetRow { installation: string; permissions: ExtensionPermissions | string; effective: ExtensionPermissions | string | null; name: string }

export async function publishDomainEvent(transaction: MigrationDb, event: DomainExtensionEvent): Promise<ExtensionDelivery[]> {
  if (!event.id || event.id.length > 256 || !event.conversationId || event.conversationId.length > 256 || !isGrantableEventSubscription(event.type, event.sourceExtensionName)) throw new LifecycleError("invalid_event", "A bounded host domain event identity is required.");
  const serialized = JSON.stringify({ ...event.payload, conversationId: event.conversationId });
  const payload = JSON.parse(serialized) as Record<string, unknown>;
  const owners = releaseRows<{ user_id: string | null; project_id: string | null }>(await transaction.execute(sql`SELECT c.user_id, c.project_id FROM conversations c JOIN users u ON u.id = c.user_id WHERE c.id = ${event.conversationId} AND u.status = 'active' FOR SHARE OF c, u`));
  const owner = owners[0];
  if (!owner?.user_id) return [];
  const targets = releaseRows<TargetRow>(await transaction.execute(sql`SELECT i.payload AS installation, e.granted_permissions AS permissions, ce.effective_granted_permissions AS effective, e.name FROM conversation_extensions ce JOIN extension_release_installations i ON i.id = ce.extension_id JOIN extensions e ON e.id = i.id WHERE ce.conversation_id = ${event.conversationId} AND e.enabled = true ORDER BY i.id FOR UPDATE OF i`));
  const deliveries: ExtensionDelivery[] = [];
  const deduplicationId = await sha256(canonicalJson(["domain", event.type, event.id, event.conversationId]));
  const eventDigest = await sha256(serialized);
  for (const target of targets) {
    if (!isGrantableEventSubscription(event.type, target.name)) continue;
    const installation = JSON.parse(target.installation) as InstallationRecord;
    const permissions = typeof target.permissions === "string" ? JSON.parse(target.permissions) as ExtensionPermissions : target.permissions;
    const effective = typeof target.effective === "string" ? JSON.parse(target.effective) as ExtensionPermissions : target.effective;
    const declaration = installation.grants.map(grant => JSON.parse(grant) as [string, unknown]).find(([name]) => name === "eventSubscriptions")?.[1] as string[] | { events?: string[]; includeFullPayload?: boolean } | undefined;
    const sealedEvents = Array.isArray(declaration) ? declaration : declaration?.events;
    if (!installation.enabled || installation.uninstalled || !installation.activeReleaseId || !permissions.eventSubscriptions?.includes(event.type) || (effective && !effective.eventSubscriptions?.includes(event.type)) || !sealedEvents?.includes(event.type)) continue;
    const params = sanitizeDomainEvent(event.type, payload, !Array.isArray(declaration) && declaration?.includeFullPayload === true);
    if (Buffer.byteLength(JSON.stringify(params)) > 256 * 1024) throw new LifecycleError("event_payload_limit", "The approved event representation exceeds the durable payload limit; no source state was committed.");
    assertJson(params);
    const pending = releaseRows<{ count: number }>(await transaction.execute(sql`SELECT COUNT(*)::int AS count FROM extension_release_deliveries WHERE installation_id = ${installation.id} AND state IN ('queued', 'leased') AND deduplication_id <> ${deduplicationId}`));
    if ((pending[0]?.count ?? 0) >= 10000) throw new LifecycleError("event_queue_full", "Domain event queue capacity is exhausted; the state transaction was not committed.");
    const run = payload.run as { id?: unknown } | undefined;
    deliveries.push(await ExtensionDeliveryQueue.enqueueInTransaction(transaction, {
      installationId: installation.id, releaseId: installation.activeReleaseId, generation: installation.generation,
      principalId: installation.ownerId, scope: installation.scope, deduplicationId, kind: "event",
      input: { eventDigest, method: `ezcorp/event/${event.type}`, params, provenance: {
        onBehalfOf: owner.user_id, conversationId: event.conversationId, ...(owner.project_id ? { projectId: owner.project_id } : {}),
        runId: typeof run?.id === "string" ? run.id : typeof payload.runId === "string" ? payload.runId : null,
        parentCallId: null, actorExtensionId: installation.id, kind: "event", ownerless: false,
      } },
    }));
  }
  return deliveries;
}
