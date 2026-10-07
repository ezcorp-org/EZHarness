import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";
import { INCUS_MEMORY_STRESS_BYTES, INCUS_MEMORY_STRESS_SHA256, loadIncusMemoryStressAsset,
  readIncusMemoryStressAssetReference } from "./incus-memory-stress-asset";
const binary = new URL("./incus-guest/memory-stress.x86_64.bin", import.meta.url);
const read = () => Bun.file(binary).arrayBuffer();

test("the real pinned static workload fits the unchanged transfer bound", async () => {
  const asset = await loadIncusMemoryStressAsset("amd64");
  expect(asset.bytes.length).toBe(INCUS_MEMORY_STRESS_BYTES);
  expect(asset.sha256).toBe(INCUS_MEMORY_STRESS_SHA256);
});
test("source path and production inline URL decode the same pinned workload", async () => {
  const source = await read();
  const inlined = `data:application/octet-stream;base64,${Buffer.from(source).toString("base64")}`;
  const decoded = await readIncusMemoryStressAssetReference(inlined);
  expect(Buffer.from(decoded)).toEqual(Buffer.from(source));
  expect((await loadIncusMemoryStressAsset("amd64", () => readIncusMemoryStressAssetReference(inlined))).sha256)
    .toBe(INCUS_MEMORY_STRESS_SHA256);
});
test("unknown architecture refuses before reading an artifact", async () => {
  let reads = 0;
  await expect(loadIncusMemoryStressAsset("arm64", async () => { reads++; return read(); }))
    .rejects.toThrow("architecture");
  expect(reads).toBe(0);
});
test("a missing or changed-sized artifact cannot be staged", async () => {
  await expect(loadIncusMemoryStressAsset("amd64", async () => { throw new Error("missing artifact"); }))
    .rejects.toThrow("missing artifact");
  for (const size of [0, INCUS_MEMORY_STRESS_BYTES - 1, 64 * 1024 + 1]) {
    await expect(loadIncusMemoryStressAsset("amd64", async () => new ArrayBuffer(size))).rejects.toThrow("size");
  }
});
test("ELF identity, architecture and program-header bounds fail closed", async () => {
  for (const index of [0, 1, 2, 3, 4, 5, 6, 16, 18, 20, 54]) {
    const bytes = new Uint8Array(await read()); bytes[index] = 0;
    await expect(loadIncusMemoryStressAsset("amd64", async () => bytes.buffer)).rejects.toThrow("executable");
  }
  for (const value of [0, 129]) {
    const buffer = await read(); new DataView(buffer).setUint16(56, value, true);
    await expect(loadIncusMemoryStressAsset("amd64", async () => buffer)).rejects.toThrow("executable");
  }
  for (const value of [0n, BigInt(INCUS_MEMORY_STRESS_BYTES), 9_007_199_254_740_992n]) {
    const buffer = await read(); new DataView(buffer).setBigUint64(32, value, true);
    await expect(loadIncusMemoryStressAsset("amd64", async () => buffer)).rejects.toThrow("executable");
  }
});
test("a dynamic interpreter or a byte drift refuses the workload", async () => {
  const dynamic = await read(); const view = new DataView(dynamic);
  view.setUint32(Number(view.getBigUint64(32, true)), 3, true);
  await expect(loadIncusMemoryStressAsset("amd64", async () => dynamic)).rejects.toThrow("static");
  const drift = new Uint8Array(await read()); drift[drift.length - 1] ^= 1;
  await expect(loadIncusMemoryStressAsset("amd64", async () => drift.buffer)).rejects.toThrow("digest");
});


test("a fresh Bun consumer imports the real host witness and loads the pinned native asset", () => {
  const witness = new URL("./incus-host-live-witness.ts", import.meta.url).href;
  const loader = new URL("./incus-memory-stress-asset.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["-e", `await import(${JSON.stringify(witness)}); const m=await import(${JSON.stringify(loader)}); const a=await m.loadIncusMemoryStressAsset("amd64"); console.log(JSON.stringify({bytes:a.bytes.length,sha256:a.sha256}));`], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ bytes: INCUS_MEMORY_STRESS_BYTES, sha256: INCUS_MEMORY_STRESS_SHA256 });
});

test("the real Vite SSR asset build loads standalone through Bun without source binary access", async () => {
  const output = await mkdtemp(join(tmpdir(), "incus-native-asset-vite-"));
  try {
    const vite = new URL("../../web/node_modules/vite/dist/node/index.js", import.meta.url).href;
    const source = new URL("./incus-memory-stress-asset.ts", import.meta.url).pathname;
    const script = `import {build} from ${JSON.stringify(vite)}; await build({configFile:false,logLevel:"silent",build:{ssr:${JSON.stringify(source)},outDir:${JSON.stringify(output)},emptyOutDir:true,rollupOptions:{output:{entryFileNames:"asset.mjs"}}}});`;
    const built = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(built.stderr).toBe("");
    expect(built.status).toBe(0);
    const module = pathToFileURL(join(output, "asset.mjs")).href;
    const loaded = spawnSync(process.execPath, ["-e", `const m=await import(${JSON.stringify(module)}); const a=await m.loadIncusMemoryStressAsset("amd64"); console.log(JSON.stringify({bytes:a.bytes.length,sha256:a.sha256}));`], { cwd: output, encoding: "utf8" });
    expect(loaded.stderr).toBe("");
    expect(loaded.status).toBe(0);
    expect(JSON.parse(loaded.stdout)).toEqual({ bytes: INCUS_MEMORY_STRESS_BYTES, sha256: INCUS_MEMORY_STRESS_SHA256 });
    const emitted = await Bun.file(join(output, "asset.mjs")).text();
    expect(emitted).toContain("data:application/octet-stream;base64,");
    expect(emitted).not.toContain(binary.pathname);
  } finally { await rm(output, { recursive: true, force: true }); }
});
