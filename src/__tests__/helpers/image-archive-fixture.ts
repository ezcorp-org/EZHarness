/**
 * Fake container engines and real image archives for the image-identity tests. The engines are shell scripts on PATH
 * that answer `image inspect`, `image save` (to stdout or `-o FILE`) and `image load` from environment variables; the
 * archives are real tar files in the two shapes `docker image save` writes.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runProductionImageArtifactCli } from "../../../scripts/production-image-artifact.ts";

export const IMAGE = "localhost/ezcorp-testing-review:a4f44e5be";
export const REVISION = "a".repeat(40);
export const IMAGE_ID = `sha256:${"a".repeat(64)}`;
/** The containerd store's `.Id` for the same image: the digest of the manifest list it exports. */
export const LIST_ID = `sha256:${"c".repeat(64)}`;
export const MANIFEST_ID = `sha256:${"d".repeat(64)}`;
export const ATTESTATION_ID = `sha256:${"e".repeat(64)}`;
export const hex = (digest: string) => digest.slice("sha256:".length);

/** Archive members, by name, for the two `docker image save` shapes. */
export function classicArchive(config = IMAGE_ID): Record<string, string> {
  return {
    "manifest.json": JSON.stringify([{ Config: `${hex(config)}.json`, RepoTags: [IMAGE], Layers: [] }]),
    [`${hex(config)}.json`]: JSON.stringify({ config: { Labels: { "org.opencontainers.image.revision": REVISION } } }),
  };
}

/** The containerd store's save: an OCI layout whose index names a manifest list, plus the compatibility manifest.json. */
export function ociIndexArchive(config = IMAGE_ID): Record<string, string> {
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
export async function writeTar(path: string, members: Record<string, string>): Promise<void> {
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

export type Fixture = { root: string; outdir: string; log: string; env: Record<string, string | undefined> };

export async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "production-image-artifact-"));
  const bin = join(root, "bin");
  const outdir = join(root, "artifact");
  const log = join(root, "engine.log");
  await mkdir(bin, { recursive: true });
  const engine = `#!/bin/sh
set -eu
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$ENGINE_LOG"
if [ "$1" = image ] && [ "$2" = inspect ]; then
  # The format may come before or after the image name (--format F IMAGE, or IMAGE --format F), or not at all.
  format=''
  previous=''
  for value in "$@"; do
    if [ "$previous" = --format ]; then format="$value"; fi
    previous="$value"
  done
  name="$(basename "$0")"
  case "$format" in
    '') exit 0 ;;
    '{{.Id}}') if [ "$name" = podman ]; then printf '%s\n' "$PODMAN_IMAGE_ID"; else printf '%s\n' "$DOCKER_IMAGE_ID"; fi ;;
    *revision*) if [ "$name" = podman ]; then printf '%s\n' "$PODMAN_REVISION"; else printf '%s\n' "$DOCKER_REVISION"; fi ;;
    *) exit 92 ;;
  esac
elif [ "$1" = image ] && [ "$2" = save ] && [ "$3" = -o ]; then
  cp "$SAVE_TAR" "$4"
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

/**
 * Runs the CLI in this process, so coverage counts it, with `process.env` set to the fixture's environment for the
 * call: the fake engines on PATH and the IDs they report. Returns what the CLI printed.
 */
export async function cli(fixture: Fixture, args: string[]): Promise<string> {
  const saved = { ...process.env };
  const lines: string[] = [];
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, fixture.env);
  try {
    await runProductionImageArtifactCli(args, (line) => lines.push(line));
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  return lines.join("\n");
}
