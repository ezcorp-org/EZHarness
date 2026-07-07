// @ts-check
// Lookup client — calls the extension's `lookup_card` tool through the
// platform's existing `POST /api/tool-invoke` route (session-cookie
// auth, no new API surface). When the backend is unreachable or the
// extension isn't installed, callers fall back to mock mode.
//
// tool-invoke requires a conversationId; the scanner keeps one dedicated
// conversation, created lazily and remembered in localStorage.

/** @typedef {import("./format.js").CardRecord} CardRecord */

const CONV_KEY = "gcs-conversation-id";
const EXTENSION_NAME = "graded-card-scanner";

/**
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @returns {Promise<{ok: boolean, status: number, json: any}>}
 */
async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON error body — leave null
  }
  return { ok: res.ok, status: res.status, json };
}

/**
 * Get (or lazily create) the scanner's dedicated conversation id.
 * @returns {Promise<string>}
 */
async function ensureConversationId() {
  const cached = localStorage.getItem(CONV_KEY);
  if (cached) return cached;
  const { ok, json } = await postJson("/api/conversations", {
    title: "Graded Card Scanner",
  });
  const id = json?.id ?? json?.conversation?.id;
  if (!ok || typeof id !== "string") {
    throw new Error("could not create scanner conversation");
  }
  localStorage.setItem(CONV_KEY, id);
  return id;
}

/**
 * Look up a cert through the extension tool.
 * Throws on ANY failure (network, auth, tool missing, tool error) —
 * the caller decides whether to fall back to mock mode.
 * @param {string} cert
 * @param {{fresh?: boolean}} [opts]
 * @returns {Promise<CardRecord>}
 */
export async function lookupCard(cert, opts = {}) {
  const conversationId = await ensureConversationId();
  const { ok, status, json } = await postJson("/api/tool-invoke", {
    extensionName: EXTENSION_NAME,
    toolName: "lookup_card",
    input: { cert, fresh: opts.fresh === true },
    conversationId,
    invocationId: crypto.randomUUID(),
  });
  if (!ok || json?.success !== true) {
    // A stale conversation id (e.g. DB reset) yields an error — drop the
    // cached id so the next attempt re-creates the conversation.
    if (status === 404 || status === 400) localStorage.removeItem(CONV_KEY);
    throw new Error(json?.error ?? `lookup failed (${status})`);
  }
  const record = JSON.parse(json.output);
  if (typeof record?.cert !== "string" || !Array.isArray(record?.grades)) {
    throw new Error("lookup returned an unexpected shape");
  }
  return record;
}
