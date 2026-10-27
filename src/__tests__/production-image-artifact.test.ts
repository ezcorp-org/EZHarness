import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ARCHIVE_FILENAME, archiveIdentity, isArchiveImage, METADATA_FILENAME } from "../../scripts/production-image-artifact.ts";
import { ATTESTATION_ID, classicArchive, cli, type Fixture, fixture, hex, IMAGE, IMAGE_ID, LIST_ID, MANIFEST_ID, ociIndexArchive, REVISION, writeTar } from "./helpers/image-archive-fixture.ts";

let value: Fixture;
beforeEach(async () => {
  value = await fixture();
});
afterEach(async () => {
  await rm(value.root, { recursive: true, force: true });
});

test("packs one producer image and loads the verified archive into Docker and Podman", async () => {
  const { outdir, log } = value;
  await expect(cli(value, ["pack", IMAGE, REVISION, outdir])).resolves.toBe(IMAGE_ID);
  await expect(cli(value, ["load", outdir, REVISION, IMAGE_ID])).resolves.toBe("");
  const metadata = JSON.parse(await readFile(join(outdir, METADATA_FILENAME), "utf8"));
  expect(metadata).toEqual({
    schemaVersion: 2,
    image: IMAGE,
    revision: REVISION,
    imageId: IMAGE_ID,
    manifestDigests: [],
    archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(await Bun.file(join(outdir, ARCHIVE_FILENAME)).exists()).toBe(true);
  const commands = await readFile(log, "utf8");
  expect(commands).toContain("docker image save");
  expect(commands).toContain("docker image load");
  expect(commands).toContain("podman image load");
});

test("rejects a corrupted compressed archive before either engine loads it", async () => {
  const { outdir, log } = value;
  await cli(value, ["pack", IMAGE, REVISION, outdir]);
  await writeFile(join(outdir, ARCHIVE_FILENAME), "corrupt compressed bytes");
  await expect(cli(value, ["load", outdir, REVISION, IMAGE_ID])).rejects.toThrow("archive SHA-256 does not match metadata");
  expect(await readFile(log, "utf8")).not.toContain("image load");
});

test("rejects a wrong revision and wrong producer image ID before an engine reads the archive", async () => {
  const { outdir, log } = value;
  await cli(value, ["pack", IMAGE, REVISION, outdir]);
  const wrongRevision = `b${REVISION.slice(1)}`;
  await expect(cli(value, ["load", outdir, wrongRevision, IMAGE_ID])).rejects.toThrow("metadata revision");
  await expect(cli(value, ["load", outdir, REVISION, `sha256:${"b".repeat(64)}`])).rejects.toThrow("metadata image ID");
  expect(await readFile(log, "utf8")).not.toContain("image load");
});

test("rejects missing metadata and a loaded Podman image whose identity differs from the producer", async () => {
  const { outdir, log } = value;
  await cli(value, ["pack", IMAGE, REVISION, outdir]);
  await unlink(join(outdir, METADATA_FILENAME));
  await expect(cli(value, ["load", outdir, REVISION, IMAGE_ID])).rejects.toThrow("metadata is missing");

  await rm(outdir, { recursive: true, force: true });
  await cli(value, ["pack", IMAGE, REVISION, outdir]);
  value.env.PODMAN_IMAGE_ID = `sha256:${"b".repeat(64)}`;
  await expect(cli(value, ["load", outdir, REVISION, IMAGE_ID])).rejects.toThrow("podman image ID");
  expect(await readFile(log, "utf8")).toContain("podman image load");
});

test("rejects a loaded engine whose OCI revision label differs from the independent revision", async () => {
  const { outdir, log } = value;
  await cli(value, ["pack", IMAGE, REVISION, outdir]);
  value.env.PODMAN_REVISION = `b${REVISION.slice(1)}`;
  await expect(cli(value, ["load", outdir, REVISION, IMAGE_ID])).rejects.toThrow("podman revision label");
  expect(await readFile(log, "utf8")).toContain("podman image load");
});

test("checksums a multi-megabyte compressed archive before loading it", async () => {
  const { outdir } = value;
  await cli(value, ["pack", IMAGE, REVISION, outdir]);
  // A real archive with an 8 MiB layer member, so the identity read after the checksum still finds its image.
  await writeTar(join(outdir, ARCHIVE_FILENAME), { ...classicArchive(), "layer.tar": "a".repeat(8 * 1024 * 1024) });
  const bytes = await readFile(join(outdir, ARCHIVE_FILENAME));
  expect(bytes.length).toBeGreaterThan(8 * 1024 * 1024);
  const metadataPath = join(outdir, METADATA_FILENAME);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
  await expect(cli(value, ["load", outdir, REVISION, IMAGE_ID])).resolves.toBe("");
});

test("settles the decompressor when an engine rejects the archive load", async () => {
  const { outdir, log } = value;
  await cli(value, ["pack", IMAGE, REVISION, outdir]);
  value.env.ENGINE_LOAD_FAILURE = "podman";
  await expect(cli(value, ["load", outdir, REVISION, IMAGE_ID])).rejects.toThrow("podman image load failed");
  expect(await readFile(log, "utf8")).toContain("podman image load");
});

test("cleans up a partial archive when compression fails", async () => {
  value.env.ZSTD_FAILURE = "pack";
  await expect(cli(value, ["pack", IMAGE, REVISION, value.outdir])).rejects.toThrow("archive creation failed");
  expect(await Bun.file(join(value.outdir, ARCHIVE_FILENAME)).exists()).toBe(false);
});

/** An in-memory reader over archive members, for the parsing tests. */
const reader = (members: Record<string, string>) => async (member: string) => members[member] ?? null;

test("an archive's identity is its config digest, from either save shape", async () => {
  expect(await archiveIdentity(reader(classicArchive()))).toEqual({ configDigest: IMAGE_ID, manifestDigests: [] });
  expect(await archiveIdentity(reader(ociIndexArchive()))).toEqual({ configDigest: IMAGE_ID, manifestDigests: [LIST_ID, MANIFEST_ID, ATTESTATION_ID] });
  const { "manifest.json": _compat, ...ociOnly } = ociIndexArchive();
  expect(await archiveIdentity(reader(ociOnly))).toEqual({ configDigest: IMAGE_ID, manifestDigests: [LIST_ID, MANIFEST_ID, ATTESTATION_ID] });
});

test("an engine's ID is the archive's image when it is the config digest or a manifest digest the archive lists", async () => {
  const identity = await archiveIdentity(reader(ociIndexArchive()));
  expect([IMAGE_ID, LIST_ID, MANIFEST_ID].map((id) => isArchiveImage(identity, id))).toEqual([true, true, true]);
  expect(isArchiveImage(identity, `sha256:${"b".repeat(64)}`)).toBe(false);
});

test("an archive that names no config, two configs, or a manifest it does not contain is refused", async () => {
  await expect(archiveIdentity(reader({}))).rejects.toThrow("neither manifest.json nor index.json");
  await expect(archiveIdentity(reader({ "manifest.json": "[]" }))).rejects.toThrow("exactly one image");
  await expect(archiveIdentity(reader({ "manifest.json": JSON.stringify([{ Config: "not-a-digest" }]) }))).rejects.toThrow("names no config digest");
  await expect(archiveIdentity(reader({ "manifest.json": "{" }))).rejects.toThrow("manifest.json is not valid JSON");
  const disagreeing = { ...ociIndexArchive(), "manifest.json": classicArchive(`sha256:${"b".repeat(64)}`)["manifest.json"]! };
  await expect(archiveIdentity(reader(disagreeing))).rejects.toThrow("exactly one image config, found 2");
  const { [`blobs/sha256/${hex(MANIFEST_ID)}`]: _manifest, ...missing } = ociIndexArchive();
  await expect(archiveIdentity(reader(missing))).rejects.toThrow(`lists ${MANIFEST_ID} but does not contain it`);
  const noDigest = { "index.json": JSON.stringify({ manifests: [{ digest: "latest" }] }) };
  await expect(archiveIdentity(reader(noDigest))).rejects.toThrow("index.json names no sha256 digest");
});

test("packs and loads under Docker's containerd image store, where docker reports the manifest list's digest", async () => {
  const { outdir } = value;
  await writeTar(value.env.SAVE_TAR!, ociIndexArchive());
  value.env.DOCKER_IMAGE_ID = LIST_ID;
  value.env.PODMAN_IMAGE_ID = hex(IMAGE_ID);
  // The recorded and printed ID is the config digest, which Podman reports too.
  await expect(cli(value, ["pack", IMAGE, REVISION, outdir])).resolves.toBe(IMAGE_ID);
  expect(JSON.parse(await readFile(join(outdir, METADATA_FILENAME), "utf8"))).toMatchObject({ imageId: IMAGE_ID, manifestDigests: [LIST_ID, MANIFEST_ID, ATTESTATION_ID] });
  await expect(cli(value, ["load", outdir, REVISION, IMAGE_ID])).resolves.toBe("");
});

test("pack refuses a Docker image ID that is not the image in the saved archive", async () => {
  value.env.DOCKER_IMAGE_ID = `sha256:${"b".repeat(64)}`;
  await expect(cli(value, ["pack", IMAGE, REVISION, value.outdir])).rejects.toThrow("is not the image in the saved archive");
});

test("load refuses an archive whose config is not the expected image, before either engine loads it", async () => {
  const { outdir, log } = value;
  await cli(value, ["pack", IMAGE, REVISION, outdir]);
  const archive = join(outdir, ARCHIVE_FILENAME);
  await writeTar(archive, classicArchive(`sha256:${"b".repeat(64)}`));
  const metadataPath = join(outdir, METADATA_FILENAME);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.archiveSha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
  await expect(cli(value, ["load", outdir, REVISION, IMAGE_ID])).rejects.toThrow("archive config digest");
  expect(await readFile(log, "utf8")).not.toContain("image load");
});
