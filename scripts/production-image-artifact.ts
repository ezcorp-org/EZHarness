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

async function command(binary: string, args: string[], stdin?: ReadableStream<Uint8Array>): Promise<string> {
  const child = Bun.spawn([binary, ...args], { stdin, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) fail(`${binary} ${args.join(" ")} failed: ${stderr.trim() || `exit ${exit}`}`);
  return stdout.trim();
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

  const saver = Bun.spawn(["docker", "image", "save", image], { stdout: "pipe", stderr: "pipe" });
  let compressor: Bun.ReadableSubprocess;
  try {
    compressor = Bun.spawn(["zstd", "--no-progress", "--threads=2", "-q", "-o", archive], { stdin: saver.stdout, stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    saver.kill();
    await saver.exited;
    throw error;
  }
  const saverExit = saver.exited.then((exit) => {
    if (exit !== 0) compressor.kill();
    return exit;
  });
  const compressorExit = compressor.exited.then((exit) => {
    if (exit !== 0) saver.kill();
    return exit;
  });
  const [saveStderr, compressionStderr, saveExit, compressionExit] = await Promise.all([
    new Response(saver.stderr).text(), new Response(compressor.stderr).text(), saverExit, compressorExit,
  ]);
  if (saveExit !== 0 || compressionExit !== 0) {
    await unlink(archive).catch(() => undefined);
    fail(`archive creation failed: docker=${saveExit} ${saveStderr.trim()} zstd=${compressionExit} ${compressionStderr.trim()}`.trim());
  }

  const metadata: ArtifactMetadata = {
    schemaVersion: 1,
    image,
    revision,
    imageId: producerImageId,
    archiveSha256: await checksum(archive),
  };
  await writeMetadata(metadataPath, metadata);
  return producerImageId;
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

  for (const engine of ["docker", "podman"] as const) {
    const decompressor = Bun.spawn(["zstd", "-d", "--no-progress", "--threads=2", "-q", "-c", archive], { stdout: "pipe", stderr: "pipe" });
    const loadError = command(engine, ["image", "load"], decompressor.stdout).then(
      () => undefined,
      (error: unknown) => {
        decompressor.kill();
        return error;
      },
    );
    const [[decompressionStderr, decompressionExit], error] = await Promise.all([
      Promise.all([new Response(decompressor.stderr).text(), decompressor.exited]), loadError,
    ]);
    if (error) throw error;
    if (decompressionExit !== 0) fail(`${engine} archive decompression failed: ${decompressionStderr.trim() || `exit ${decompressionExit}`}`);

    const [actualImageId, actualRevision] = await Promise.all([imageId(engine, metadata.image), revisionLabel(engine, metadata.image)]);
    if (actualImageId !== expectedImageId) fail(`${engine} image ID ${actualImageId} does not match expected image ID ${expectedImageId}`);
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
