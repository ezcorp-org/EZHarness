import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARCHIVE_FILENAME, archiveIdentity, isArchiveImage, METADATA_FILENAME } from "../../scripts/production-image-artifact.ts";

const IMAGE = "localhost/ezcorp-testing-review:a4f44e5be";
const REVISION = "a".repeat(40);
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
/** The containerd store's `.Id` for the same image: the digest of the manifest list it exports. */
const LIST_ID = `sha256:${"c".repeat(64)}`;
const MANIFEST_ID = `sha256:${"d".repeat(64)}`;
const ATTESTATION_ID = `sha256:${"e".repeat(64)}`;
const hex = (digest: string) => digest.slice("sha256:".length);

/** Archive members, by name, for the two `docker image save` shapes. */
function classicArchive(config = IMAGE_ID): Record<string, string> {
  return {
    "manifest.json": JSON.stringify([{ Config: `${hex(config)}.json`, RepoTags: [IMAGE], Layers: [] }]),
    [`${hex(config)}.json`]: JSON.stringify({ config: { Labels: { "org.opencontainers.image.revision": REVISION } } }),
  };
}

/** The containerd store's save: an OCI layout whose index names a manifest list, plus the compatibility manifest.json. */
function ociIndexArchive(config = IMAGE_ID): Record<string, string> {
  return {
    "oci-layout": JSON.stringify({ imageLayoutVersion: "1.0.0" }),
    "index.json": JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: "application/vnd.oci.image.index.v1+json", digest: LIST_ID, annotations: { "io.containerd.image.name": IMAGE } }] }),
    [`blobs/sha256/${hex(LIST_ID)}`]: JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: MANIFEST_ID, platform: { os: "linux", architecture: "amd64" } },
        { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: ATTESTATION_ID, platform: { os: "unknown", architecture: "unknown" } },
      ],
    }),
    [`blobs/sha256/${hex(MANIFEST_ID)}`]: JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: config }, layers: [] }),
    [`blobs/sha256/${hex(config)}`]: JSON.stringify({ config: { Labels: { "org.opencontainers.image.revision": REVISION } } }),
    "manifest.json": JSON.stringify([{ Config: `blobs/sha256/${hex(config)}`, RepoTags: [IMAGE], Layers: [] }]),
  };
}

/** Writes the members as a real tar, member names exactly as given, the way `docker image save` names them. */
async function writeTar(path: string, members: Record<string, string>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "image-archive-"));
  try {
    for (const [name, text] of Object.entries(members)) {
      await mkdir(join(dir, name, ".."), { recursive: true });
      await writeFile(join(dir, name), text);
    }
    const tar = Bun.spawnSync(["tar", "-c", "-f", path, "-C", dir, ...Object.keys(members)]);
    if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type Fixture = { root: string; outdir: string; log: string; env: Record<string, string | undefined> };

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "production-image-artifact-"));
  const bin = join(root, "bin");
  const outdir = join(root, "artifact");
  const log = join(root, "engine.log");
  await mkdir(bin, { recursive: true });
  const engine = `#!/bin/sh
set -eu
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$ENGINE_LOG"
if [ "$1" = image ] && [ "$2" = inspect ]; then
  if [ "$4" = '{{.Id}}' ]; then
    if [ "$(basename "$0")" = podman ]; then printf '%s\\n' "$PODMAN_IMAGE_ID"; else printf '%s\\n' "$DOCKER_IMAGE_ID"; fi
  else
    if [ "$(basename "$0")" = podman ]; then printf '%s\\n' "$PODMAN_REVISION"; else printf '%s\\n' "$DOCKER_REVISION"; fi
  fi
elif [ "$1" = image ] && [ "$2" = save ]; then
  cat "$SAVE_TAR"
elif [ "$1" = image ] && [ "$2" = load ]; then
  cat >/dev/null
  if [ "\${ENGINE_LOAD_FAILURE:-}" = "$(basename "$0")" ]; then exit 44; fi
else
  exit 91
fi
`;
  const zstd = `#!/bin/sh
set -eu
if [ "$1" = -d ]; then
  last=''
  for value in "$@"; do last="$value"; done
  cat "$last"
else
  if [ "\${ZSTD_FAILURE:-}" = pack ]; then exit 43; fi
  output=''
  previous=''
  for value in "$@"; do
    if [ "$previous" = -o ]; then output="$value"; fi
    previous="$value"
  done
  cat > "$output"
fi
`;
  await Promise.all([
    writeFile(join(bin, "docker"), engine, { mode: 0o755 }),
    writeFile(join(bin, "podman"), engine, { mode: 0o755 }),
    writeFile(join(bin, "zstd"), zstd, { mode: 0o755 }),
  ]);
  await Promise.all([chmod(join(bin, "docker"), 0o755), chmod(join(bin, "podman"), 0o755), chmod(join(bin, "zstd"), 0o755)]);
  await writeTar(join(root, "save.tar"), classicArchive());
  return { root, outdir, log, env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ENGINE_LOG: log,
    SAVE_TAR: join(root, "save.tar"),
    DOCKER_IMAGE_ID: IMAGE_ID,
    PODMAN_IMAGE_ID: IMAGE_ID.slice("sha256:".length),
    DOCKER_REVISION: REVISION,
    PODMAN_REVISION: REVISION,
  } };
}

async function cli(fixture: Fixture, args: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, "scripts/production-image-artifact.ts", ...args], {
    cwd: join(import.meta.dir, "..", ".."), env: fixture.env, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(stderr.trim());
  return stdout.trim();
}

async function withFixture(check: (value: Fixture) => Promise<void>): Promise<void> {
  const value = await fixture();
  try {
    await check(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
}

test("packs one producer image and loads the verified archive into Docker and Podman", async () => {
  await withFixture(async (fixture) => {
    const { outdir, log } = fixture;
    await expect(cli(fixture, ["pack", IMAGE, REVISION, outdir])).resolves.toBe(IMAGE_ID);
    await expect(cli(fixture, ["load", outdir, REVISION, IMAGE_ID])).resolves.toBe("");
    const metadata = JSON.parse(await readFile(join(outdir, METADATA_FILENAME), "utf8"));
    expect(metadata).toEqual({
      schemaVersion: 1,
      image: IMAGE,
      revision: REVISION,
      imageId: IMAGE_ID,
      archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await Bun.file(join(outdir, ARCHIVE_FILENAME)).exists()).toBe(true);
    const commands = await readFile(log, "utf8");
    expect(commands).toContain("docker image save");
    expect(commands).toContain("docker image load");
    expect(commands).toContain("podman image load");
  });
});

test("rejects a corrupted compressed archive before either engine loads it", async () => {
  await withFixture(async (value) => {
    const { outdir, log } = value;
    await cli(value, ["pack", IMAGE, REVISION, outdir]);
    await writeFile(join(outdir, ARCHIVE_FILENAME), "corrupt compressed bytes");
    await expect(cli(value, ["load", outdir, REVISION, IMAGE_ID])).rejects.toThrow("archive SHA-256 does not match metadata");
    expect(await readFile(log, "utf8")).not.toContain("image load");
  });
});

test("rejects a wrong revision and wrong producer image ID before an engine reads the archive", async () => {
  await withFixture(async (value) => {
    const { outdir, log } = value;
    await cli(value, ["pack", IMAGE, REVISION, outdir]);
    const wrongRevision = `b${REVISION.slice(1)}`;
    await expect(cli(value, ["load", outdir, wrongRevision, IMAGE_ID])).rejects.toThrow("metadata revision");
    await expect(cli(value, ["load", outdir, REVISION, `sha256:${"b".repeat(64)}`])).rejects.toThrow("metadata image ID");
    expect(await readFile(log, "utf8")).not.toContain("image load");
  });
});

test("rejects missing metadata and a loaded Podman image whose identity differs from the producer", async () => {
  await withFixture(async (value) => {
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
});

test("rejects a loaded engine whose OCI revision label differs from the independent revision", async () => {
  await withFixture(async (value) => {
    const { outdir, log } = value;
    await cli(value, ["pack", IMAGE, REVISION, outdir]);
    value.env.PODMAN_REVISION = `b${REVISION.slice(1)}`;
    await expect(cli(value, ["load", outdir, REVISION, IMAGE_ID])).rejects.toThrow("podman revision label");
    expect(await readFile(log, "utf8")).toContain("podman image load");
  });
});

test("checksums a multi-megabyte compressed archive before loading it", async () => {
  await withFixture(async (value) => {
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
});

test("settles the decompressor when an engine rejects the archive load", async () => {
  await withFixture(async (value) => {
    const { outdir, log } = value;
    await cli(value, ["pack", IMAGE, REVISION, outdir]);
    value.env.ENGINE_LOAD_FAILURE = "podman";
    await expect(cli(value, ["load", outdir, REVISION, IMAGE_ID])).rejects.toThrow("podman image load failed");
    expect(await readFile(log, "utf8")).toContain("podman image load");
  });
});

test("cleans up a partial archive when compression fails", async () => {
  await withFixture(async (value) => {
    value.env.ZSTD_FAILURE = "pack";
    await expect(cli(value, ["pack", IMAGE, REVISION, value.outdir])).rejects.toThrow("archive creation failed");
    expect(await Bun.file(join(value.outdir, ARCHIVE_FILENAME)).exists()).toBe(false);
  });
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
  await withFixture(async (value) => {
    const { outdir } = value;
    await writeTar(value.env.SAVE_TAR!, ociIndexArchive());
    value.env.DOCKER_IMAGE_ID = LIST_ID;
    value.env.PODMAN_IMAGE_ID = hex(IMAGE_ID);
    // The recorded and printed ID is the config digest, which Podman reports too.
    await expect(cli(value, ["pack", IMAGE, REVISION, outdir])).resolves.toBe(IMAGE_ID);
    expect(JSON.parse(await readFile(join(outdir, METADATA_FILENAME), "utf8")).imageId).toBe(IMAGE_ID);
    await expect(cli(value, ["load", outdir, REVISION, IMAGE_ID])).resolves.toBe("");
  });
});

test("pack refuses a Docker image ID that is not the image in the saved archive", async () => {
  await withFixture(async (value) => {
    value.env.DOCKER_IMAGE_ID = `sha256:${"b".repeat(64)}`;
    await expect(cli(value, ["pack", IMAGE, REVISION, value.outdir])).rejects.toThrow("is not the image in the saved archive");
  });
});

test("load refuses an archive whose config is not the expected image, before either engine loads it", async () => {
  await withFixture(async (value) => {
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
});
