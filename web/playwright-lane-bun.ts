/**
 * Every browser lane starts its server with the `bun` that PATH resolves: the
 * webServer commands say `bun …` or run a script that does. A PATH with another
 * Bun first (a system Bun 1.4.2 while .bun-version pins 1.3.14, W09e) started
 * the product server under the wrong runtime, silently. A lane now refuses to
 * start any server unless the resolved `bun --version` equals .bun-version, and
 * names both versions when it refuses. scripts/lib/lane-bun.sh is the same guard
 * for the lane scripts, which also put the pinned Bun first on PATH.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

export function laneBunMismatch(pinned: string, resolved: string): string | null {
	if (pinned === resolved) return null;
	return `lane Bun mismatch: PATH resolves bun ${resolved}, .bun-version pins ${pinned}. Put the pinned Bun first on PATH (scripts/lib/lane-bun.sh does this for the lane scripts; EZCORP_PINNED_BUN_DIR names its directory).`;
}

export function resolvedBunVersion(env: NodeJS.ProcessEnv = process.env): string {
	try {
		return execFileSync("bun", ["--version"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "none (no bun on PATH)";
	}
}

/** Returns the webServer block unchanged, or throws before Playwright can start it under the wrong Bun. */
export function pinnedWebServer<T>(server: T, env: NodeJS.ProcessEnv = process.env): T {
	const message = laneBunMismatch(readFileSync(join(REPO, ".bun-version"), "utf8").trim(), resolvedBunVersion(env));
	if (message) throw new Error(message);
	return server;
}
