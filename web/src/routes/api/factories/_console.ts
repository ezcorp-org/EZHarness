/**
 * The console routes that do not answer JSON (W14): the live event stream,
 * artifact downloads, and shared artifact bytes. Every JSON console kind goes
 * through `handleFactoryApi` and the console dispatcher instead. These three
 * use the same route kit: the same principal, the same request validation, and
 * the same error mapping, and differ only in the body they return.
 */
import { FACTORY_DISABLED_REASON, factoryBootConfig } from "$server/factory/boot";
import { getFactoryApplication } from "$server/factory/application";
import type { FactoryConsoleServices } from "$server/factory/console";
import type { FactoryPrincipal } from "$server/factory/grants";
import type { FactoryRunEventBatch } from "$server/factory/run-events";
import { logger } from "$server/logger";
import { factoryErrorResponse, mappedFactoryError, resolveFactoryPrincipal } from "$lib/server/factory/route-kit";
import { FACTORY_STREAM_EVENT_NAMES } from "$lib/runtime-event-names";
import { FACTORY_API_REQUEST_SCHEMA_VERSION, validateFactoryApiRequest, type FactoryApiRequest } from "@ezcorp/factory-sdk";

type ConsoleEvent = { readonly request: Request; readonly url: URL; readonly locals: App.Locals };
type ReadRequest = Extract<FactoryApiRequest, { kind: "run.events" | "artifact.ticket" | "artifact.shared.read" }>;

export interface FactoryConsoleRawRoute<Kind extends ReadRequest["kind"]> {
  readonly build: () => { readonly kind: Kind } & Readonly<Record<string, unknown>>;
  readonly run: (context: { readonly principal: FactoryPrincipal; readonly console: FactoryConsoleServices; readonly request: Extract<ReadRequest, { kind: Kind }> }) => Promise<Response>;
}

/** A read-scope console route whose answer is a stream or bytes, not an SDK response. */
export async function handleFactoryConsoleRaw<Kind extends ReadRequest["kind"]>(event: ConsoleEvent, route: FactoryConsoleRawRoute<Kind>): Promise<Response> {
  if (!factoryBootConfig.enabled) return factoryErrorResponse(404, FACTORY_DISABLED_REASON, "Factories are disabled.");
  const application = getFactoryApplication();
  if (!application) return factoryErrorResponse(503, "factory_application_unavailable", "Factory services are not ready.", true);
  const principal = resolveFactoryPrincipal(event, { scope: "read" });
  if (principal instanceof Response) return principal;
  const candidate = { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, ...route.build() };
  const validation = validateFactoryApiRequest(candidate);
  if (!validation.ok) return factoryErrorResponse(400, validation.issues[0]?.code ?? "invalid_request", validation.issues[0]?.message ?? "Invalid factory request.", false, validation.issues);
  const request = candidate as unknown as Extract<ReadRequest, { kind: Kind }>;
  const service = event.locals.factoryServicePrincipal;
  if (service && request.path.projectId !== service.projectId) return factoryErrorResponse(403, "factory_service_project_mismatch", "The service credential does not permit this project.");
  try {
    return await route.run({ principal, console: await application.console(), request });
  } catch (error) {
    return mappedFactoryError(error);
  }
}

/** Why a stream stopped after a refusal mid-stream, by the status the refusal maps to. */
function streamClosedReason(error: unknown): string {
  let status: number;
  try {
    status = mappedFactoryError(error).status;
  } catch {
    // Not a factory refusal: the client only learns "unavailable", so the cause goes to the log.
    logger.error("factory run event stream failed", { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    return "unavailable";
  }
  if (status >= 500) logger.warn("factory run event stream closed on a service failure", { status });
  return status === 403 ? "revoked" : status === 410 ? "expired" : status === 404 ? "not-found" : "unavailable";
}

/** How often the stream polls for committed events, and how long one connection may live. */
export const FACTORY_STREAM_POLL_MS = 1_000;
export const FACTORY_STREAM_MAX_MS = 5 * 60_000;
export const FACTORY_STREAM_HEARTBEAT_MS = 15_000;
const [RUN_EVENT, RUN_STATUS, STREAM_CLOSED] = FACTORY_STREAM_EVENT_NAMES;

export interface FactoryStreamOptions {
  readonly read: (cursor: string) => Promise<FactoryRunEventBatch>;
  readonly signal: AbortSignal;
  readonly pollMs?: number;
  readonly maxMs?: number;
  readonly heartbeatMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function frame(event: string, data: unknown, id?: string): string {
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => { signal.removeEventListener("abort", done); resolve(); }, ms);
    const done = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The SSE body for one run. The first batch is read before this is called, so
 * an expired cursor or a refusal is an HTTP status, not a frame. After that
 * every poll rechecks authority inside the service; a refusal mid-stream sends
 * one `factory:stream-closed` frame naming why, then ends. Each event's `id` is
 * the signed cursor after it, so `Last-Event-ID` resumes exactly.
 */
export function factoryRunEventStream(first: FactoryRunEventBatch, options: FactoryStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const pollMs = options.pollMs ?? FACTORY_STREAM_POLL_MS;
  const maxMs = options.maxMs ?? FACTORY_STREAM_MAX_MS;
  const heartbeatMs = options.heartbeatMs ?? FACTORY_STREAM_HEARTBEAT_MS;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      const started = now();
      let lastWrite = started;
      let batch = first;
      let reason = "deadline";
      let lastStatus = "";
      while (!options.signal.aborted) {
        for (const event of batch.events) send(frame(RUN_EVENT, event, batch.cursor.sequence === event.sequence ? batch.cursor.token : undefined));
        // Status is sent when it changes; an idle poll writes nothing but the heartbeat.
        const status = { status: batch.status, sequence: batch.cursor.sequence, drained: batch.drained };
        if (batch.events.length > 0 || JSON.stringify(status) !== lastStatus) {
          lastStatus = JSON.stringify(status);
          send(frame(RUN_STATUS, status, batch.cursor.token));
          lastWrite = now();
        }
        if (batch.drained) { reason = "drained"; break; }
        await sleep(pollMs, options.signal);
        if (options.signal.aborted) break;
        if (now() - started >= maxMs) break;
        if (now() - lastWrite >= heartbeatMs) { send(": keep-alive\n\n"); lastWrite = now(); }
        try {
          batch = await options.read(batch.cursor.token);
        } catch (error) {
          reason = streamClosedReason(error);
          break;
        }
      }
      if (!options.signal.aborted) send(frame(STREAM_CLOSED, { reason }));
      controller.close();
    },
  });
}

export const FACTORY_STREAM_HEADERS = Object.freeze({
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  "X-Content-Type-Options": "nosniff",
  "X-Accel-Buffering": "no",
});

/** Download headers for artifact bytes: never rendered, never sniffed, never cached. */
export function factoryDownloadResponse(bytes: Uint8Array, artifactId: string): Response {
  const safe = artifactId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "artifact";
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safe}.bin"`,
      "Content-Length": String(bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
