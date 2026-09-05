import { workspaceText } from "@ezcorp/extension-contract";
import { expect, test } from "bun:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { extractPackage, fetchLockedDependencies, resolveDependencies } from "../src/dependencies";

function archive(name: string, type = "0"): Uint8Array {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write("00000000001\0", 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0");
  header.write(`${checksum}\0 `, 148);
  return gzipSync(Buffer.concat([header, Buffer.from("x"), Buffer.alloc(511 + 1024)]));
}

test("tar extraction rejects traversal, absolute paths, symlinks and devices", () => {
  expect(new TextDecoder().decode(extractPackage(archive("package/file.txt"))["file.txt"])).toBe("x");
  expect(new TextDecoder().decode(extractPackage(archive("./node v14.18/file.txt"))["file.txt"])).toBe("x");
  expect(extractPackage(archive("node v14.18/", "5"))).toEqual({});
  const mixedRoots = gzipSync(Buffer.concat([gunzipSync(archive("first/file")).subarray(0, 1024), gunzipSync(archive("second/file"))]));
  expect(() => extractPackage(mixedRoots)).toThrow("one package root");
  for (const name of ["./../escape/file", "./package/../escape", "file-without-root", "./package//file"]) expect(() => extractPackage(archive(name))).toThrow();
  for (const [name, type] of [["package/../../host", "0"], ["/host", "0"], ["package/link", "2"], ["package/device", "3"]]) expect(() => extractPackage(archive(name!, type))).toThrow();
  expect(() => extractPackage(gzipSync(Buffer.alloc(512, 1)))).toThrow("checksum");
});

test("locked npm closure is resolved before build and verified by SHA-512", async () => {
  const files = { "package.json": JSON.stringify({ dependencies: { "is-number": "7.0.0" } }) };
  await expect(fetchLockedDependencies(files)).rejects.toThrow("workspace revision");
  const frozen = await resolveDependencies(files);
  const closure = await fetchLockedDependencies(frozen);
  expect(closure.binary["node_modules/is-number/index.js"]).toBeDefined();
  const lock = JSON.parse(workspaceText(frozen["package-lock.json"], "package-lock.json"));
  lock.packages["node_modules/is-number"].integrity = `sha512-${"A".repeat(86)}==`;
  await expect(fetchLockedDependencies({ ...frozen, "package-lock.json": JSON.stringify(lock) })).rejects.toThrow("integrity mismatch");
  lock.packages["node_modules/is-number"].resolved = "http://169.254.169.254/package.tgz";
  await expect(fetchLockedDependencies({ ...frozen, "package-lock.json": JSON.stringify(lock) })).rejects.toThrow("approved npm registry");
  await expect(fetchLockedDependencies({ ...frozen, "package.json": JSON.stringify({ dependencies: { "is-number": "6.0.0" } }) })).rejects.toThrow("differ");
  await expect(resolveDependencies({ "package.json": JSON.stringify({ dependencies: { "is-number": "^7" } }) })).rejects.toThrow("exact versions");
}, 60_000);

test("resolver locks transitive ranges and reuses matching ancestor packages", async () => {
  const nested = await resolveDependencies({ "package.json": JSON.stringify({ dependencies: { "is-odd": "3.0.1" } }) });
  const nestedLock = JSON.parse(workspaceText(nested["package-lock.json"], "package-lock.json"));
  expect(nestedLock.packages["node_modules/is-odd/node_modules/is-number"].version).toBe("6.0.0");
  const shared = await resolveDependencies({ "package.json": JSON.stringify({ dependencies: { "is-number": "6.0.0", "is-odd": "3.0.1" } }) });
  expect(JSON.parse(workspaceText(shared["package-lock.json"], "package-lock.json")).packages["node_modules/is-odd/node_modules/is-number"]).toBeUndefined();
  const reversed = await resolveDependencies({ "package.json": JSON.stringify({ dependencies: { "is-odd": "3.0.1", "is-number": "6.0.0" } }) });
  expect(JSON.parse(workspaceText(reversed["package-lock.json"], "package-lock.json")).packages["node_modules/is-odd/node_modules/is-number"]).toBeUndefined();
}, 60_000);

test("locked command packages preserve only declared executable paths", async () => {
  const frozen = await resolveDependencies({ "package.json": JSON.stringify({ dependencies: { acorn: "8.14.1" } }) });
  const closure = await fetchLockedDependencies(frozen);
  expect(closure.executable).toEqual(["node_modules/acorn/bin/acorn"]);
  expect(closure.binary["node_modules/acorn/bin/acorn"]).toBeDefined();
}, 60_000);
