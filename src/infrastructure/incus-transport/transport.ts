import { createHash, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { checkServerIdentity, connect as tlsConnect, type PeerCertificate } from "node:tls";
import {
  IncusTransportError,
  type IncusProbeResult,
  type IncusTransport,
  type IncusTransportRequest,
} from "../../../extensions/incus-sandbox/transport";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_HTTP_HEADER_BYTES = 8 * 1024;
const MAX_HTTP_WIRE_BYTES = MAX_RESPONSE_BYTES + MAX_HTTP_HEADER_BYTES + 16 * 1024;
const MAX_DEADLINE_MS = 30_000;

export interface HostConnectionScope {
  providerInstallationId: string;
  providerReleaseId: string;
  revision: number;
  signal?: AbortSignal;
  approvedPreset?: {
    /** Contract profile identifier, such as linux-exec.v1. */
    profile: string;
    /** Profile name in the approved Incus project. */
    incusProfile: string;
    presetId: string;
    presetDigest: string;
    effectiveSettingsDigest: string;
    imageFingerprint: string;
    limits: { memoryBytes: number; cpuMillis: number; pids: number; diskBytes: number };
  };
  approvedGuest?: { user: string; uid: number; gid: number; helperSha256: string };
}

export interface ResolvedIncusConnection {
  endpoint: string;
  serverCertificatePem: string;
  project: string;
  clientCertificatePem: string;
  privateKeyPem: string;
}

export interface HostConnectionResolver {
  resolveForHost(input: {
    connectionId: string;
    providerInstallationId: string;
    providerReleaseId: string;
    revision: number;
  }): Promise<ResolvedIncusConnection>;
}

export type PinnedFetch = (url: string, init: RequestInit & {
  proxy: false;
  decompress: false;
  tls: {
    cert: string;
    key: string;
    ca: string;
    rejectUnauthorized: true;
    checkServerIdentity: (hostname: string, certificate: PeerCertificate) => Error | undefined;
  };
}) => Promise<Response>;

function parseChunkedBody(wire: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  let total = 0;
  for (;;) {
    const lineEnd = wire.indexOf("\r\n", offset);
    if (lineEnd < 0 || lineEnd - offset > 32) throw new Error("Invalid Incus HTTP chunk");
    const sizeText = wire.toString("ascii", offset, lineEnd).split(";", 1)[0];
    if (!sizeText || !/^[a-fA-F0-9]+$/.test(sizeText)) throw new Error("Invalid Incus HTTP chunk");
    const size = Number.parseInt(sizeText, 16);
    offset = lineEnd + 2;
    if (size === 0) {
      if (wire.toString("ascii", offset) !== "\r\n") throw new Error("Invalid Incus HTTP trailer");
      return Buffer.concat(chunks, total);
    }
    total += size;
    if (total > MAX_RESPONSE_BYTES) throw new IncusTransportError("resource_exhausted", "Incus probe response is too large");
    if (offset + size + 2 > wire.length || wire[offset + size] !== 13 || wire[offset + size + 1] !== 10) {
      throw new Error("Invalid Incus HTTP chunk");
    }
    chunks.push(wire.subarray(offset, offset + size));
    offset += size + 2;
  }
}

function parseHttpResponse(wire: Buffer): Response {
  const separator = wire.indexOf("\r\n\r\n");
  if (separator < 0) throw new Error("Invalid Incus HTTP headers");
  if (separator > MAX_HTTP_HEADER_BYTES) throw new IncusTransportError("resource_exhausted", "Incus probe headers are too large");
  const lines = wire.toString("latin1", 0, separator).split("\r\n");
  const statusLine = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: |$)/.exec(lines.shift() ?? "");
  if (!statusLine) throw new Error("Invalid Incus HTTP status");
  const status = Number(statusLine[1]);
  if (status < 200) throw new Error("Unexpected Incus HTTP status");
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(line.slice(0, colon))) {
      throw new Error("Invalid Incus HTTP header");
    }
    headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  const encoding = headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") throw new Error("Unsupported Incus HTTP encoding");
  const wireBody = wire.subarray(separator + 4);
  let body: Buffer;
  const transferEncoding = headers.get("transfer-encoding");
  if (transferEncoding) {
    if (transferEncoding.toLowerCase() !== "chunked" || headers.has("content-length")) {
      throw new Error("Invalid Incus HTTP framing");
    }
    body = parseChunkedBody(wireBody);
  } else if (headers.has("content-length")) {
    const lengthText = headers.get("content-length")!;
    if (!/^(0|[1-9][0-9]*)$/.test(lengthText)) throw new Error("Invalid Incus HTTP length");
    const length = Number(lengthText);
    if (length > MAX_RESPONSE_BYTES) throw new IncusTransportError("resource_exhausted", "Incus probe response is too large");
    if (wireBody.length !== length) throw new Error("Invalid Incus HTTP body length");
    body = wireBody;
  } else {
    if (wireBody.length > MAX_RESPONSE_BYTES) throw new IncusTransportError("resource_exhausted", "Incus probe response is too large");
    body = wireBody;
  }
  return new Response(status === 204 || status === 304 ? null : Uint8Array.from(body), { status, headers });
}

// Queue no HTTP bytes until the TLS socket is authorized and its actual leaf
// matches the stored pin. Bun fetch and https.request can deliver a GET before
// a checkServerIdentity rejection, so the socket is checked here explicitly.
export function verifiedHttpsRequest(url: string, init: Parameters<PinnedFetch>[1]): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const socket = tlsConnect({
      host: hostname,
      port: target.port ? Number(target.port) : 443,
      servername: isIP(hostname) ? undefined : hostname,
      cert: init.tls.cert,
      key: init.tls.key,
      ca: init.tls.ca,
      rejectUnauthorized: true,
      checkServerIdentity: init.tls.checkServerIdentity,
    });
    const abort = () => socket.destroy(new Error("Incus probe was cancelled"));
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) abort();
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("Incus HTTP connection closed before completion")));
    socket.once("secureConnect", () => {
      const peer = socket.getPeerCertificate(true);
      const identityError = init.tls.checkServerIdentity(hostname, peer);
      if (!socket.authorized || !peer.raw || identityError) {
        socket.destroy();
        reject(new Error("Incus server identity was rejected"));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      socket.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_HTTP_WIRE_BYTES) {
          socket.destroy();
          reject(new IncusTransportError("resource_exhausted", "Incus probe response is too large"));
          return;
        }
        chunks.push(chunk);
      });
      socket.once("end", () => {
        try { resolve(parseHttpResponse(Buffer.concat(chunks, length))); }
        catch (error) { reject(error); }
      });
      const method = init.method ?? "GET";
      if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) {
        socket.destroy();
        reject(new Error("Unsupported Incus method"));
        return;
      }
      const body = typeof init.body === "string" ? init.body : "";
      if (Buffer.byteLength(body) > 16 * 1024) {
        socket.destroy();
        reject(new IncusTransportError("resource_exhausted", "Incus request is too large"));
        return;
      }
      const ifMatch = new Headers(init.headers).get("if-match");
      if (ifMatch && (!/^[\x21-\x7e]{1,128}$/.test(ifMatch) || ifMatch.includes("\r") || ifMatch.includes("\n"))) {
        socket.destroy(); reject(new Error("Invalid Incus ETag")); return;
      }
      const headers = `${method} ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n${ifMatch ? `If-Match: ${ifMatch}\r\n` : ""}${body ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` : ""}\r\n`;
      socket.write(headers + body);
    });
  });
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IncusTransportError("unavailable", "Invalid Incus probe response");
  }
  return value as Record<string, unknown>;
}

export function pinnedOrigin(endpoint: string): URL {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password
      || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
      throw new Error("invalid endpoint");
    }
    return url;
  } catch {
    throw new IncusTransportError("invalid", "Invalid Incus connection endpoint");
  }
}

export function pinnedCertificate(pem: string): X509Certificate {
  try {
    return new X509Certificate(pem);
  } catch {
    throw new IncusTransportError("permission", "Invalid Incus server certificate");
  }
}

export async function boundedJson(response: Response, allowErrorStatus = false): Promise<Record<string, unknown>> {
  if (response.status >= 300 && response.status < 400) {
    throw new IncusTransportError("permission", "Incus probe redirect was denied");
  }
  if (!response.ok && !allowErrorStatus) throw new IncusTransportError("unavailable", "Incus probe request failed");
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
    throw new IncusTransportError("resource_exhausted", "Incus probe response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new IncusTransportError("unavailable", "Incus probe response has no body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        throw new IncusTransportError("resource_exhausted", "Incus probe response is too large");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return object(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof IncusTransportError) throw error;
    throw new IncusTransportError("unavailable", "Invalid Incus probe response");
  }
}

function metadata(envelope: Record<string, unknown>): Record<string, unknown> {
  if (envelope.type !== "sync" || envelope.status_code !== 200) {
    throw new IncusTransportError("unavailable", "Incus probe did not complete");
  }
  return object(envelope.metadata);
}

/** A host-only read probe. Unsupported actions cannot resolve credentials or issue HTTP. */
export class HostIncusProbeTransport implements IncusTransport {
  constructor(
    private readonly connections: HostConnectionResolver,
    private readonly scope: HostConnectionScope,
    private readonly http: PinnedFetch = verifiedHttpsRequest,
  ) {}

  async request(command: Readonly<IncusTransportRequest>): Promise<IncusProbeResult> {
    if (command.action !== "probe") {
      throw new IncusTransportError("unsupported", "Incus transport action is unavailable");
    }
    if (command.connectionId !== command.pins.connectionId || command.tags.connectionId !== command.connectionId
      || command.tags.managedBy !== "ezharness-incus-sandbox"
      || (typeof command.payload === "object" && command.payload !== null && !Array.isArray(command.payload)
        && command.payload.allocate === true)
      || !Number.isFinite(command.deadlineMs) || command.deadlineMs <= Date.now()
      || command.deadlineMs - Date.now() > MAX_DEADLINE_MS) {
      throw new IncusTransportError("invalid", "Invalid Incus probe request");
    }
    if (!/^[a-f0-9]{64}$/.test(command.pins.serverCertificateSha256)
      || !/^[a-z][a-z0-9-]{0,62}$/.test(command.pins.project)
      || command.pins.project === "default"
      || !/^[a-z][a-z0-9-]{0,62}$/.test(command.pins.profile)
      || command.pins.profile === "default") {
      throw new IncusTransportError("invalid", "Invalid Incus probe pins");
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    this.scope.signal?.addEventListener("abort", onAbort, { once: true });
    if (this.scope.signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), Math.max(0, command.deadlineMs - Date.now()));
    const deadline = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new IncusTransportError("deadline", "Incus probe deadline was exceeded")), { once: true });
      if (controller.signal.aborted) reject(new IncusTransportError("deadline", "Incus probe deadline was exceeded"));
    });
    try {
      const connection = await Promise.race([
        this.connections.resolveForHost({ connectionId: command.connectionId, providerInstallationId: this.scope.providerInstallationId, providerReleaseId: this.scope.providerReleaseId, revision: this.scope.revision })
          .catch(() => { throw new IncusTransportError("not_found", "Incus connection is unavailable"); }),
        deadline,
      ]);
      if (connection.project !== command.pins.project) {
        throw new IncusTransportError("permission", "Incus project pin does not match");
      }
      const certificate = pinnedCertificate(connection.serverCertificatePem);
      const actualFingerprint = createHash("sha256").update(certificate.raw).digest("hex");
      if (actualFingerprint !== command.pins.serverCertificateSha256) {
        throw new IncusTransportError("permission", "Incus server certificate pin does not match");
      }
      const origin = pinnedOrigin(connection.endpoint);
      const hostname = origin.hostname.replace(/^\[|\]$/g, "");
      const matchesEndpoint = isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname);
      if (!matchesEndpoint) {
        throw new IncusTransportError("permission", "Incus server certificate does not match the endpoint");
      }
      const tls = {
        cert: connection.clientCertificatePem,
        key: connection.privateKeyPem,
        ca: connection.serverCertificatePem,
        rejectUnauthorized: true as const,
        checkServerIdentity: (hostname: string, peer: PeerCertificate): Error | undefined => {
          const nameError = checkServerIdentity(hostname, peer);
          if (nameError) return new Error("Incus server identity was rejected");
          if (!peer.raw || createHash("sha256").update(peer.raw).digest("hex") !== actualFingerprint) {
            return new Error("Incus server certificate pin does not match");
          }
          return undefined;
        },
      };
      const get = async (path: string): Promise<Record<string, unknown>> => {
        const url = new URL(path, origin);
        const response = await Promise.race([
          this.http(url.href, { method: "GET", redirect: "manual", proxy: false, decompress: false, signal: controller.signal, tls }),
          deadline,
        ]);
        return metadata(await Promise.race([boundedJson(response), deadline]));
      };
      const server = await get(`/1.0?project=${encodeURIComponent(connection.project)}`);
      const project = await get(`/1.0/projects/${encodeURIComponent(connection.project)}`);
      const profile = await get(`/1.0/profiles/${encodeURIComponent(command.pins.profile)}?project=${encodeURIComponent(connection.project)}`);
      if (project.name !== connection.project || profile.name !== command.pins.profile) {
        throw new IncusTransportError("permission", "Incus project or profile identity does not match");
      }
      const environment = object(server.environment);
      const architecture = environment.kernel_architecture === "x86_64" ? "amd64"
        : environment.kernel_architecture === "aarch64" ? "arm64" : undefined;
      if (!architecture || typeof environment.server_version !== "string" || server.api_version !== "1.0") {
        throw new IncusTransportError("unavailable", "Incus server information is unsupported");
      }
      // The REST probe cannot attest guest helper behavior. False controls make preflight fail closed.
      return {
        serverCertificateSha256: actualFingerprint,
        project: connection.project,
        profile: command.pins.profile,
        helperVersion: "unverified",
        backendApi: "incus.v1",
        backendVersion: environment.server_version,
        architecture,
        storageDriver: "unverified",
        isolation: "container",
        nestedCompose: false,
        controls: {
          restrictedProject: object(project.config)["restricted"] === "true",
          unprivileged: false,
          projectLimits: false,
          privateNetwork: false,
          workspaceRoot: "/workspace",
          explicitGuestUser: false,
          atomicFileReplace: false,
          durableProcesses: false,
          boundedOutput: false,
          endpointProxy: false,
        },
      };
    } catch (error) {
      if (error instanceof IncusTransportError) throw error;
      if (controller.signal.aborted) throw new IncusTransportError("deadline", "Incus probe deadline was exceeded");
      throw new IncusTransportError("unavailable", "Incus probe request failed");
    } finally {
      clearTimeout(timer);
      this.scope.signal?.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }
}
