import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ARCHIVE_FILENAME = "candidate-image.tar.zst";
export const METADATA_FILENAME = "candidate-image.json";

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

type ArtifactMetadata = Readonly<{
  schemaVersion: 1;
  image: string;
  revision: string;
  imageId: string;
  archiveSha256: string;
}>;

function fail(message: string): never {
  throw new Error(`production image artifact: ${message}`);
}

function requireRevision(revision: string): void {
  if (!REVISION.test(revision)) fail("revision must be a full lowercase 40-character Git SHA");
}

function requireImageId(imageId: string): void {
  if (!IMAGE_ID.test(imageId)) fail("image ID must be sha256:<64 lowercase hex characters>");
}

function normalizeImageId(imageId: string): string {
  const canonical = imageId.startsWith("sha256:") ? imageId : `sha256:${imageId}`;
  requireImageId(canonical);
  return canonical;
}

function requireImageReference(image: string): void {
  if (!IMAGE_REFERENCE.test(image)) fail("image must be a lowercase container image reference");
}

async function command(binary: string, args: string[]): Promise<string> {
  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) fail(`${binary} ${args.join(" ")} failed: ${stderr.trim() || `exit ${exit}`}`);
  return stdout.trim();
}

/** Bash owns both native pipes. Arguments stay positional, never shell source. */
async function pipeline(description: string, source: string, values: string[]): Promise<string> {
  try {
    return await command("bash", ["-o", "pipefail", "-c", source, "--", ...values]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`${description} failed: ${message}`);
  }
}

async function inspect(binary: "docker" | "podman", image: string, format: string): Promise<string> {
  return command(binary, ["image", "inspect", "--format", format, image]);
}

async function imageId(binary: "docker" | "podman", image: string): Promise<string> {
  return normalizeImageId(await inspect(binary, image, "{{.Id}}"));
}

async function revisionLabel(binary: "docker" | "podman", image: string): Promise<string> {
  return inspect(binary, image, '{{ index .Config.Labels "org.opencontainers.image.revision" }}');
}

/**
 * What a saved image archive says about its own identity: the image CONFIG digest, and every manifest or index digest
 * it lists. The config digest is the one ID every engine and store agrees on. Podman reports it as `.Id`, and so does
 * Docker's classic store. Docker's containerd image store (ubuntu-26.04's default) reports the digest of the
 * manifest list it exported instead, which this archive lists in `index.json`.
 */
export type ArchiveIdentity = Readonly<{ configDigest: string; manifestDigests: readonly string[] }>;

/** Reads one member of the archive as text, or null when the archive has no such member. */
export type ArchiveReader = (member: string) => Promise<string | null>;

const IMAGE_INDEX_TYPES = new Set(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"]);
const ATTESTATION_PLATFORM = "unknown";

type Descriptor = { mediaType?: string; digest?: string; platform?: { os?: string; architecture?: string } };

function parseJson(text: string, member: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    fail(`archive ${member} is not valid JSON`);
  }
}

function requireDigest(value: unknown, member: string): string {
  if (typeof value !== "string" || !IMAGE_ID.test(value)) fail(`archive ${member} names no sha256 digest`);
  return value;
}

function blobMember(digest: string): string {
  return `blobs/sha256/${digest.slice("sha256:".length)}`;
}

/** `manifest.json`'s one entry names its config as `<hex>.json` (docker save) or `blobs/sha256/<hex>` (OCI-layout save). */
function configDigestFromDockerManifest(text: string): string {
  const entries = parseJson(text, "manifest.json");
  if (!Array.isArray(entries) || entries.length !== 1) fail("archive manifest.json must describe exactly one image");
  const config = (entries[0] as { Config?: unknown }).Config;
  const hex = typeof config === "string" ? /^(?:blobs\/sha256\/)?([a-f0-9]{64})(?:\.json)?$/.exec(config)?.[1] : undefined;
  if (!hex) fail("archive manifest.json names no config digest");
  return `sha256:${hex}`;
}

/**
 * The archive's identity. `manifest.json` (written by every `docker image save`) names the config; `index.json`, when
 * present, lists the manifests and manifest lists the engine may report as `.Id`. Both are read when both exist, and
 * they must name the same config.
 */
export async function archiveIdentity(read: ArchiveReader): Promise<ArchiveIdentity> {
  const [dockerManifest, ociIndex] = await Promise.all([read("manifest.json"), read("index.json")]);
  if (dockerManifest === null && ociIndex === null) fail("archive has neither manifest.json nor index.json");
  const manifestDigests: string[] = [];
  const configs = new Set<string>();
  if (ociIndex !== null) {
    const pending: Descriptor[] = [...(((parseJson(ociIndex, "index.json") as { manifests?: Descriptor[] }).manifests) ?? [])];
    while (pending.length > 0) {
      const descriptor = pending.shift()!;
      const digest = requireDigest(descriptor.digest, "index.json");
      manifestDigests.push(digest);
      if (descriptor.platform?.os === ATTESTATION_PLATFORM) continue;
      const blob = await read(blobMember(digest));
      if (blob === null) fail(`archive lists ${digest} but does not contain it`);
      const parsed = parseJson(blob, blobMember(digest)) as { mediaType?: string; manifests?: Descriptor[]; config?: { digest?: unknown } };
      if (IMAGE_INDEX_TYPES.has(descriptor.mediaType ?? "") || IMAGE_INDEX_TYPES.has(parsed.mediaType ?? "") || Array.isArray(parsed.manifests)) {
        pending.push(...(parsed.manifests ?? []));
      } else {
        configs.add(requireDigest(parsed.config?.digest, blobMember(digest)));
      }
    }
  }
  if (dockerManifest !== null) configs.add(configDigestFromDockerManifest(dockerManifest));
  if (configs.size !== 1) fail(`archive must name exactly one image config, found ${configs.size}`);
  return { configDigest: [...configs][0]!, manifestDigests };
}

/** True when an engine's reported image ID is this archive's image: its config digest or one of its manifest digests. */
export function isArchiveImage(identity: ArchiveIdentity, reportedId: string): boolean {
  return reportedId === identity.configDigest || identity.manifestDigests.includes(reportedId);
}

/** Reads archive members through the compressor and `tar`; one pass lists the archive, one pass reads each member. */
function compressedArchiveReader(archive: string): ArchiveReader {
  let members: Promise<Set<string>> | undefined;
  return async (member) => {
    members ??= pipeline("archive listing", 'zstd -d --no-progress -q -c "$1" | tar -t -f -', [archive]).then((list) => new Set(list.split("\n")));
    if (!(await members).has(member)) return null;
    return pipeline(`archive read of ${member}`, 'zstd -d --no-progress -q -c "$1" | tar -x -O -f - "$2"', [archive, member]);
  };
}

function parseMetadata(value: unknown): ArtifactMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("metadata must be a JSON object");
  const record = value as Record<string, unknown>;
  const expected = ["archiveSha256", "image", "imageId", "revision", "schemaVersion"];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail("metadata has an invalid field set");
  if (record.schemaVersion !== 1 || typeof record.image !== "string" || typeof record.revision !== "string" || typeof record.imageId !== "string" || typeof record.archiveSha256 !== "string") {
    fail("metadata has invalid field types");
  }
  requireImageReference(record.image);
  requireRevision(record.revision);
  requireImageId(record.imageId);
  if (!SHA256.test(record.archiveSha256)) fail("metadata archive SHA-256 is invalid");
  return record as ArtifactMetadata;
}

async function regularFile(path: string, description: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch {
    fail(`${description} is missing`);
  }
  if (!stats.isFile()) fail(`${description} must be a regular file`);
}

async function checksum(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}

async function writeMetadata(path: string, metadata: ArtifactMetadata): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(metadata)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch {
    return;
  }
  fail(`${path} already exists`);
}

export async function pack(image: string, revision: string, outdir: string): Promise<string> {
  requireImageReference(image);
  requireRevision(revision);
  await mkdir(outdir, { recursive: true });
  const archive = join(outdir, ARCHIVE_FILENAME);
  const metadataPath = join(outdir, METADATA_FILENAME);
  await Promise.all([assertAbsent(archive), assertAbsent(metadataPath)]);

  const producerImageId = await imageId("docker", image);
  const producerRevision = await revisionLabel("docker", image);
  if (producerRevision !== revision) fail(`producer image revision label ${JSON.stringify(producerRevision)} does not match ${revision}`);

  try {
    // `pipefail` returns a producer or compressor failure only after Bash has
    // waited for both native-pipe children, so neither becomes an orphan.
    await pipeline("archive creation", 'docker image save "$1" | zstd --no-progress --threads=2 -q -o "$2"', [image, archive]);
  } catch (error) {
    await unlink(archive).catch(() => undefined);
    throw error;
  }

  // The recorded ID is the archive's CONFIG digest, the one ID every engine and image store agrees on. Docker's own
  // `.Id` must be this archive's image, but under the containerd store it is the manifest list's digest, not the config.
  const identity = await archiveIdentity(compressedArchiveReader(archive));
  if (!isArchiveImage(identity, producerImageId)) fail(`docker image ID ${producerImageId} is not the image in the saved archive (config ${identity.configDigest})`);

  const metadata: ArtifactMetadata = {
    schemaVersion: 1,
    image,
    revision,
    imageId: identity.configDigest,
    archiveSha256: await checksum(archive),
  };
  await writeMetadata(metadataPath, metadata);
  return identity.configDigest;
}

export async function load(outdir: string, revision: string, expectedImageId: string): Promise<void> {
  requireRevision(revision);
  requireImageId(expectedImageId);
  const archive = join(outdir, ARCHIVE_FILENAME);
  const metadataPath = join(outdir, METADATA_FILENAME);
  await Promise.all([regularFile(archive, "archive"), regularFile(metadataPath, "metadata")]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    fail("metadata is not valid JSON");
  }
  const metadata = parseMetadata(parsed);
  if (metadata.revision !== revision) fail("metadata revision does not match the expected revision");
  if (metadata.imageId !== expectedImageId) fail("metadata image ID does not match the expected producer image ID");
  if ((await checksum(archive)) !== metadata.archiveSha256) fail("archive SHA-256 does not match metadata");
  const identity = await archiveIdentity(compressedArchiveReader(archive));
  if (identity.configDigest !== expectedImageId) fail(`archive config digest ${identity.configDigest} does not match expected image ID ${expectedImageId}`);

  for (const engine of ["docker", "podman"] as const) {
    await pipeline(`${engine} image load`, 'zstd -d --no-progress --threads=2 -q -c "$1" | "$2" image load', [archive, engine]);

    const [actualImageId, actualRevision] = await Promise.all([imageId(engine, metadata.image), revisionLabel(engine, metadata.image)]);
    if (!isArchiveImage(identity, actualImageId)) fail(`${engine} image ID ${actualImageId} does not match expected image ID ${expectedImageId}`);
    if (actualRevision !== revision) fail(`${engine} revision label ${JSON.stringify(actualRevision)} does not match ${revision}`);
  }
}

export async function runProductionImageArtifactCli(args: string[], write: (line: string) => void = console.log): Promise<void> {
  const [operation, ...rest] = args;
  if (operation === "pack" && rest.length === 3) {
    write(await pack(rest[0]!, rest[1]!, rest[2]!));
    return;
  }
  if (operation === "load" && rest.length === 3) {
    await load(rest[0]!, rest[1]!, rest[2]!);
    return;
  }
  fail("usage: bun scripts/production-image-artifact.ts pack IMAGE REVISION OUTDIR | load OUTDIR REVISION EXPECTED_IMAGE_ID");
}

if (import.meta.main) await runProductionImageArtifactCli(process.argv.slice(2));
