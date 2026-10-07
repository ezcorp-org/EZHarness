import { createHash } from "node:crypto";

import build from "./incus-guest/memory-stress.build.json";

export const INCUS_MEMORY_STRESS_SHA256 = build.artifact.sha256;
export const INCUS_MEMORY_STRESS_BYTES = build.artifact.bytes;

export interface IncusMemoryStressAsset {
  bytes: Uint8Array;
  sha256: string;
}

/** This is one reviewed qualification workload, never an arbitrary executable. */
export async function loadIncusMemoryStressAsset(architecture: string,
  readAsset: () => Promise<ArrayBuffer> = () => Bun.file(new URL(
    "./incus-guest/memory-stress.x86_64.bin", import.meta.url)).arrayBuffer()): Promise<IncusMemoryStressAsset> {
  if (architecture !== "amd64") throw new Error("Incus native memory workload architecture is unavailable");
  const bytes = new Uint8Array(await readAsset());
  if (bytes.length !== INCUS_MEMORY_STRESS_BYTES || bytes.length > 64 * 1024) {
    throw new Error("Incus native memory workload size changed");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = Number(view.getBigUint64(32, true));
  const count = view.getUint16(56, true);
  if (bytes[0] !== 127 || bytes[1] !== 69 || bytes[2] !== 76 || bytes[3] !== 70
    || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1 || view.getUint16(16, true) !== 2
    || view.getUint16(18, true) !== 62 || view.getUint32(20, true) !== 1
    || view.getUint16(54, true) !== 56 || count === 0 || count > 128
    || !Number.isSafeInteger(offset) || offset < 64 || offset + count * 56 > bytes.length) {
    throw new Error("Incus native memory workload executable changed");
  }
  for (let index = 0; index < count; index++) {
    if (view.getUint32(offset + index * 56, true) === 3) {
      throw new Error("Incus native memory workload must be static");
    }
  }
  if (createHash("sha256").update(bytes).digest("hex") !== INCUS_MEMORY_STRESS_SHA256) {
    throw new Error("Incus native memory workload digest changed");
  }
  return { bytes, sha256: INCUS_MEMORY_STRESS_SHA256 };
}
