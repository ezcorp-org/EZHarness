import { chmod, mkdir, mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { GUEST_MATERIALS_PATH } from "@ezcorp/extension-runner";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import {
  FACTORY_MATERIAL_LIMITS,
  factoryMaterialDigest,
  type FactoryAttemptMaterials,
  type FactoryMaterialIdentity,
  type FactoryMaterialRecord,
  type FactoryMaterialScope,
  type FactoryScopedArtifactReader,
} from "../artifact-materials";
import { digestBytes } from "../../extensions/v4/blobs";

/**
 * The two byte paths this pack needs, and nothing else.
 *
 * W04 owns durable material bytes and the runner owns the guest, but nothing
 * joins them: a Podman guest has `--network=none`, so the execution gateway's
 * material routes are unreachable from inside one, and the control channel is
 * bounded at one mebibyte for the guest's WHOLE life. This module is that
 * join. It stages a sealed material into the per-attempt directory the runner
 * bind-mounts, and it seals what the guest left there back into W04.
 *
 * It stores nothing itself. Every durable write goes through
 * `FactoryAttemptMaterials` and every durable read through the scoped reader,
 * so there is no second copy of chunking, digesting, admission, or authority.
 */

/** Where the guest's inputs are staged. Read-only in practice; the guest is never asked to write here. */
export const REFERENCE_DATA_GUEST_INPUT = "in";
/** Where the guest leaves its outputs. */
export const REFERENCE_DATA_GUEST_OUTPUT = "out";

export class ReferenceDataMaterialError extends Error {
  constructor(
    readonly code:
      | "reference_data_material_absent"
      | "reference_data_material_digest_mismatch"
      | "reference_data_material_empty"
      | "reference_data_material_oversized"
      | "reference_data_material_name_invalid"
      | "reference_data_material_unsealed",
    message: string,
  ) {
    super(message);
    this.name = "ReferenceDataMaterialError";
  }
}

/**
 * The per-attempt directory the runner mounts at `/materials`.
 *
 * The output directory is group- and world-writable because a guest runs as
 * uid 65534 inside its own user namespace and the host cannot know which
 * subordinate uid that maps to. The directory itself lives inside a private
 * `mkdtemp` root, so nothing outside this attempt can reach it, and the host
 * still owns it, which is what lets the host delete what the guest wrote.
 */
export class ReferenceDataGuestDirectory {
  private constructor(readonly root: string) {}

  static async create(parent?: string): Promise<ReferenceDataGuestDirectory> {
    const root = await mkdtemp(join(parent ?? "/tmp", "ez-refdata-materials-"));
    await mkdir(join(root, REFERENCE_DATA_GUEST_INPUT), { recursive: true });
    await mkdir(join(root, REFERENCE_DATA_GUEST_OUTPUT), { recursive: true });
    await chmod(root, 0o755);
    await chmod(join(root, REFERENCE_DATA_GUEST_INPUT), 0o755);
    await chmod(join(root, REFERENCE_DATA_GUEST_OUTPUT), 0o777);
    return new ReferenceDataGuestDirectory(root);
  }

  /** The name the guest sees for a staged input. */
  static input(name: string): string {
    return `${REFERENCE_DATA_GUEST_INPUT}/${name}`;
  }

  /** The name the guest sees for an output it must write. */
  static output(name: string): string {
    return `${REFERENCE_DATA_GUEST_OUTPUT}/${name}`;
  }

  /** The path the guest reads, which is the same fixed mount point the runner declares. */
  static guestPath(name: string): string {
    return `${GUEST_MATERIALS_PATH}/${name}`;
  }

  private resolve(name: string): string {
    if (!/^(?:in|out)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new ReferenceDataMaterialError("reference_data_material_name_invalid", `Material name ${name} is not a bounded entry of the attempt directory.`);
    return join(this.root, name);
  }

  /** Writes one staged input, in bounded blocks, and reports its digest and size. */
  async stage(name: string, source: AsyncIterable<Uint8Array>): Promise<{ readonly digest: string; readonly totalBytes: number }> {
    const path = this.resolve(name);
    const handle = await open(path, "wx", 0o644);
    const hasher = new Bun.CryptoHasher("sha256");
    let totalBytes = 0;
    try {
      for await (const block of source) {
        hasher.update(block);
        totalBytes += block.byteLength;
        await handle.write(block);
      }
    } finally {
      await handle.close();
    }
    // `open`'s mode is masked by the process umask, and a host running under
    // 077 would leave this 0600 - unreadable by the guest's uid, which is a
    // different user in a different namespace. The mode is set, not requested.
    await chmod(path, 0o644);
    return { digest: `sha256:${hasher.digest("hex")}`, totalBytes };
  }

  /** Streams one output the guest left, in chunks a material write can take directly. */
  async *collect(name: string, chunkBytes = FACTORY_MATERIAL_LIMITS.maxChunkBytes): AsyncGenerator<Uint8Array> {
    const path = this.resolve(name);
    let handle: Awaited<ReturnType<typeof open>>;
    // The name is resolved above, outside the open guard, for the same reason.
    try {
      handle = await open(path, "r");
    } catch {
      throw new ReferenceDataMaterialError("reference_data_material_absent", `The guest left no ${name}.`);
    }
    try {
      for (;;) {
        const buffer = new Uint8Array(chunkBytes);
        const read = await handle.read(buffer, 0, chunkBytes, null);
        if (read.bytesRead === 0) return;
        yield buffer.subarray(0, read.bytesRead);
      }
    } finally {
      await handle.close();
    }
  }

  /** Every entry the guest actually left, so an unexpected file is visible rather than ignored. */
  async produced(): Promise<readonly string[]> {
    return (await readdir(join(this.root, REFERENCE_DATA_GUEST_OUTPUT))).sort();
  }

  async size(name: string): Promise<number> {
    // The name is resolved OUTSIDE the guard, so a refused name stays a refused
    // name instead of being reported as a file the guest did not write.
    const path = this.resolve(name);
    try {
      return (await stat(path)).size;
    } catch {
      throw new ReferenceDataMaterialError("reference_data_material_absent", `The guest left no ${name}.`);
    }
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

/** One sealed material, as this pack refers to it afterwards. */
export interface ReferenceDataMaterial {
  readonly objectName: string;
  readonly version: number;
  readonly mediaType: string;
  readonly digest: string;
  readonly totalBytes: number;
  readonly chunkCount: number;
  readonly artifact: FactoryArtifactReference;
}

function sealed(record: FactoryMaterialRecord, artifact: FactoryArtifactReference): ReferenceDataMaterial {
  return Object.freeze({
    objectName: record.objectName,
    version: record.version,
    mediaType: record.mediaType,
    digest: record.digest,
    totalBytes: record.totalBytes,
    chunkCount: record.chunkCount,
    artifact,
  });
}

/**
 * Seals a byte stream as one W04 material version.
 *
 * The stream is read once, chunked at W04's own chunk bound, and the whole
 * digest is computed as it goes, so a 256 MiB export never exists as one
 * buffer. `begin` needs the total length and the chunk count up front, which is
 * why the caller measures the bytes first; that measurement is also what the
 * guest's reported digest is checked against.
 */
export async function sealReferenceDataMaterial(
  materials: Pick<FactoryAttemptMaterials, "begin" | "writeChunk" | "seal">,
  identity: FactoryMaterialIdentity,
  mediaType: string,
  totalBytes: number,
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReferenceDataMaterial> {
  if (totalBytes > FACTORY_MATERIAL_LIMITS.maxTotalBytes) throw new ReferenceDataMaterialError("reference_data_material_oversized", `${identity.objectName} is ${totalBytes} bytes, past the ${FACTORY_MATERIAL_LIMITS.maxTotalBytes}-byte material bound.`);
  // W04 refuses a plan whose chunk count exceeds its byte count, so a zero-byte
  // material cannot be sealed at all. Refusing it here names the reason.
  if (totalBytes === 0) throw new ReferenceDataMaterialError("reference_data_material_empty", `${identity.objectName} holds no bytes, and an empty material has no chunk plan.`);
  const chunkCount = Math.ceil(totalBytes / FACTORY_MATERIAL_LIMITS.maxChunkBytes);
  const record = await materials.begin(identity, mediaType, totalBytes, chunkCount, signal);
  const hasher = new Bun.CryptoHasher("sha256");
  let index = 0;
  let written = 0;
  // The stream is REPACKED to the plan. A caller's blocks are whatever its own
  // reader produced - a megabyte from a file, a line buffer from a generator -
  // and writing one chunk per block would put a 256 MiB material far past its
  // declared chunk count.
  let pending = new Uint8Array(FACTORY_MATERIAL_LIMITS.maxChunkBytes);
  let filled = 0;
  const flush = async () => {
    const chunk = pending.subarray(0, filled);
    await materials.writeChunk(identity, { index, digest: factoryMaterialDigest(chunk), encodedBytes: chunk.byteLength }, chunk, signal);
    index += 1;
    pending = new Uint8Array(FACTORY_MATERIAL_LIMITS.maxChunkBytes);
    filled = 0;
  };
  for await (const block of source) {
    hasher.update(block);
    written += block.byteLength;
    let offset = 0;
    while (offset < block.byteLength) {
      const take = Math.min(FACTORY_MATERIAL_LIMITS.maxChunkBytes - filled, block.byteLength - offset);
      pending.set(block.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === FACTORY_MATERIAL_LIMITS.maxChunkBytes) await flush();
    }
  }
  if (filled > 0) await flush();
  if (written !== totalBytes || index !== chunkCount) throw new ReferenceDataMaterialError("reference_data_material_digest_mismatch", `${identity.objectName} measured ${totalBytes} bytes in ${chunkCount} chunk(s) and wrote ${written} in ${index}.`);
  // `digest` finalises the hasher, so the whole-material digest is taken once
  // and reused for both the seal and the record this returns.
  const digest = `sha256:${hasher.digest("hex")}`;
  const artifact = await materials.seal(identity, digest, signal);
  return sealed({ ...record, digest, totalBytes, chunkCount, sealed: true }, artifact);
}

/**
 * Streams a sealed material back out of W04, chunk by chunk.
 *
 * It never calls the scoped reader's whole-artifact `read`: that allocates the
 * assembled bytes, and this pack's largest material is the 256 MiB input
 * snapshot.
 */
export async function* readReferenceDataMaterial(
  reader: FactoryScopedArtifactReader,
  scope: FactoryMaterialScope,
  material: Pick<ReferenceDataMaterial, "artifact" | "chunkCount">,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for (let index = 0; index < material.chunkCount; index += 1) yield await reader.readChunk(scope, material.artifact, index, signal);
}

/** `sha256:` over a whole byte stream, without holding it. */
export async function streamDigest(source: AsyncIterable<Uint8Array>): Promise<{ readonly digest: string; readonly totalBytes: number }> {
  const hasher = new Bun.CryptoHasher("sha256");
  let totalBytes = 0;
  for await (const chunk of source) {
    hasher.update(chunk);
    totalBytes += chunk.byteLength;
  }
  return { digest: `sha256:${hasher.digest("hex")}`, totalBytes };
}

/** `sha256:` over bytes already in hand, in the shape W04's material digests take. */
export function referenceDataDigest(bytes: Uint8Array): string {
  return `sha256:${digestBytes(bytes)}`;
}
