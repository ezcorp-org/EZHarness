/**
 * One `/metrics` listener, shared by every factory service (C11 M4).
 *
 * `node:http`, so the Node orchestrator and the Bun services serve the same
 * code. It binds the address the service's own configuration names, which is
 * an internal one, and answers only a scraper presenting the bearer token read
 * from a private file. A failed collection is a bare 503: the cause can quote
 * a connection string, and the scrape answer is the wrong place for it.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readPrivateText } from "../private-files.ts";
import { factoryMetricRenderer, type FactoryMetricSample, type FactoryMetricService, type FactoryRegisteredValues } from "./metric-registry.ts";

export const FACTORY_METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

const TOKEN_MIN_BYTES = 32;
const TOKEN_MAX_BYTES = 512;

// Fields, not parameter properties: the Node orchestrator loads this file with type stripping only.
export class FactoryMetricsListenerError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Factory metrics listener refused: ${code}.`);
    this.name = "FactoryMetricsListenerError";
    this.code = code;
  }
}

/** The scrape token, trimmed as Prometheus trims a credentials file. */
export async function loadFactoryMetricsToken(path: string): Promise<string> {
  let token: string;
  try { token = (await readPrivateText(path, TOKEN_MAX_BYTES + 2)).trim(); } catch { throw new FactoryMetricsListenerError("factory_metrics_token_unreadable"); }
  if (Buffer.byteLength(token) < TOKEN_MIN_BYTES || Buffer.byteLength(token) > TOKEN_MAX_BYTES) throw new FactoryMetricsListenerError("factory_metrics_token_invalid");
  return token;
}

export interface FactoryMetricsListenerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly scrapeToken: string;
  /** Collects and renders one scrape; a rejection is answered 503 with no body. */
  readonly scrape: () => Promise<string>;
}

export interface FactoryMetricsListener {
  readonly url: string;
  stop(): Promise<void>;
}

function authorized(request: IncomingMessage, token: Buffer): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  return given.length === token.length && timingSafeEqual(given, token);
}

export async function startFactoryMetricsListener(options: FactoryMetricsListenerOptions): Promise<FactoryMetricsListener> {
  const token = Buffer.from(options.scrapeToken);
  const answer = (response: ServerResponse, status: number, body = "", type?: string) => {
    response.writeHead(status, type === undefined ? {} : { "content-type": type });
    response.end(body);
  };
  const server = createServer((request, response) => {
    if (new URL(request.url ?? "/", "http://metrics").pathname !== "/metrics") return answer(response, 404);
    if (request.method !== "GET") return answer(response, 405);
    if (!authorized(request, token)) return answer(response, 401);
    options.scrape().then(
      (text) => answer(response, 200, text, FACTORY_METRICS_CONTENT_TYPE),
      () => answer(response, 503),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => { server.off("error", reject); resolve(); });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${options.hostname}:${port}`,
    stop: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

/** Where one service serves `/metrics`, as every process configuration declares it. */
export interface FactoryMetricsEndpoint {
  readonly hostname: string;
  readonly port: number;
  readonly scrapeTokenPath: string;
}

export function wellFormedFactoryMetricsEndpoint(value: unknown): value is FactoryMetricsEndpoint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "hostname,port,scrapeTokenPath"
    && typeof record.hostname === "string" && /^[A-Za-z0-9.:-]{1,253}$/.test(record.hostname)
    && Number.isSafeInteger(record.port) && (record.port as number) >= 1 && (record.port as number) <= 65_535
    && typeof record.scrapeTokenPath === "string" && record.scrapeTokenPath.length > 0 && record.scrapeTokenPath.length <= 4_096 && !record.scrapeTokenPath.includes("\0");
}

/**
 * Loads the token and serves `service`'s families from `collect`, through the
 * production renderer: a refused series is dropped and counted, never thrown.
 * `registered` is read per scrape; a scrape that cannot be rendered is a 503.
 * Scrapes that arrive while one collection runs share it and its body (F9), so
 * two scrapers cost one set of queries; the next scrape after it collects again.
 */
export async function serveFactoryMetrics(
  endpoint: FactoryMetricsEndpoint,
  service: FactoryMetricService,
  collect: () => Promise<readonly FactoryMetricSample[]>,
  registered: FactoryRegisteredValues | (() => Promise<FactoryRegisteredValues>) = {},
): Promise<FactoryMetricsListener> {
  const scrapeToken = await loadFactoryMetricsToken(endpoint.scrapeTokenPath);
  const production = factoryMetricRenderer(service, { strict: false });
  const current = typeof registered === "function" ? registered : async () => registered;
  let inFlight: Promise<string> | undefined;
  const scrape = () => inFlight ??= (async () => production.render(await collect(), await current()))().finally(() => { inFlight = undefined; });
  return startFactoryMetricsListener({ hostname: endpoint.hostname, port: endpoint.port, scrapeToken, scrape });
}

/** How long a readiness probe may take before the gauge reads not ready: well inside a scrape's timeout. */
export const FACTORY_READY_PROBE_TIMEOUT_MS = 2_000;

/**
 * A service whose only family is its own readiness: the gateway, the orchestrator, the supervisor.
 * A probe that fails or does not answer in time reads as not ready; the endpoint itself stays up (F7).
 */
export function serveFactoryReadyMetrics(endpoint: FactoryMetricsEndpoint, service: FactoryMetricService, ready: () => boolean | Promise<boolean>, probeTimeoutMs = FACTORY_READY_PROBE_TIMEOUT_MS): Promise<FactoryMetricsListener> {
  return serveFactoryMetrics(endpoint, service, async () => [{ name: "factory_service_ready", value: await probeReady(ready, probeTimeoutMs) ? 1 : 0 }]);
}

async function probeReady(ready: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((settle) => { timer = setTimeout(() => settle(false), timeoutMs); });
  try { return await Promise.race([Promise.resolve().then(ready), expired]); }
  catch { return false; }
  finally { clearTimeout(timer); }
}

/** The code of a metrics start failure, never its message (which can quote a path). */
export function factoryMetricsFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z0-9_]{1,128}$/.test(code) ? code : "factory_metrics_unavailable";
}

/**
 * Starts a declared endpoint, or nothing. One that cannot start is reported
 * and skipped: the service keeps serving its real work, and the evaluator's
 * target-down alert names the missing scrape (C11 M4). Every service shares
 * this rule.
 */
export async function startDeclaredFactoryMetrics(
  endpoint: FactoryMetricsEndpoint | undefined,
  start: (endpoint: FactoryMetricsEndpoint) => Promise<FactoryMetricsListener>,
  report: (code: string) => void,
): Promise<FactoryMetricsListener | undefined> {
  if (endpoint === undefined) return undefined;
  try {
    return await start(endpoint);
  } catch (error) {
    report(factoryMetricsFailureCode(error));
    return undefined;
  }
}
