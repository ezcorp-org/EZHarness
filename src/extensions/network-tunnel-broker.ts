import { connect, isIP, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { decodeTunnelChunk, parseTcpDestination, TUNNEL_CHUNK_BYTES, TUNNEL_MAX_BYTES, TUNNEL_MAX_LIFETIME_MS } from "@ezcorp/extension-contract";
import { isBlockedIp, parseIpv4, type ResolveHost } from "../search/egress";
import { resolveReverseRpcMeta } from "./tool-executor/provenance";
import type { RpcHandlerDeps } from "./tool-executor/rpc-handlers";
import type { JsonRpcRequest, JsonRpcResponse } from "./types";

interface Tunnel {
  socket: Socket;
  token: string;
  extensionId: string;
  destination: string;
  deadline: number;
  bytes: number;
  readSequence: number;
  writeSequence: number;
  reading: boolean;
  writing: boolean;
  failed: boolean;
  ended: boolean;
  checking: boolean;
  timer: ReturnType<typeof setInterval>;
  authorize: () => Promise<void>;
}

const tunnels = new Map<string, Tunnel>();
const pending = new Map<string, number>();

function closeTunnel(id: string): void {
  const tunnel = tunnels.get(id);
  if (!tunnel) return;
  clearInterval(tunnel.timer);
  tunnel.socket.destroy();
  tunnels.delete(id);
}

export function closeNetworkTunnels(): void { for (const id of tunnels.keys()) closeTunnel(id); }

function internalDestination(destination: string, host: string): boolean {
  const configured: unknown = JSON.parse(process.env.EZCORP_EXTENSION_TCP_INTERNAL_DESTINATIONS ?? "[]");
  if (!Array.isArray(configured) || configured.length > 32) throw new Error("Invalid private TCP configuration");
  for (const value of configured) {
    const target = parseTcpDestination(value);
    const address = parseIpv4(target.host);
    const privateAddress = address ? address[0] === 127 || address[0] === 10 || address[0] === 192 && address[1] === 168 || address[0] === 172 && address[1]! >= 16 && address[1]! <= 31 : target.host === "::1" || /^(fc|fd)[0-9a-f:]+$/.test(target.host);
    if (!isIP(target.host) || !privateAddress) throw new Error("Private TCP exceptions require exact private IP destinations");
  }
  return isIP(host) !== 0 && configured.includes(destination);
}

export async function handleNetworkTunnel(deps: RpcHandlerDeps, extensionId: string, request: JsonRpcRequest, options: { resolveHost?: ResolveHost } = {}): Promise<JsonRpcResponse> {
  let ownedId: string | undefined;
  let writeStarted = false;
  try {
    const resolved = resolveReverseRpcMeta(extensionId, request);
    if (!resolved.ok) return resolved.errorResponse;
    const input = request.params as Record<string, unknown>;
    const token = (input?._meta as Record<string, unknown> | undefined)?.ezCallId;
    if (typeof token !== "string") throw new Error("Missing invocation");
    const authorize = async (destination: string) => {
      if (!resolveReverseRpcMeta(extensionId, request).ok) throw new Error("Invocation expired");
      const manifest = deps.registry.getManifest(extensionId);
      const declared = (manifest?.permissions as { networkTcp?: string[] } | undefined)?.networkTcp;
      const granted = deps.registry.getGrantedPermissions(extensionId)?.networkTcp;
      if (!declared?.includes(destination) || !granted?.includes(destination)) throw new Error("TCP destination was not declared and approved");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const decision = await Promise.race([
        deps.engine.authorize({ extensionId, userId: resolved.onBehalfOf, conversationId: resolved.conversationId, toolName: "network.tunnel" }, [{ kind: "network.tcp", value: destination }]),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("TCP authorization deadline exceeded")), 5000); }),
      ]).finally(() => clearTimeout(timer));
      if (decision.decision !== "allow") throw new Error("TCP policy denied");
      if (!resolveReverseRpcMeta(extensionId, request).ok) throw new Error("Invocation expired");
    };
    if (request.method === "ezcorp/network.tunnel.open") {
      const { host, port, destination } = parseTcpDestination(input.destination);
      await authorize(destination);
      if (tunnels.size + [...pending.values()].reduce((sum, count) => sum + count, 0) >= 32 || [...tunnels.values()].filter(tunnel => tunnel.token === token).length + (pending.get(token) ?? 0) >= 4) throw new Error("TCP capacity exceeded");
      pending.set(token, (pending.get(token) ?? 0) + 1);
      let socket: Socket | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const allowedPrivate = internalDestination(destination, host);
        const resolver = options.resolveHost ?? (async name => (await lookup(name, { all: true })).map(address => address.address));
        const resolution = isIP(host) ? Promise.resolve([host]) : resolver(host);
        const addresses = await Promise.race([resolution, new Promise<never>((_resolve, reject) => { deadlineTimer = setTimeout(() => reject(new Error("TCP DNS deadline exceeded")), 10_000); })]);
        clearTimeout(deadlineTimer);
        if (!addresses.length || addresses.length > 32 || addresses.some(address => !isIP(address) || !allowedPrivate && isBlockedIp(address))) throw new Error("TCP address denied");
        await authorize(destination);
        socket = connect({ host: addresses[0]!, port });
        if (socket.readableHighWaterMark > TUNNEL_CHUNK_BYTES) throw new Error("TCP buffer limit is not enforced");
        socket.on("readable", () => socket!.pause());
        socket.pause();
        await new Promise<void>((resolve, reject) => {
          deadlineTimer = setTimeout(() => reject(new Error("TCP connect deadline exceeded")), 10_000);
          socket!.once("connect", resolve);
          socket!.once("error", reject);
        });
        clearTimeout(deadlineTimer);
        await authorize(destination);
        const id = crypto.randomUUID();
        const tunnel = { socket, token, extensionId, destination, deadline: Date.now() + TUNNEL_MAX_LIFETIME_MS, bytes: 0, readSequence: 0, writeSequence: 0, reading: false, writing: false, failed: false, ended: false, checking: false, authorize: () => authorize(destination) } as Tunnel;
        tunnel.timer = setInterval(() => {
          if (Date.now() >= tunnel.deadline) { closeTunnel(id); return; }
          if (tunnel.checking) return;
          tunnel.checking = true;
          void tunnel.authorize().then(() => { if (Date.now() >= tunnel.deadline) closeTunnel(id); }, () => closeTunnel(id)).finally(() => { tunnel.checking = false; });
        }, 250);
        tunnel.timer.unref();
        socket.on("error", () => { tunnel.failed = true; closeTunnel(id); });
        socket.on("end", () => { tunnel.ended = true; });
        socket.on("close", () => { tunnel.ended = true; });
        tunnels.set(id, tunnel);
        return { jsonrpc: "2.0", id: request.id, result: { tunnelId: id } };
      } catch (cause) { socket?.destroy(); throw cause; }
      finally {
        clearTimeout(deadlineTimer);
        const count = (pending.get(token) ?? 1) - 1;
        if (count) pending.set(token, count); else pending.delete(token);
      }
    }
    const tunnel = typeof input.tunnelId === "string" ? tunnels.get(input.tunnelId) : undefined;
    if (!tunnel || tunnel.token !== token || tunnel.extensionId !== extensionId) throw new Error("TCP handle unavailable");
    ownedId = input.tunnelId as string;
    await tunnel.authorize();
    if (Date.now() >= tunnel.deadline || tunnel.failed) throw new Error("TCP connection expired");
    if (request.method === "ezcorp/network.tunnel.close") {
      closeTunnel(ownedId);
      return { jsonrpc: "2.0", id: request.id, result: { closed: true } };
    }
    if (request.method === "ezcorp/network.tunnel.write") {
      if (input.sequence !== tunnel.writeSequence || tunnel.writing) throw new Error("TCP write sequence invalid");
      const bytes = decodeTunnelChunk(input.data);
      if (!bytes.length || tunnel.bytes + bytes.length > TUNNEL_MAX_BYTES) throw new Error("TCP byte budget exceeded");
      tunnel.writing = true;
      tunnel.bytes += bytes.length;
      writeStarted = true;
      try { await new Promise<void>((resolve, reject) => tunnel.socket.write(bytes, error => error ? reject(error) : resolve())); }
      finally { tunnel.writing = false; }
      await tunnel.authorize();
      tunnel.writeSequence++;
      return { jsonrpc: "2.0", id: request.id, result: { sequence: input.sequence } };
    }
    if (request.method !== "ezcorp/network.tunnel.read" || input.sequence !== tunnel.readSequence || tunnel.reading) throw new Error("TCP read sequence invalid");
    tunnel.reading = true;
    try {
      const deadline = Math.min(tunnel.deadline, Date.now() + 1000);
      if (!tunnel.socket.readableLength && !tunnel.ended && !tunnel.socket.destroyed) {
        await new Promise<void>(resolve => {
          const ready = () => {
            clearTimeout(timer);
            tunnel.socket.off("readable", ready);
            tunnel.socket.off("close", ready);
            resolve();
          };
          const timer = setTimeout(ready, Math.max(0, deadline - Date.now()));
          tunnel.socket.once("readable", ready);
          tunnel.socket.once("close", ready);
        });
      }
      await tunnel.authorize();
      if (!tunnels.has(ownedId) || tunnel.failed) throw new Error("TCP connection expired");
      const bytes: Buffer = tunnel.socket.read(Math.min(tunnel.socket.readableLength, TUNNEL_CHUNK_BYTES)) ?? Buffer.alloc(0);
      tunnel.bytes += bytes.length;
      if (tunnel.bytes > TUNNEL_MAX_BYTES) throw new Error("TCP byte budget exceeded");
      const eof = tunnel.ended && !tunnel.socket.readableLength;
      const sequence = tunnel.readSequence++;
      if (eof) closeTunnel(ownedId);
      return { jsonrpc: "2.0", id: request.id, result: { data: bytes.toString("base64"), eof, sequence } };
    } finally { tunnel.reading = false; }
  } catch {
    if (ownedId) closeTunnel(ownedId);
    return { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: writeStarted ? "outcome_unknown: TCP bytes may have reached the destination. Do not retry." : "TCP tunnel denied, expired, or unavailable.", data: { retryable: false } } };
  }
}
