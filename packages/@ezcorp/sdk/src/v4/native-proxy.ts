import { createServer } from "node:http";
import type { Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ContractError, decodeTunnelChunk, parseTcpDestination, TUNNEL_CHUNK_BYTES, TUNNEL_MAX_LIFETIME_MS } from "@ezcorp/extension-contract";
import type { ExtensionContext } from "./index";
import { brokeredFetch } from "./network";
import { withExtensionContext } from "./context";

const TRANSPORT_HEADERS = new Set(["host", "connection", "proxy-authorization", "proxy-authenticate", "proxy-connection", "content-length", "transfer-encoding", "upgrade", "te", "trailer", "keep-alive"]);

export async function startNativeProxy(context: ExtensionContext): Promise<{ environment: Record<string, string>; close: () => Promise<void> }> {
  context.signal.throwIfAborted();
  const credential = Buffer.from(`invocation:${randomBytes(32).toString("hex")}`).toString("base64");
  const expected = Buffer.from(`Basic ${credential}`);
  const sockets = new Set<Socket>();
  const handles = new Set<string>();
  let closed = false;
  let requests = 0;
  const authorized = (request: { headers: Record<string, string | string[] | undefined> }) => {
    const header = request.headers["proxy-authorization"];
    return !closed && !context.signal.aborted && Date.now() < context.invocation.deadline && typeof header === "string" && Buffer.byteLength(header) === expected.length && timingSafeEqual(Buffer.from(header), expected);
  };
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: TUNNEL_MAX_LIFETIME_MS }, async (request, response) => {
    if (!authorized(request)) { response.writeHead(407).end(); return; }
    if (++requests > 4) { requests--; response.writeHead(503).end(); return; }
    try {
      const target = new URL(request.url ?? "");
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.hash) throw new Error("Invalid proxy URL");
      const headers = new Headers();
      const connectionHeaders = new Set(String(request.headers.connection ?? "").toLowerCase().split(",").map(name => name.trim()));
      for (const [name, value] of Object.entries(request.headers)) if (!TRANSPORT_HEADERS.has(name) && !connectionHeaders.has(name) && value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 512 * 1024) throw new Error("Proxy body limit");
        chunks.push(bytes);
      }
      if (!authorized(request)) throw new Error("Invocation expired");
      const result = await withExtensionContext(context, () => brokeredFetch(target, { method: request.method, headers, ...(size ? { body: Buffer.concat(chunks) } : {}), signal: context.signal }));
      const outputHeaders: Record<string, string> = {};
      for (const [name, value] of result.headers) if (!TRANSPORT_HEADERS.has(name)) outputHeaders[name] = value;
      response.writeHead(result.status, outputHeaders);
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch { if (!response.headersSent) response.writeHead(502); response.end(); }
    finally { requests--; }
  });
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 1;
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connection", socket => {
    if (closed || sockets.size >= 8) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setTimeout(Math.max(1, Math.min(TUNNEL_MAX_LIFETIME_MS, context.invocation.deadline - Date.now())), () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, socket, head) => {
    socket.pause();
    let handle: string | undefined;
    let finished = false;
    let writeSequence = 0;
    const finish = async () => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (handle) {
        handles.delete(handle);
        await context.call("ezcorp/network.tunnel.close", { tunnelId: handle }).catch(() => undefined);
      }
    };
    const write = async (bytes: Uint8Array) => {
      for (let offset = 0; offset < bytes.length; offset += TUNNEL_CHUNK_BYTES) {
        context.signal.throwIfAborted();
        const sequence = writeSequence++;
        const result = await context.call("ezcorp/network.tunnel.write", { tunnelId: handle, sequence, data: Buffer.from(bytes.subarray(offset, offset + TUNNEL_CHUNK_BYTES)).toString("base64") }) as { sequence?: unknown };
        if (result?.sequence !== sequence) throw new ContractError("INVALID_TUNNEL_RESPONSE", "TCP write acknowledgement mismatch");
      }
    };
    socket.once("close", () => { void finish(); });
    socket.once("error", () => { void finish(); });
    void (async () => {
      if (!authorized(request) || handles.size >= 4) throw new Error("Proxy denied");
      const { destination } = parseTcpDestination(request.url);
      const result = await context.call("ezcorp/network.tunnel.open", { destination }) as { tunnelId?: unknown };
      if (typeof result?.tunnelId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.tunnelId)) throw new ContractError("INVALID_TUNNEL_RESPONSE", "Invalid TCP tunnel handle");
      handle = result.tunnelId;
      handles.add(handle);
      if (finished || !authorized(request)) { handles.delete(handle); await context.call("ezcorp/network.tunnel.close", { tunnelId: handle }); return; }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) await write(head);
      let pendingWrite = Promise.resolve();
      socket.on("data", bytes => {
        socket.pause();
        pendingWrite = pendingWrite.then(() => write(bytes)).then(() => { if (!finished) socket.resume(); });
        void pendingWrite.catch(finish);
      });
      socket.resume();
      for (let sequence = 0; !finished; sequence++) {
        context.signal.throwIfAborted();
        const chunk = await context.call("ezcorp/network.tunnel.read", { tunnelId: handle, sequence }) as { data?: unknown; eof?: unknown; sequence?: unknown };
        if (!chunk || chunk.sequence !== sequence || typeof chunk.eof !== "boolean") throw new ContractError("INVALID_TUNNEL_RESPONSE", "Invalid TCP read response");
        const bytes = decodeTunnelChunk(chunk.data);
        if (finished) break;
        if (bytes.length) await new Promise<void>((resolve, reject) => socket.write(bytes, error => error ? reject(error) : resolve()));
        if (chunk.eof) break;
      }
    })().then(finish, finish);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Native proxy failed to bind"); }
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    closed = true;
    context.signal.removeEventListener("abort", abort);
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await Promise.all([...handles].map(tunnelId => context.call("ezcorp/network.tunnel.close", { tunnelId }).catch(() => undefined)));
    handles.clear();
    await new Promise<void>(resolve => server.close(() => resolve()));
  })();
  const abort = () => { void close(); };
  const timer = setTimeout(abort, Math.max(1, Math.min(TUNNEL_MAX_LIFETIME_MS, context.invocation.deadline - Date.now())));
  timer.unref();
  context.signal.addEventListener("abort", abort, { once: true });
  if (context.signal.aborted) await close();
  const proxy = `http://${Buffer.from(credential, "base64").toString("utf8")}@127.0.0.1:${address.port}`;
  return { environment: { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, ALL_PROXY: "", all_proxy: "", NO_PROXY: "", no_proxy: "" }, close };
}
