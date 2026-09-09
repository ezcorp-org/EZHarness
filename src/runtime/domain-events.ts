import type { AgentEvents, AgentRun } from "../types";
import type { EventBus } from "./events";
import { finalizeRunRow, updateRun } from "../db/queries/runs";
import { emitPersistedDomainEvent, type DomainExtensionEvent } from "../extensions/domain-event-outbox";

export async function emitTerminalRun(host: { persist: boolean; bus: EventBus<AgentEvents> }, run: AgentRun, type: "run:complete" | "run:error" | "run:cancel", payload: Record<string, unknown>, mode: "normal" | "abnormal" = "normal"): Promise<boolean> {
  const conversationId = payload.conversationId;
  if (mode !== "normal" && host.persist) {
    if (run.status !== "error" && run.status !== "cancelled") throw new Error("Abnormal finalization requires an error or cancellation");
    const snapshot = { ...payload, run: { ...run } };
    const event: DomainExtensionEvent | undefined = typeof conversationId === "string" && conversationId ? { id: `run:${run.id}:${run.status}`, type, conversationId, payload: snapshot } : undefined;
    const count = await finalizeRunRow(run.id, run.status, typeof payload.error === "string" ? payload.error : undefined, event);
    if (!count) return false;
    if (event) emitPersistedDomainEvent(host.bus, event);
    else host.bus.emit(type, payload as AgentEvents[typeof type]);
    return true;
  }
  if (!host.persist || typeof conversationId !== "string" || !conversationId) {
    host.bus.emit(type, payload as AgentEvents[typeof type]);
    return true;
  }
  const event: DomainExtensionEvent = { id: `run:${run.id}:${run.status}`, type, conversationId, payload };
  await updateRun(run, event);
  emitPersistedDomainEvent(host.bus, event);
  return true;
}
