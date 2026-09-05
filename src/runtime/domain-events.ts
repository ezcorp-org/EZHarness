import type { AgentEvents, AgentRun } from "../types";
import type { EventBus } from "./events";
import { updateRun } from "../db/queries/runs";
import { emitPersistedDomainEvent, type DomainExtensionEvent } from "../extensions/domain-event-outbox";

export async function emitTerminalRun(host: { persist: boolean; bus: EventBus<AgentEvents> }, run: AgentRun, type: "run:complete" | "run:error" | "run:cancel", payload: Record<string, unknown>): Promise<void> {
  const conversationId = payload.conversationId;
  if (!host.persist || typeof conversationId !== "string" || !conversationId) {
    host.bus.emit(type, payload as AgentEvents[typeof type]);
    return;
  }
  const event: DomainExtensionEvent = { id: `run:${run.id}:${run.status}`, type, conversationId, payload };
  await updateRun(run, event);
  emitPersistedDomainEvent(host.bus, event);
}
