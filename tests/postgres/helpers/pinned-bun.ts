import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The pinned Bun binary, derived from .bun-version so a pin change edits one file (see scripts/lib/pinned-bun.sh).
 * A proof host provisions it under the tool directory. A CI runner has no tool directory; its setup-bun step
 * installs the pinned version from .bun-version, so the running Bun is the pin there. Any other Bun is refused
 * by name rather than used.
 */
export function resolvePinnedBun(
  pin: string,
  toolsDirectory: string,
  running: { readonly version: string; readonly execPath: string },
  exists: (path: string) => boolean,
): string {
  const provisioned = `${toolsDirectory}/bun-${pin}/bun-linux-x64/bun`;
  if (exists(provisioned)) return provisioned;
  if (running.version === pin) return running.execPath;
  throw new Error(`pinned Bun ${pin} is missing at ${provisioned} and the running Bun is ${running.version}`);
}

export const pinnedBun = resolvePinnedBun(
  readFileSync(join(import.meta.dir, "../../../.bun-version"), "utf8").trim(),
  process.env.FACTORY_TOOLS_DIR ?? "/tmp/factory-tools",
  { version: Bun.version, execPath: process.execPath },
  existsSync,
);
