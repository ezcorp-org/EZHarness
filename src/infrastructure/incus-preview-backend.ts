import { createHash, randomUUID } from "node:crypto";
import type { ProviderSandboxWorkspaceCaller } from "../runtime/workspaces/provider-backend";
import type { SandboxPreviewBackend, SandboxPreviewConnectRequest, SandboxPreviewServeRequest,
  SandboxPreviewSocket, SandboxPreviewServer, SandboxPreviewServerRequest, SandboxWorkspaceBinding } from "../runtime/workspaces/target";

const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 800 * 1024;
const PAGE_BYTES = 64 * 1024;
const POLLS = 24;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const REQUEST_HEADERS = new Set(["accept", "accept-language", "content-type", "if-none-match", "if-modified-since", "range"]);
const RESPONSE_HEADERS = new Set(["content-type", "cache-control", "location", "set-cookie", "etag", "last-modified", "content-encoding", "accept-ranges", "content-range"]);
const SERVER_LIFETIME_MS = 15 * 60_000;
const SERVER_READY_MS = 30_000;

// The fixed launcher prints its kernel identity before untrusted server code
// can write output. exec preserves that PID and the helper's process group.
const SERVER_LAUNCH = `import json,os
with open('/proc/self/stat') as f: start=f.read().rsplit(')',1)[1].split()[19]
print('EZH_PREVIEW_PROCESS '+str(os.getpid())+' '+start,flush=True)
argv=json.loads(os.environ['EZH_PREVIEW_ARGV'])
os.execvp(argv[0],argv)`;

// Enumerate only socket inodes held by this launched process group inside
// the selected guest. Neither server output nor a URL selects a destination.
const SERVER_PORTS = `import json,os
pid,start=json.loads(os.environ['EZH_PREVIEW_PROCESS'])
def identity():
 with open('/proc/'+str(pid)+'/stat') as f: return f.read().rsplit(')',1)[1].split()[19]
assert identity()==start and os.getpgid(pid)==pid
entries=os.listdir('/proc'); assert len(entries)<=8192
inodes=set()
for name in entries:
 if not name.isdecimal(): continue
 try:
  if os.getpgid(int(name))!=pid: continue
  descriptors=os.listdir('/proc/'+name+'/fd'); assert len(descriptors)<=4096
  for descriptor in descriptors:
   try: link=os.readlink('/proc/'+name+'/fd/'+descriptor)
   except FileNotFoundError: continue
   if link.startswith('socket:['): inodes.add(link[8:-1])
 except ProcessLookupError: continue
ports=set()
for path in ['/proc/net/tcp','/proc/net/tcp6']:
 with open(path) as f:
  rows=f.readlines(1024*1024); assert sum(map(len,rows))<1024*1024
 for row in rows[1:]:
  fields=row.split()
  if fields[3]=='0A' and fields[9] in inodes:
   port=int(fields[1].rsplit(':',1)[1],16)
   if 1024<=port<=65535: ports.add(port)
assert identity()==start and len(ports)<=16
print(json.dumps(sorted(ports)))`;

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
  return boundedPath(request.requestPath, original.search);
}

function boundedPath(requestPath: string, search: string): string {
  const path = `${requestPath}${search}`;
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 2048
    || [...path].some(character => character.charCodeAt(0) < 33 || character.charCodeAt(0) > 126 || character === "#")) {
    throw new Error("Invalid sandbox preview path");
  }
  return path;
}

type GuestAction = "process.start" | "process.inspect" | "process.readOutput" | "process.cancel";
type GuestCall = (action: GuestAction, input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

async function guestPayload(request: SandboxPreviewServeRequest, now: number): Promise<string> {
  const port = positivePort(request.targetPort);
  if (request.expiresAt.getTime() <= now || !ALLOWED_METHODS.has(request.request.method)) {
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
  return payload;
}

function guestCaller(caller: ProviderSandboxWorkspaceCaller, request: {
  binding: Readonly<SandboxWorkspaceBinding>; userId: string; previewId: string;
  request?: Request; signal?: AbortSignal;
}): GuestCall {
  const requestId = `preview-${createHash("sha256").update(request.previewId).update(randomUUID()).digest("hex").slice(0, 48)}`;
  let sequence = 0;
  return (action, input, signal) => caller.call({ binding: request.binding, toolCallId: `${requestId}:${++sequence}`, action, payload: input,
    principal: { userId: request.userId },
    signal: signal ?? (action === "process.cancel" ? undefined : (request.request?.signal ?? request.signal)) });
}

async function startGuest(call: GuestCall, payload: string, now: number,
  launch = { code: GUEST_HTTP, name: "EZH_PREVIEW_REQUEST", lifetime: 12_000 }): Promise<{ processId: string; bootId: string }> {
  const started = object(await call("process.start", { argv: ["python3", "-c", launch.code], cwd: ".", user: "sandbox",
    env: [{ name: launch.name, value: payload }], processDeadlineMs: now + launch.lifetime }));
  if (started.ok !== true || typeof started.processId !== "string" || typeof started.bootId !== "string") {
    throw new Error("Sandbox preview process did not start");
  }
  return { processId: started.processId, bootId: started.bootId };
}

async function awaitGuest(call: GuestCall, processId: string, bootId: string, signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < POLLS; attempt++) {
    if (signal.aborted) {
      await call("process.cancel", { processId, bootId }).catch(() => undefined);
      throw new Error("Sandbox preview was cancelled");
    }
    const inspected = object(await call("process.inspect", { processId, bootId }));
    const process = object(inspected.process);
    if (process.state === "succeeded") return;
    if (process.state !== "starting" && process.state !== "running") throw new Error("Sandbox preview process failed");
    await Bun.sleep(500);
  }
  await call("process.cancel", { processId, bootId }).catch(() => undefined);
  throw new Error("Sandbox preview process exceeded its deadline");
}

async function readGuestOutput(call: GuestCall, request: { binding: Readonly<SandboxWorkspaceBinding> },
                               processId: string, bootId: string): Promise<Buffer> {
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
  return Buffer.concat(output);
}

async function serverIdentity(call: GuestCall, processId: string, bootId: string,
  binding: Readonly<SandboxWorkspaceBinding>, signal: AbortSignal): Promise<[number, string]> {
  for (let attempt = 0; attempt < 24; attempt++) {
    signal.throwIfAborted();
    const value = object(await call("process.readOutput", { processId, bootId,
      cursor: { sandboxId: binding.workspaceId, processId, bootId, offsetBytes: 0 }, maxBytes: 256 }));
    if (value.ok !== true || value.gap || !Array.isArray(value.chunks)) throw new Error("Preview launch identity is unavailable");
    const bytes = value.chunks.filter(raw => object(raw).stream === "stdout")
      .map(raw => Buffer.from(String(object(raw).dataBase64), "base64"));
    const line = Buffer.concat(bytes).toString("utf8").split("\n")[0]!;
    const matched = /^EZH_PREVIEW_PROCESS ([1-9][0-9]{0,9}) ([0-9]{1,24})$/.exec(line);
    if (matched) return [Number(matched[1]), matched[2]!];
    if (value.eof === true) throw new Error("Preview server exited before discovery");
    await Bun.sleep(100);
  }
  throw new Error("Preview launch identity exceeded its deadline");
}

async function cancelServerProcess(call: GuestCall, process: { processId: string; bootId: string }): Promise<void> {
  const cleanup = AbortSignal.timeout(30_000);
  if (object(await call("process.cancel", process, cleanup)).ok !== true) throw new Error("Preview process cancellation is unconfirmed");
  for (let attempt = 0; attempt < 16; attempt++) {
    cleanup.throwIfAborted();
    const reply = object(await call("process.inspect", process, cleanup));
    const state = object(reply.process).state;
    if (["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(String(state))) return;
    await Bun.sleep(100);
  }
  throw new Error("Preview process cancellation is unconfirmed");
}

async function discoverServerPort(call: GuestCall, identity: [number, string],
  request: SandboxPreviewServerRequest, signal: AbortSignal, now: () => number): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    signal.throwIfAborted();
    const probe = await startGuest(call, JSON.stringify(identity), now(),
      { code: SERVER_PORTS, name: "EZH_PREVIEW_PROCESS", lifetime: 5_000 });
    try {
      await awaitGuest(call, probe.processId, probe.bootId, signal);
      const ports: unknown = JSON.parse((await readGuestOutput(call, request, probe.processId, probe.bootId)).toString("utf8"));
      if (!Array.isArray(ports) || ports.length > 1) throw new Error("Preview server listener is ambiguous");
      if (ports.length === 1) return positivePort(ports[0]);
    } finally { await cancelServerProcess(call, probe); }
    await Bun.sleep(250);
  }
  throw new Error("Preview server did not start listening");
}

function browserResponse(output: Buffer, method: string): Response {
  const value = object(JSON.parse(output.toString("utf8")));
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
  const noBody = method === "HEAD" || [204, 205, 304].includes(value.status as number);
  return new Response(noBody ? null : bytes, { status: value.status as number, headers: responseHeaders });
}

/** Bounded HTTP relay over the already approved guest process channel.
 * WebSocket upgrades stay closed until a separately qualified streaming relay exists. */
export class IncusSandboxPreviewBackend implements SandboxPreviewBackend {
  constructor(private readonly caller: ProviderSandboxWorkspaceCaller, private readonly now: () => number = Date.now,
    private readonly connectDuplex?: (request: SandboxPreviewConnectRequest) => Promise<SandboxPreviewSocket>) {}

  async startServer(request: SandboxPreviewServerRequest): Promise<SandboxPreviewServer> {
    if (!request.userId || !request.conversationId || !request.argv.length
      || request.argv.length > 128 || request.argv.some(arg => !arg || arg.length > 8192 || arg.includes("\0"))) {
      throw new Error("Sandbox preview launch is unavailable");
    }
    const signal = AbortSignal.any([AbortSignal.timeout(SERVER_READY_MS), ...(request.signal ? [request.signal] : [])]);
    signal.throwIfAborted();
    const call = guestCaller(this.caller, { ...request, previewId: `server-${randomUUID()}`, signal });
    const launchedAt = this.now();
    const started = await startGuest(call, JSON.stringify(request.argv), launchedAt,
      { code: SERVER_LAUNCH, name: "EZH_PREVIEW_ARGV", lifetime: SERVER_LIFETIME_MS });
    try {
      const identity = await serverIdentity(call, started.processId, started.bootId, request.binding, signal);
      const port = await discoverServerPort(call, identity, request, signal, this.now);
      signal.throwIfAborted();
      return { ...started, port, expiresAt: launchedAt + SERVER_LIFETIME_MS };
    } catch (error) {
      await cancelServerProcess(call, started);
      throw error;
    }
  }

  async stopServer(request: SandboxPreviewServerRequest & { server: SandboxPreviewServer }): Promise<void> {
    const call = guestCaller(this.caller, { ...request, previewId: `server-stop-${randomUUID()}` });
    await cancelServerProcess(call, { processId: request.server.processId, bootId: request.server.bootId });
  }

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
    const payload = await guestPayload(request, this.now());
    const call = guestCaller(this.caller, request);
    const { processId, bootId } = await startGuest(call, payload, this.now());
    await awaitGuest(call, processId, bootId, request.request.signal);
    return browserResponse(await readGuestOutput(call, request, processId, bootId), request.request.method);
  }

  async connectWebSocket(request: SandboxPreviewConnectRequest): Promise<SandboxPreviewSocket> {
    if (!this.connectDuplex || !request.userId || !request.previewId || request.signal.aborted) {
      throw new Error("Sandbox preview WebSocket is unavailable");
    }
    positivePort(request.targetPort);
    boundedPath(request.requestPath, request.search);
    if (request.expiresAt.getTime() <= this.now() || request.expiresAt.getTime() > this.now() + 24 * 60 * 60 * 1000) {
      throw new Error("Invalid sandbox preview expiry");
    }
    if (request.subprotocol !== null && request.subprotocol !== "vite-hmr" && request.subprotocol !== "vite-ping") {
      throw new Error("Invalid sandbox preview WebSocket protocol");
    }
    const duplex = await this.connectDuplex(request);
    if (duplex.protocol !== request.subprotocol) {
      await duplex.close();
      throw new Error("Sandbox preview WebSocket protocol changed");
    }
    return duplex;
  }
}
