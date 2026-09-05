import { expect, test } from "bun:test";
import { decodeTunnelChunk, parseTcpDestination, TUNNEL_CHUNK_BYTES } from "./network";
import { validateManifest } from "./validation";

test("TCP destinations are canonical exact endpoints, never URLs or host globs", () => {
  expect(parseTcpDestination("example.com:443")).toEqual({ host: "example.com", port: 443, destination: "example.com:443" });
  expect(parseTcpDestination("[::1]:8443").host).toBe("::1");
  for (const value of [null, 42, "", "*.example.com:443", "https://example.com", "example.com:0", "example.com:65536", "example.com:0443", "EXAMPLE.com:443", "example.com.:443", "127.1:443", "-host:443", "a".repeat(64) + ":443", "[0:0::1]:443", "[bad:bad]:443", "a".repeat(261)]) expect(() => parseTcpDestination(value)).toThrow();
});

test("tunnel frames use canonical bounded base64", () => {
  expect(decodeTunnelChunk("")).toEqual(new Uint8Array());
  const bytes = Buffer.alloc(TUNNEL_CHUNK_BYTES, 255);
  expect(Buffer.from(decodeTunnelChunk(bytes.toString("base64")))).toEqual(bytes);
  for (const value of [null, "!", "Zg", "Zh==", "Zg==\n", Buffer.alloc(TUNNEL_CHUNK_BYTES + 1).toString("base64"), "A".repeat(100_000)]) expect(() => decodeTunnelChunk(value)).toThrow();
});

test("manifest TCP and raw credential grants have closed, distinct validation", () => {
  const manifest = { schemaVersion: 4, name: "network-test", version: "1.0.0", description: "Network test", author: { name: "tests" }, permissions: {} };
  expect(validateManifest({ ...manifest, permissions: { networkTcp: ["example.com:443"], secretRead: ["GITHUB_TOKEN"] } }).permissions.secretRead).toEqual(["GITHUB_TOKEN"]);
  for (const permissions of [{ networkTcp: ["example.com:443", "example.com:443"] }, { networkTcp: Array.from({ length: 33 }, (_value, index) => `host${index}:443`) }, { networkTcp: ["*.example.com:443"] }, { secretRead: ["DATABASE_URL"] }, { secretRead: ["GITHUB_TOKEN", "GITHUB_TOKEN"] }, { secretRead: true }]) expect(() => validateManifest({ ...manifest, permissions })).toThrow();
});
