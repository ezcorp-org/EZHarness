import { createHash } from "node:crypto";

/**
 * The stable v4 installation id of a bundled first-party extension that has no
 * legacy extension row. Its own module so the runtime hosts can name the staged
 * installation without importing the whole bundled bootstrap.
 */
export function bundledInstallationId(name: string): string {
  const digest = createHash("sha256").update(`ezcorp-first-party-v4:${name}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
