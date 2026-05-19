/**
 * Phase 48 Wave 3 — thin API client for the Ez surfaces.
 *
 * The Ez panel uses these instead of inlining `fetch(...)` so future
 * shape changes (e.g. a versioned `/api/ez/v1/`) live in one spot.
 * Errors throw `Error` with a message; callers decide whether to
 * toast, log, or fall back.
 */

export interface EzConversation {
  conversationId: string;
  kind: "ez";
  modeId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EzDraft {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  consumed: boolean;
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: string = "";
    try { body = await res.text(); } catch { /* keep empty */ }
    throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Find or create the user's single Ez conversation. Server enforces
 * uniqueness via the partial unique index (Wave 1) — second call
 * always returns the same row.
 */
export async function getOrCreateEzConversation(): Promise<EzConversation> {
  const res = await fetch("/api/ez/conversation", { method: "GET" });
  return readJson<EzConversation>(res);
}

export async function getDraft(id: string): Promise<EzDraft> {
  const res = await fetch(`/api/ez/drafts/${encodeURIComponent(id)}`, { method: "GET" });
  return readJson<EzDraft>(res);
}

export async function consumeDraft(id: string): Promise<EzDraft> {
  const res = await fetch(`/api/ez/drafts/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "consume" }),
  });
  return readJson<EzDraft>(res);
}

/**
 * "Clear conversation" — wipes every message on the user's Ez
 * conversation while leaving the conversation row itself in place.
 * Schema enforces one Ez conversation per user, so we don't delete +
 * recreate; we just empty the message list. The returned conversationId
 * is the SAME id the caller already has (callers can keep their SSE
 * subscription open).
 */
export async function clearEzConversation(): Promise<{ conversationId: string; deletedCount: number }> {
  const res = await fetch("/api/ez/conversation/messages", { method: "DELETE" });
  return readJson<{ ok: boolean; conversationId: string; deletedCount: number }>(res);
}
