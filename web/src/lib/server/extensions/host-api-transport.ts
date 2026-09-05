import { SseDataBuffer } from "@ezcorp/harness-client";
import { configureHostApiTransport, type HostApiTransport } from "$server/extensions/host-api-broker";
import { provisionInternalKey, revokeInternalKey } from "$lib/server/security/internal-auth";

const RESPONSE_LIMIT = 512 * 1024;

export function createHostApiTransport(baseUrl: string, fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch): HostApiTransport {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error("The extension API broker requires the direct loopback HTTP origin.");

  async function withResponse<Result>(userId: string, path: string, init: RequestInit, consume: (response: Response, signal: AbortSignal) => Promise<Result>, timeoutMs: number): Promise<Result> {
    const keyName = `extension-broker:${crypto.randomUUID()}`;
    const { raw } = provisionInternalKey(keyName, ["read", "write", "chat", "extensions"], userId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    try {
      response = await fetcher(new URL(path, base), { ...init, redirect: "error", signal: controller.signal, headers: { Authorization: `Bearer ${raw}`, "Content-Type": "application/json" } });
      return await consume(response, controller.signal);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      revokeInternalKey(keyName);
    }
  }

  return {
    request(userId, input) {
      const body = input.body === undefined ? undefined : JSON.stringify(input.body);
      if (body && new TextEncoder().encode(body).byteLength > RESPONSE_LIMIT) return Promise.reject(new Error("API request exceeds the broker size limit."));
      return withResponse(userId, input.path, { method: input.method, body }, async (response) => {
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let size = 0;
        let text = "";
        try {
          if (reader) for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > RESPONSE_LIMIT) throw new Error("API response exceeds the broker size limit.");
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
          return { status: response.status, body: text, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } };
        } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
      }, 30000);
    },
    events(userId, input) {
      const query = new URLSearchParams();
      if (input.cursor) query.set("lastEventId", input.cursor);
      if (input.conversationId) query.set("conversationId", input.conversationId);
      return withResponse(userId, `/api/runtime-events?${query}`, { method: "GET" }, async (response) => {
        if (!response.ok || !response.body) throw new Error("Runtime events are unavailable.");
        const reader = response.body.getReader();
        const parser = new SseDataBuffer();
        const decoder = new TextDecoder();
        const events: unknown[] = [];
        let size = 0;
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; void reader.cancel(); }, input.waitMs);
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > RESPONSE_LIMIT) throw new Error("Runtime events exceed the broker size limit.");
            for (const event of parser.push(decoder.decode(chunk.value, { stream: true }))) events.push(JSON.parse(event));
            if (events.length >= 256) break;
          }
          return { cursor: parser.lastEventId || input.cursor || "0", events, done: !timedOut && events.length === 0 };
        } finally { clearTimeout(timeout); await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }, input.waitMs + 5000);
    },
  };
}

export function initializeHostApiTransport(): void {
  const rawPort = process.env.EZCORP_PORT ?? process.env.PORT ?? "3000";
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error("Invalid local API port.");
  configureHostApiTransport(createHostApiTransport(`http://127.0.0.1:${rawPort}`));
}
