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
  const missingChild = structuredClone(nestedLock);
  delete missingChild.packages["node_modules/is-odd/node_modules/is-number"];
  await expect(fetchLockedDependencies({ ...nested, "package-lock.json": JSON.stringify(missingChild) })).rejects.toThrow("missing");
  const hiddenDependency = structuredClone(nestedLock);
  delete hiddenDependency.packages["node_modules/is-odd"].dependencies;
  await expect(fetchLockedDependencies({ ...nested, "package-lock.json": JSON.stringify(hiddenDependency) })).rejects.toThrow("declarations differ");
  const shared = await resolveDependencies({ "package.json": JSON.stringify({ dependencies: { "is-number": "6.0.0", "is-odd": "3.0.1" } }) });
  expect(JSON.parse(workspaceText(shared["package-lock.json"], "package-lock.json")).packages["node_modules/is-odd/node_modules/is-number"]).toBeUndefined();
  const reversed = await resolveDependencies({ "package.json": JSON.stringify({ dependencies: { "is-odd": "3.0.1", "is-number": "6.0.0" } }) });
  expect(JSON.parse(workspaceText(reversed["package-lock.json"], "package-lock.json")).packages["node_modules/is-odd/node_modules/is-number"]).toBeUndefined();
}, 60_000);

test("resolver applies exact global and parent-scoped overrides and rejects a stale lock", async () => {
  const originalFetch = globalThis.fetch;
  const metadata: Record<string, unknown> = {
    "fixture-parent-a": { versions: { "1.0.0": { dependencies: { "fixture-child": "^8.0.0" }, dist: { integrity: `sha512-${"A".repeat(86)}==`, tarball: "https://registry.npmjs.org/fixture-parent-a/-/fixture-parent-a-1.0.0.tgz" } } } },
    "fixture-parent-b": { versions: { "1.0.0": { dependencies: { "fixture-child": "^8.0.0" }, dist: { integrity: `sha512-${"A".repeat(86)}==`, tarball: "https://registry.npmjs.org/fixture-parent-b/-/fixture-parent-b-1.0.0.tgz" } } } },
    "fixture-child": { versions: Object.fromEntries(["8.3.2", "11.1.1", "12.0.1"].map(version => [version, { dist: { integrity: `sha512-${"A".repeat(86)}==`, tarball: `https://registry.npmjs.org/fixture-child/-/fixture-child-${version}.tgz` } }])) },
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const name = decodeURIComponent(new URL(String(input)).pathname.slice(1));
    return new Response(JSON.stringify(metadata[name]), { status: metadata[name] ? 200 : 404 });
  }) as typeof fetch;
  try {
    const manifest = { dependencies: { "fixture-parent-a": "1.0.0", "fixture-parent-b": "1.0.0" }, overrides: { "fixture-child": "12.0.1", "fixture-parent-a": { "fixture-child": "11.1.1" } } };
    const files = { "package.json": JSON.stringify(manifest) };
    const frozen = await resolveDependencies(files);
    const lock = JSON.parse(workspaceText(frozen["package-lock.json"], "package-lock.json"));
    expect(lock.packages["node_modules/fixture-parent-a/node_modules/fixture-child"].version).toBe("11.1.1");
    expect(lock.packages["node_modules/fixture-parent-b/node_modules/fixture-child"].version).toBe("12.0.1");
    lock.packages["node_modules/fixture-parent-a/node_modules/fixture-child"].version = "8.3.2";
    await expect(fetchLockedDependencies({ ...frozen, "package-lock.json": JSON.stringify(lock) })).rejects.toThrow("override");
    await expect(fetchLockedDependencies({ ...frozen, "package.json": JSON.stringify({ ...manifest, overrides: { "fixture-child": "11.1.1" } }) })).rejects.toThrow("override");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolver rejects unsupported, unpinned, and direct-conflicting override forms", async () => {
  const dependencies = { "fixture-parent": "1.0.0" };
  for (const overrides of [
    null, [], { "fixture-parent@1.0.0": { "fixture-child": "11.1.1" } },
    { "@ezcorp/sdk": "11.1.1" }, { "fixture-child": "^11" },
    { "fixture-parent": "2.0.0" }, { "fixture-parent": null },
    { "fixture-parent": [] }, { "fixture-parent": {} },
    { "fixture-parent": { "@ezcorp/sdk": "11.1.1" } },
    { "fixture-parent": { "fixture-child": "^11" } },
    { "fixture-parent": { "fixture-child": 11 } },
    { "fixture-parent": 11 },
  ]) {
    await expect(resolveDependencies({ "package.json": JSON.stringify({ dependencies, overrides }) })).rejects.toThrow(/[Oo]verride/);
  }
});

test("locked command packages preserve only declared executable paths", async () => {
  const frozen = await resolveDependencies({ "package.json": JSON.stringify({ dependencies: { acorn: "8.14.1" } }) });
  const closure = await fetchLockedDependencies(frozen);
  expect(closure.executable).toEqual(["node_modules/acorn/bin/acorn"]);
  expect(closure.binary["node_modules/acorn/bin/acorn"]).toBeDefined();
}, 60_000);
