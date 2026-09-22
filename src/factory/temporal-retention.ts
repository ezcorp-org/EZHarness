import type { FactoryCheckpointTemporalSource, FactoryTemporalWorkflowPosition } from "./checkpoint-barrier";

/**
 * C06's Temporal half (W15): ordinary workflow history is kept 30 days after a
 * run closes, and history archival keeps it readable for diagnostic replay
 * through the 365-day audit period. Archival is a copy for replay, never a
 * second live execution engine.
 *
 * Both reads use Temporal's HTTP API (the gRPC gateway every Temporal server
 * serves), so the product process needs no Temporal SDK: `GET
 * /api/v1/namespaces/{namespace}` for the retention and archival settings, and
 * `GET /api/v1/namespaces/{namespace}/workflows/{workflowId}` for a workflow's
 * position. The provisioner applies the settings; this module verifies them
 * and records positions for a cluster-wide disaster restore.
 */

export const FACTORY_TEMPORAL_HISTORY_RETENTION_DAYS = 30;
export const FACTORY_TEMPORAL_ARCHIVAL_DAYS = 365;
const DAY_SECONDS = 86_400;

export class FactoryTemporalRetentionError extends Error {
  constructor(readonly code: "factory_temporal_invalid" | "factory_temporal_unreachable" | "factory_temporal_response_invalid", options?: { cause?: unknown }) {
    super(code, options);
    this.name = "FactoryTemporalRetentionError";
  }
}

export interface FactoryTemporalHttpOptions {
  /** The Temporal HTTP API base URL, for example `https://temporal.internal:7243`. */
  readonly endpoint: string;
  readonly namespace: string;
  /** Mutual TLS material for a deployment whose HTTP API requires it. Passed to `fetch` as Bun's `tls` option. */
  readonly tls?: { readonly cert: string; readonly key: string; readonly ca: string };
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** The arguments a provisioner passes to `temporal operator namespace create` or `update`. */
export function factoryTemporalNamespaceArguments(namespace: string, historyArchiveUri: string, visibilityArchiveUri: string): readonly string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(namespace) || !/^[a-z][a-z0-9+.-]*:\/\/\S+$/.test(historyArchiveUri) || !/^[a-z][a-z0-9+.-]*:\/\/\S+$/.test(visibilityArchiveUri)) throw new FactoryTemporalRetentionError("factory_temporal_invalid");
  return Object.freeze([
    "--namespace", namespace,
    "--retention", `${FACTORY_TEMPORAL_HISTORY_RETENTION_DAYS * 24}h`,
    "--history-archival-state", "enabled", "--history-uri", historyArchiveUri,
    "--visibility-archival-state", "enabled", "--visibility-uri", visibilityArchiveUri,
  ]);
}

export interface FactoryTemporalRetentionReport {
  readonly namespace: string;
  readonly retentionSeconds: number;
  readonly historyArchival: string;
  readonly historyArchiveUri: string | null;
  readonly visibilityArchival: string;
  readonly ready: boolean;
  readonly unmet: readonly string[];
}

function durationSeconds(value: unknown): number {
  if (typeof value !== "string" || !/^\d+(\.\d+)?s$/.test(value)) throw new FactoryTemporalRetentionError("factory_temporal_response_invalid");
  return Math.round(Number(value.slice(0, -1)));
}

async function getJson(options: FactoryTemporalHttpOptions, path: string, signal?: AbortSignal): Promise<{ readonly status: number; readonly body: unknown }> {
  let url: URL;
  try { url = new URL(path, options.endpoint); } catch { throw new FactoryTemporalRetentionError("factory_temporal_invalid"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FactoryTemporalRetentionError("factory_temporal_invalid");
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 5_000);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { accept: "application/json" }, ...(options.tls ? { tls: options.tls } : {}) } as RequestInit);
  } catch (cause) { throw new FactoryTemporalRetentionError("factory_temporal_unreachable", { cause }); }
  const text = await response.text();
  try { return { status: response.status, body: text ? JSON.parse(text) : null }; }
  catch (cause) { throw new FactoryTemporalRetentionError("factory_temporal_response_invalid", { cause }); }
}

/**
 * Reads the namespace's settings and names every unmet C06 criterion: history
 * kept at least thirty days, and history and visibility archival enabled with
 * an archive URI. It never changes the namespace.
 */
export async function verifyFactoryTemporalRetention(options: FactoryTemporalHttpOptions, signal?: AbortSignal): Promise<FactoryTemporalRetentionReport> {
  const { status, body } = await getJson(options, `/api/v1/namespaces/${encodeURIComponent(options.namespace)}`, signal);
  if (status !== 200 || !body || typeof body !== "object") throw new FactoryTemporalRetentionError(status === 200 ? "factory_temporal_response_invalid" : "factory_temporal_unreachable");
  const config = (body as { config?: Record<string, unknown> }).config ?? {};
  const retentionSeconds = durationSeconds(config.workflowExecutionRetentionTtl);
  const historyArchival = String(config.historyArchivalState ?? "ARCHIVAL_STATE_UNSPECIFIED");
  const visibilityArchival = String(config.visibilityArchivalState ?? "ARCHIVAL_STATE_UNSPECIFIED");
  const historyArchiveUri = typeof config.historyArchivalUri === "string" && config.historyArchivalUri ? config.historyArchivalUri : null;
  const unmet = [
    ...(retentionSeconds >= FACTORY_TEMPORAL_HISTORY_RETENTION_DAYS * DAY_SECONDS ? [] : ["history-retention-below-30-days"]),
    ...(historyArchival === "ARCHIVAL_STATE_ENABLED" && historyArchiveUri ? [] : ["history-archival-disabled"]),
    ...(visibilityArchival === "ARCHIVAL_STATE_ENABLED" ? [] : ["visibility-archival-disabled"]),
  ];
  return Object.freeze({ namespace: options.namespace, retentionSeconds, historyArchival, historyArchiveUri, visibilityArchival, ready: unmet.length === 0, unmet: Object.freeze(unmet) });
}

/** Records each live workflow's Temporal position. A workflow Temporal no longer has is `not_found` at length zero. */
export class FactoryTemporalHttpPositions implements FactoryCheckpointTemporalSource {
  readonly namespace: string;
  constructor(private readonly options: FactoryTemporalHttpOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(options.namespace)) throw new FactoryTemporalRetentionError("factory_temporal_invalid");
    this.namespace = options.namespace;
  }

  async positions(workflowIds: readonly string[], signal?: AbortSignal): Promise<readonly FactoryTemporalWorkflowPosition[]> {
    const positions: FactoryTemporalWorkflowPosition[] = [];
    for (const workflowId of workflowIds) {
      const { status, body } = await getJson(this.options, `/api/v1/namespaces/${encodeURIComponent(this.namespace)}/workflows/${encodeURIComponent(workflowId)}`, signal);
      if (status === 404) { positions.push({ workflowId, runId: null, status: "not_found", historyLength: 0 }); continue; }
      const info = (body as { workflowExecutionInfo?: { execution?: { runId?: unknown }; status?: unknown; historyLength?: unknown } } | null)?.workflowExecutionInfo;
      const historyLength = Number(info?.historyLength);
      if (status !== 200 || !info || typeof info.status !== "string" || !Number.isSafeInteger(historyLength) || historyLength < 0) throw new FactoryTemporalRetentionError("factory_temporal_response_invalid");
      positions.push({ workflowId, runId: typeof info.execution?.runId === "string" ? info.execution.runId : null, status: info.status, historyLength });
    }
    return positions;
  }
}
