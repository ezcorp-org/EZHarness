import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARCHIVE_FILENAME, METADATA_FILENAME } from "../../scripts/production-image-artifact.ts";

const IMAGE = "localhost/ezcorp-testing-review:a4f44e5be";
const REVISION = "a".repeat(40);
const IMAGE_ID = `sha256:${"a".repeat(64)}`;

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
  printf 'fake docker save bytes\\n'
elif [ "$1" = image ] && [ "$2" = load ]; then
  cat >/dev/null
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
  return { root, outdir, log, env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ENGINE_LOG: log,
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
