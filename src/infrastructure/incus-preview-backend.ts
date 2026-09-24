import { createHash, randomUUID } from "node:crypto";
import type { ProviderSandboxWorkspaceCaller } from "../runtime/workspaces/provider-backend";
import type { SandboxPreviewBackend, SandboxPreviewServeRequest } from "../runtime/workspaces/target";

const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 800 * 1024;
const PAGE_BYTES = 64 * 1024;
const POLLS = 24;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const REQUEST_HEADERS = new Set(["accept", "accept-language", "content-type", "if-none-match", "if-modified-since", "range"]);
const RESPONSE_HEADERS = new Set(["content-type", "cache-control", "location", "set-cookie", "etag", "last-modified", "content-encoding", "accept-ranges", "content-range"]);

// The destination is fixed inside the guest. This script cannot use the
// browser's Host header, a redirect target, or an arbitrary agent URL.
const GUEST_HTTP = `import base64,http.client,json,os,sys
r=json.loads(base64.b64decode(os.environ["EZH_PREVIEW_REQUEST"]))
c=http.client.HTTPConnection("127.0.0.1",r["port"],timeout=8)
try:
 c.request(r["method"],r["path"],body=base64.b64decode(r["body"]),headers=dict(r["headers"]))
 p=c.getresponse()
 b=p.read(${MAX_RESPONSE_BYTES + 1})
 if len(b)>${MAX_RESPONSE_BYTES}: sys.exit(2)
 h=[(k,v) for k,v in p.getheaders() if k.lower() in ${JSON.stringify([...RESPONSE_HEADERS])} and len(v)<=4096][:32]
 print(json.dumps({"status":p.status,"headers":h,"body":base64.b64encode(b).decode("ascii")},separators=(",",":")))
finally:
 c.close()`;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sandbox preview reply");
  return value as Record<string, unknown>;
}

function positivePort(value: number | null): number {
  if (!Number.isSafeInteger(value) || value! < 1024 || value! > 65535) throw new Error("Invalid sandbox preview port");
  return value!;
}

async function boundedBody(request: Request): Promise<Buffer> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) throw new Error("Preview request body is too large");
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) throw new Error("Preview request body is too large");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function pathOf(request: SandboxPreviewServeRequest): string {
  const original = new URL(request.request.url);
  const path = `${request.requestPath}${original.search}`;
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 2048
    || [...path].some(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) {
    throw new Error("Invalid sandbox preview path");
  }
  return path;
}

/** Bounded HTTP relay over the already approved guest process channel.
 * WebSocket upgrades stay closed until a separately qualified streaming relay exists. */
export class IncusSandboxPreviewBackend implements SandboxPreviewBackend {
  constructor(private readonly caller: ProviderSandboxWorkspaceCaller, private readonly now: () => number = Date.now) {}

  async open(request: Parameters<SandboxPreviewBackend["open"]>[0]): Promise<void> {
    positivePort(request.targetPort);
    if (request.expiresAt.getTime() <= this.now() || request.expiresAt.getTime() > this.now() + 24 * 60 * 60 * 1000) {
      throw new Error("Invalid sandbox preview expiry");
    }
  }

  async close(_request: Parameters<SandboxPreviewBackend["close"]>[0]): Promise<void> {
    // The durable registry revokes access; no guest listener is created here.
  }

  async serve(request: SandboxPreviewServeRequest): Promise<Response> {
    const port = positivePort(request.targetPort);
    if (request.expiresAt.getTime() <= this.now() || !ALLOWED_METHODS.has(request.request.method)) {
      throw new Error("Sandbox preview is unavailable");
    }
    const path = pathOf(request);
    const headers = [...request.request.headers]
      .filter(([name, value]) => REQUEST_HEADERS.has(name.toLowerCase()) && value.length <= 4096)
      .slice(0, 16);
    const body = await boundedBody(request.request);
    const payload = Buffer.from(JSON.stringify({ port, method: request.request.method, path, headers,
      body: body.toString("base64") })).toString("base64");
    if (payload.length > 8192) throw new Error("Sandbox preview request exceeds the guest limit");
    const requestId = `preview-${createHash("sha256").update(request.previewId).update(randomUUID()).digest("hex").slice(0, 48)}`;
    let sequence = 0;
    const call = (action: "process.start" | "process.inspect" | "process.readOutput" | "process.cancel", input: Record<string, unknown>) =>
      this.caller.call({ binding: request.binding, toolCallId: `${requestId}:${++sequence}`, action, payload: input,
        signal: action === "process.cancel" ? undefined : request.request.signal });
    const started = object(await call("process.start", { argv: ["python3", "-c", GUEST_HTTP], cwd: ".", user: "sandbox",
      env: [{ name: "EZH_PREVIEW_REQUEST", value: payload }], processDeadlineMs: this.now() + 12_000 }));
    if (started.ok !== true || typeof started.processId !== "string" || typeof started.bootId !== "string") {
      throw new Error("Sandbox preview process did not start");
    }
    const processId = started.processId;
    const bootId = started.bootId;
    let terminal = false;
    for (let attempt = 0; attempt < POLLS; attempt++) {
      if (request.request.signal.aborted) {
        await call("process.cancel", { processId, bootId }).catch(() => undefined);
        throw new Error("Sandbox preview was cancelled");
      }
      const inspected = object(await call("process.inspect", { processId, bootId }));
      const process = object(inspected.process);
      if (process.state === "succeeded") { terminal = true; break; }
      if (process.state !== "starting" && process.state !== "running") throw new Error("Sandbox preview process failed");
      await Bun.sleep(500);
    }
    if (!terminal) {
      await call("process.cancel", { processId, bootId }).catch(() => undefined);
      throw new Error("Sandbox preview process exceeded its deadline");
    }
    let cursor: Record<string, unknown> = { sandboxId: request.binding.workspaceId, processId, bootId, offsetBytes: 0 };
    const output: Buffer[] = [];
    let size = 0;
    for (let page = 0; page < 16; page++) {
      const reply = object(await call("process.readOutput", { processId, bootId, cursor, maxBytes: PAGE_BYTES }));
      if (reply.ok !== true || reply.gap || !Array.isArray(reply.chunks)) throw new Error("Sandbox preview output is incomplete");
      for (const raw of reply.chunks) {
        const chunk = object(raw);
        if (chunk.stream !== "stdout" || typeof chunk.dataBase64 !== "string") throw new Error("Sandbox preview output is invalid");
        const bytes = Buffer.from(chunk.dataBase64, "base64");
        size += bytes.byteLength;
        if (size > MAX_OUTPUT_BYTES) throw new Error("Sandbox preview output exceeds its limit");
        output.push(bytes);
      }
      if (reply.eof === true) break;
      cursor = object(reply.nextCursor);
      if (page === 15) throw new Error("Sandbox preview output did not complete");
    }
    const value = object(JSON.parse(Buffer.concat(output).toString("utf8")));
    if (!Number.isSafeInteger(value.status) || (value.status as number) < 200 || (value.status as number) > 599
      || !Array.isArray(value.headers) || typeof value.body !== "string") throw new Error("Invalid sandbox preview response");
    const responseHeaders = new Headers();
    for (const raw of value.headers) {
      if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== "string" || typeof raw[1] !== "string"
        || !RESPONSE_HEADERS.has(raw[0].toLowerCase()) || raw[1].length > 4096) throw new Error("Invalid sandbox preview response header");
      responseHeaders.append(raw[0], raw[1]);
    }
    const bytes = Buffer.from(value.body, "base64");
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Sandbox preview response exceeds its limit");
    const noBody = request.request.method === "HEAD" || [204, 205, 304].includes(value.status as number);
    return new Response(noBody ? null : bytes, { status: value.status as number, headers: responseHeaders });
  }
}
