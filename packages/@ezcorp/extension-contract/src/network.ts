import { ContractError } from "./json";

export const TUNNEL_CHUNK_BYTES = 64 * 1024;
export const TUNNEL_MAX_BYTES = 32 * 1024 * 1024;
export const TUNNEL_MAX_LIFETIME_MS = 60_000;

export function parseTcpDestination(value: unknown): { host: string; port: number; destination: string } {
  if (typeof value !== "string" || value.length > 260) throw new ContractError("INVALID_DESTINATION", "Use an exact lowercase host:port TCP destination");
  const match = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+):([1-9][0-9]{0,4})$/.exec(value);
  if (!match) throw new ContractError("INVALID_DESTINATION", "Use an exact lowercase host:port TCP destination");
  const host = match[1]!;
  const port = Number(match[2]);
  if (port > 65535 || (!host.startsWith("[") && host.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) throw new ContractError("INVALID_DESTINATION", "Invalid TCP hostname or port");
  try { if (new URL(`http://${host}`).hostname !== host) throw new Error("Noncanonical host"); }
  catch { throw new ContractError("INVALID_DESTINATION", "Use a canonical TCP hostname or IP address"); }
  return { host: host.replace(/^\[|\]$/g, ""), port, destination: value };
}

export function decodeTunnelChunk(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(TUNNEL_CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ContractError("INVALID_TUNNEL_CHUNK", "Use bounded canonical base64 chunks");
  const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  if (bytes.byteLength > TUNNEL_CHUNK_BYTES || btoa(String.fromCharCode(...bytes)) !== value) throw new ContractError("INVALID_TUNNEL_CHUNK", "Use bounded canonical base64 chunks");
  return bytes;
}
