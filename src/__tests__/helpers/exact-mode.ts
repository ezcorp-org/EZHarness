/**
 * Fixture files with exact permission bits, whatever the runner's umask.
 *
 * `writeFile(path, data, { mode })` is masked by the umask and ignored when
 * the file already exists, and `copyFile` keeps the source's mode. A heavy
 * runner at umask 077, or a checkout made under it, therefore turned "0644"
 * fixtures into 0600 ones (2026-09-24: setup-podman, dev-image-provenance,
 * local-sandbox-startup, podman-compose-wrapper).
 */
import { chmodSync, writeFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";

/** The mode git gives a tracked, non-executable file on checkout. */
export const GIT_REGULAR_FILE_MODE = 0o644;

/** Write `data` to `path`, then set exactly `mode`. */
export function writeFileWithMode(path: string, data: string, mode: number): void {
  writeFileSync(path, data);
  chmodSync(path, mode);
}

/** Async form of {@link writeFileWithMode}. */
export async function writeFileWithModeAsync(path: string, data: string, mode: number): Promise<void> {
  await writeFile(path, data);
  await chmod(path, mode);
}

/** Write a tracked fixture file as a git checkout would leave it. */
export function writeTrackedFile(path: string, data: string): void {
  writeFileWithMode(path, data, GIT_REGULAR_FILE_MODE);
}
