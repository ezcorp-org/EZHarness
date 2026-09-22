import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A 0700 temp root the private reader accepts. It lives under
 * XDG_RUNTIME_DIR or $HOME, never /tmp: /tmp is a world-writable ancestor,
 * and the private reader refuses it.
 */
export async function makeFactoryPrivateRoot(): Promise<string> {
  const root = await mkdtemp(join(process.env.XDG_RUNTIME_DIR ?? homedir(), "w16-test-"));
  await chmod(root, 0o700);
  return root;
}

export async function removeFactoryPrivateRoot(root: string | undefined): Promise<void> {
  if (root) await rm(root, { recursive: true, force: true });
}

/** Write one file with an explicit mode (chmod after write, so umask cannot widen or narrow it). */
export async function writeModeFile(path: string, content: string | Uint8Array, mode = 0o600): Promise<string> {
  await writeFile(path, content, { mode });
  await chmod(path, mode);
  return path;
}
