/**
 * The console routes' handler kit (W14).
 *
 * `_shared.ts` dispatches the authoring and release kinds through a closed
 * switch and keeps its principal resolution and error mapping private, so the
 * console kinds cannot pass through it. This file holds the console's copy of
 * those four steps — principal, validated request, response, error — and is
 * written so `_shared.ts` can adopt it and drop its own. That adoption is an
 * open interface item for the owner of `_shared.ts`.
 */
import { checkAuth, checkRole, requireSessionAuth } from "$server/auth/middleware";
import { FACTORY_DISABLED_REASON, factoryBootConfig } from "$server/factory/boot";
import { getFactoryApplication } from "$server/factory/application";
import type { FactoryConsoleServices } from "$server/factory/console";
import { FactoryConsoleError } from "$server/factory/console-tokens";
import { FactoryGrantError, type FactoryPrincipal } from "$server/factory/grants";
import { FactoryMutationError } from "$server/factory/mutations";
import { FactoryPackagePreparationError } from "$server/factory/package-preparation";
import { FactoryRunLifecycleError } from "$server/factory/run-lifecycle";
import { FactoryArtifactError } from "$server/factory/artifacts";
import { FactoryArtifactAccessError } from "$server/factory/artifact-access";
import { requireScope } from "$lib/server/security/api-keys";
import { readBoundedJson } from "$lib/server/security/bounded-json";
import { FACTORY_STREAM_EVENT_NAMES } from "$lib/runtime-event-names";
import type { FactoryRunEventBatch } from "$server/factory/run-events";
import {
  FACTORY_API_REQUEST_SCHEMA_VERSION,
  FACTORY_API_RESPONSE_SCHEMA_VERSION,
  factoryApiPayloadDigest,
  validateFactoryApiRequest,
  validateFactoryApiResponse,
  type FactoryApiRequest,
  type FactoryApiResponse,
} from "@ezcorp/factory-sdk";

/** `session` means a human interactive session; `admin-session` adds the tenant administrator role. */
export type FactoryConsoleScope = "read" | "write" | "session" | "admin-session";
type ConsoleEvent = { readonly request: Request; readonly url: URL; readonly locals: App.Locals };
type Fields = Readonly<Record<string, unknown>>;
type MutationRequest = Extract<FactoryApiRequest, { preconditions: unknown }>;

const MUTATION_KINDS: ReadonlySet<string> = new Set(["package.install", "package.trust", "purge.request", "artifact.share", "artifact.unshare"]);

/** Console bodies are small; 64 KiB bounds every one of them. */
export function readFactoryConsoleJson(request: Request): Promise<unknown> {
  return readBoundedJson(request, 65_536);
}

export interface FactoryConsoleContext {
  readonly principal: FactoryPrincipal;
  readonly console: FactoryConsoleServices;
  readonly request: FactoryApiRequest;
}

export interface FactoryConsoleRouteOptions<Result> {
  readonly scope: FactoryConsoleScope;
  readonly build: () => Fields | Promise<Fields>;
  readonly run: (context: FactoryConsoleContext) => Promise<Result>;
  /** Turns the result into a response. Defaults to a validated SDK JSON response. */
  readonly respond?: (result: Result) => Response;
}

/** Authenticate, validate, run, and map every failure to exactly one status. */
export async function handleFactoryConsoleApi<Result extends FactoryApiResponse | Response>(event: ConsoleEvent, options: FactoryConsoleRouteOptions<Result>): Promise<Response> {
  if (!factoryBootConfig.enabled) return factoryConsoleError(404, FACTORY_DISABLED_REASON, "Factories are disabled.");
  const application = getFactoryApplication();
  if (!application) return factoryConsoleError(503, "factory_application_unavailable", "Factory services are not ready.", true);
  const principal = resolveFactoryConsolePrincipal(event.locals, options.scope);
  if (principal instanceof Response) return principal;
  let request: FactoryApiRequest;
  try {
    request = buildConsoleRequest(event.request, await options.build());
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof SyntaxError) return factoryConsoleError(400, "invalid_json", error.message);
    throw error;
  }
  const service = event.locals.factoryServicePrincipal;
  if (principal.kind === "service" && service && request.path.projectId !== service.projectId) {
    return factoryConsoleError(403, "factory_service_project_mismatch", "The service credential does not permit this project.");
  }
  try {
    const result = await options.run({ principal, console: await application.console(), request });
    if (result instanceof Response) return result;
    return options.respond ? options.respond(result) : factoryConsoleResponse(result);
  } catch (error) {
    return mapFactoryConsoleError(error);
  }
}

/**
 * The human-session form. Only an interactive session reaches `run`; with
 * `administrator` the tenant administrator role is required as well. No API
 * key of any scope can call a route built on this.
 */
export function handleFactoryConsoleSessionApi<Result extends FactoryApiResponse | Response>(event: ConsoleEvent, options: Omit<FactoryConsoleRouteOptions<Result>, "scope"> & { readonly administrator?: boolean }): Promise<Response> {
  return handleFactoryConsoleApi(event, { ...options, scope: options.administrator ? "admin-session" : "session" });
}

/**
 * The principal for one request, or the refusal. A service credential carries
 * only its delegated scopes and never a human-session row; a user must hold the
 * key scope, and the administrator rows also need the role.
 */
export function resolveFactoryConsolePrincipal(locals: App.Locals, scope: FactoryConsoleScope): FactoryPrincipal | Response {
  const service = locals.factoryServicePrincipal;
  if (service && (scope === "read" || scope === "write")) {
    if (!service.scopes.includes(scope)) return factoryConsoleError(403, "factory_service_scope_required", "The service credential does not permit this factory operation.");
    return { kind: "service", id: service.serviceAccountId, authentication: "service", credential: service };
  }
  const human = scope === "session" || scope === "admin-session";
  const user = human ? requireSessionAuth(locals) : checkAuth(locals);
  if (user instanceof Response) return user;
  if (!human) {
    const refused = requireScope(locals, scope);
    if (refused) return refused;
  }
  if (scope === "admin-session") {
    const role = checkRole(locals, "admin");
    if (role instanceof Response) return role;
  }
  if (locals.authMethod === "session") return { kind: "user", id: user.id, authentication: "session" };
  if (locals.authMethod === "api-key" && !human) return { kind: "user", id: user.id, authentication: "api-key" };
  return factoryConsoleError(403, "factory_principal_unsupported", "This authentication method cannot use factories.");
}

function buildConsoleRequest(httpRequest: Request, fields: Fields): FactoryApiRequest {
  let candidate: unknown = { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, ...fields };
  if (typeof fields.kind === "string" && MUTATION_KINDS.has(fields.kind)) {
    const ifMatch = httpRequest.headers.get("If-Match");
    if (ifMatch === null || !/^(0|[1-9][0-9]{0,15})$/.test(ifMatch) || !Number.isSafeInteger(Number(ifMatch))) {
      throw factoryConsoleError(412, "precondition_required", "A valid If-Match revision is required.");
    }
    const provisional = {
      ...(candidate as object),
      preconditions: { idempotencyKey: httpRequest.headers.get("Idempotency-Key") ?? "", payloadDigest: "0".repeat(64), expectedRevision: Number(ifMatch) },
    } as MutationRequest;
    candidate = { ...provisional, preconditions: { ...provisional.preconditions, payloadDigest: factoryApiPayloadDigest(provisional) } };
  }
  const validation = validateFactoryApiRequest(candidate);
  if (!validation.ok) {
    const precondition = validation.issues.some(item => item.code === "API_EXPECTED_REVISION" || item.code === "API_IDEMPOTENCY_KEY");
    throw factoryConsoleError(precondition ? 412 : 400, validation.issues[0]?.code ?? "invalid_request", validation.issues[0]?.message ?? "Invalid factory request.");
  }
  return candidate as FactoryApiRequest;
}

export function factoryConsoleResponse(value: FactoryApiResponse): Response {
  const validation = validateFactoryApiResponse(value);
  if (!validation.ok) throw new Error(`Invalid factory API response: ${validation.issues[0]?.code ?? "unknown"}`);
  return Response.json(value, { status: 200, headers: { "Cache-Control": "no-store" } });
}

export function factoryConsoleError(status: number, code: string, message: string, retryable = false): Response {
  const value = { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "error", error: { code, message, retryable } } as FactoryApiResponse;
  const validation = validateFactoryApiResponse(value);
  if (!validation.ok) throw new Error(`Invalid factory API error response: ${validation.issues[0]?.code ?? "unknown"}`);
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

const CONSOLE_STATUS: Readonly<Record<string, readonly [number, string]>> = {
  factory_cursor_invalid: [400, "The event cursor is not valid for this run."],
  factory_cursor_expired: [410, "The event cursor expired. Take a new snapshot."],
  factory_page_invalid: [400, "The page request is invalid."],
  factory_package_not_found: [404, "Runner package not found."],
  factory_package_admin_required: [403, "A tenant administrator is required."],
  factory_purge_confirmation: [400, "The confirmation must name this tenant exactly."],
  factory_artifact_not_found: [404, "Artifact not found."],
  factory_ticket_invalid: [403, "The artifact ticket is not valid for this request."],
  factory_ticket_expired: [410, "The artifact ticket expired."],
};

/**
 * One status per failure. A missing run and a forbidden project answer
 * differently only after authority is established, so neither leaks existence.
 */
export function mapFactoryConsoleError(error: unknown): Response {
  if (error instanceof FactoryConsoleError) {
    const [status, message] = CONSOLE_STATUS[error.code]!;
    return factoryConsoleError(status, error.code, message);
  }
  if (error instanceof FactoryGrantError) {
    if (error.code === "factory_forbidden" || error.code === "factory_human_required") return factoryConsoleError(403, error.code, "Factory authority is required.");
    return factoryConsoleError(500, error.code, "Factory grant storage is unavailable.", true);
  }
  if (error instanceof FactoryMutationError) {
    if (error.code === "idempotency_conflict") return factoryConsoleError(409, error.code, "The idempotency key was already used for a different request.");
    if (error.code === "invalid_idempotency_key") return factoryConsoleError(400, error.code, "A bounded Idempotency-Key is required.");
    return factoryConsoleError(500, error.code, "The durable mutation receipt is unavailable.", true);
  }
  if (error instanceof FactoryRunLifecycleError) {
    if (error.code === "factory_run_not_found") return factoryConsoleError(404, error.code, "Factory run not found.");
    return factoryConsoleError(500, error.code, "Factory run storage is unavailable.", true);
  }
  if (error instanceof FactoryPackagePreparationError) {
    if (error.code === "factory_package_trust_conflict") return factoryConsoleError(412, error.code, "The package trust revision is stale or the transition is not allowed.");
    if (error.code === "factory_package_human_required") return factoryConsoleError(403, error.code, "A human tenant administrator session is required.");
    if (error.code === "factory_package_trust_invalid" || error.code.startsWith("factory_package_reference") || error.code === "factory_package_manifest_name_invalid") return factoryConsoleError(400, error.code, "The package request is invalid.");
    if (error.code === "factory_package_release_unavailable" || error.code === "factory_package_binding_missing") return factoryConsoleError(404, error.code, "The installed package release was not found.");
    if (error.code === "factory_package_binding_conflict") return factoryConsoleError(409, error.code, "A different package is already bound to this reference.");
    return factoryConsoleError(500, error.code, "Package storage is unavailable.", true);
  }
  if (error instanceof FactoryArtifactError || error instanceof FactoryArtifactAccessError) {
    if (error.code.endsWith("_not_found") || error.code.endsWith("_unavailable")) return factoryConsoleError(404, error.code, "Artifact not found.");
    if (error.code === "factory_human_required") return factoryConsoleError(403, error.code, "A human session is required to share an artifact.");
    if (error.code.endsWith("_conflict")) return factoryConsoleError(409, error.code, "A different share already uses this identity.");
    if (error.code.endsWith("_invalid")) return factoryConsoleError(400, error.code, "The artifact request is invalid.");
    return factoryConsoleError(500, error.code, "Artifact storage is unavailable.", true);
  }
  throw error;
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
          const mapped = mapFactoryConsoleError(error);
          reason = mapped.status === 403 ? "revoked" : mapped.status === 410 ? "expired" : mapped.status === 404 ? "not-found" : "unavailable";
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
