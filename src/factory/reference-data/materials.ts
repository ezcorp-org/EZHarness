import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { GUEST_MATERIALS_PATH, listRunnerMaterials, openRunnerMaterial } from "@ezcorp/extension-runner";
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

/**
 * The uid every isolated guest runs as.
 *
 * This pack no longer moves ownership itself: the runner hands the material
 * directory over at launch. The constant is kept so a test can state which uid
 * the handover is expected to reach.
 */
export const REFERENCE_DATA_GUEST_UID = 65534;

export class ReferenceDataMaterialError extends Error {
  constructor(
    readonly code:
      | "reference_data_material_absent"
      | "reference_data_material_digest_mismatch"
      | "reference_data_material_empty"
      | "reference_data_material_oversized"
      | "reference_data_material_name_invalid"
      | "reference_data_material_unsealed"
      | "reference_data_material_untrusted",
    message: string,
  ) {
    super(message);
    this.name = "ReferenceDataMaterialError";
  }
}

/**
 * The per-attempt directory the shared runner mounts at `GUEST_MATERIALS_PATH`.
 *
 * It is ONE flat directory, not an input and an output half. The runner hands
 * over exactly the directory it is given - mode `0o770`, ownership moved to the
 * mapped guest uid, its own group retained - and it does not recurse, so a
 * nested output directory would stay this host's and the guest could not write
 * a byte into it. Measured against the runner, not assumed.
 *
 * What that costs is small and named: a guest can unlink an input staged beside
 * its outputs. Nothing rests on it not doing so. The guest verifies the digest
 * of what it reads, the host re-measures everything the guest writes, and the
 * reconciliation reads the immutable input back out of W04 rather than from
 * this directory, so a guest that replaces its own input only fails its own
 * attempt.
 *
 * Everything the guest leaves is read back through `listRunnerMaterials` and
 * `openRunnerMaterial`, which refuse a symbolic link, a device, a socket and a
 * FIFO rather than following one. That is what stops a planted link having the
 * host seal another file's bytes under the guest's own reported digest.
 */
export class ReferenceDataGuestDirectory {
  /** Exactly the names this host placed, so `produced()` can report only what the GUEST left. */
  private readonly staged = new Set<string>();

  private constructor(readonly root: string) {}

  static async create(parent?: string): Promise<ReferenceDataGuestDirectory> {
    // No mode and no owner are set here. The runner performs the handover at
    // launch and refuses a path that is not a real directory it owns.
    return new ReferenceDataGuestDirectory(await mkdtemp(join(parent ?? "/tmp", "ez-refdata-materials-")));
  }

  /** The name the guest sees for a staged input. The directory is flat, so it is the name itself. */
  static input(name: string): string {
    return name;
  }

  /** The name the guest sees for an output it must write. */
  static output(name: string): string {
    return name;
  }

  /** The path the guest reads, which is the same fixed mount point the runner declares. */
  static guestPath(name: string): string {
    return `${GUEST_MATERIALS_PATH}/${name}`;
  }

  private resolve(name: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new ReferenceDataMaterialError("reference_data_material_name_invalid", `Material name ${name} is not a bounded entry of the attempt directory.`);
    return join(this.root, name);
  }

  /**
   * Opens one file the GUEST wrote, through the shared hardened path.
   *
   * The name grammar above stops traversal and a second path segment; it does
   * nothing about a symbolic link AT the final component, which is exactly what
   * a guest that owns its output directory can plant. `openRunnerMaterial`
   * refuses one, so this never resolves to a file outside the mount.
   */
  private async openProduced(name: string): Promise<Awaited<ReturnType<typeof open>>> {
    this.resolve(name);
    try {
      return await openRunnerMaterial(this.root, name);
    } catch (error) {
      throw new ReferenceDataMaterialError("reference_data_material_absent", `The guest left no usable ${name} (${error instanceof Error ? error.message : String(error)}).`);
    }
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
    // The runner moves the DIRECTORY's ownership and leaves files as they are,
    // so this mode is the whole of what makes a staged input readable.
    await chmod(path, 0o644);
    this.staged.add(name);
    return { digest: `sha256:${hasher.digest("hex")}`, totalBytes };
  }

  /** Streams one output the guest left, in chunks a material write can take directly. */
  async *collect(name: string, chunkBytes = FACTORY_MATERIAL_LIMITS.maxChunkBytes): AsyncGenerator<Uint8Array> {
    const handle = await this.openProduced(name);
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

  /**
   * Every regular file the guest actually left, so an unexpected one is visible
   * rather than ignored, and anything that is not a regular file is a refusal
   * rather than an entry.
   */
  async produced(): Promise<readonly string[]> {
    let entries: Awaited<ReturnType<typeof listRunnerMaterials>>;
    try {
      entries = await listRunnerMaterials(this.root);
    } catch (error) {
      throw new ReferenceDataMaterialError("reference_data_material_untrusted", `The guest's material directory is not readable as ordinary files (${error instanceof Error ? error.message : String(error)}).`);
    }
    // Only what the GUEST left. The inputs this host staged sit in the same flat
    // directory, and reporting them as guest output would be a lie the seal
    // would then act on.
    return entries.map(entry => entry.path).filter(path => !this.staged.has(path)).sort();
  }

  async size(name: string): Promise<number> {
    const handle = await this.openProduced(name);
    try {
      return (await handle.stat()).size;
    } finally {
      await handle.close();
    }
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

/** One sealed material, as this pack refers to it afterwards. */
export interface ReferenceDataMaterial {
  /**
   * The C02 operation this material belongs to.
   *
   * It is carried on the record because one journey writes into SEVERAL
   * operations: W04 admits at most `maxObjectsPerOperation` objects under one,
   * and C10's hundred partitions produce three objects each. A reader has to
   * know which operation a material was sealed under, and asking the caller to
   * remember is how the wrong scope reaches a read.
   */
  readonly operationId: string;
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
    operationId: record.operationId,
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
  material: Pick<ReferenceDataMaterial, "artifact" | "chunkCount" | "operationId">,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  // The material names its own operation, so a caller holding the journey's
  // base scope reads every one of them without tracking which step wrote it.
  const scoped: FactoryMaterialScope = { ...scope, operationId: material.operationId };
  for (let index = 0; index < material.chunkCount; index += 1) yield await reader.readChunk(scoped, material.artifact, index, signal);
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
