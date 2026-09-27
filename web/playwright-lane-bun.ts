/**
 * Every browser lane starts its server with the `bun` that PATH resolves: the
 * webServer commands say `bun …` or run a script that does. A PATH with another
 * Bun first (a system Bun 1.4.2 while .bun-version pins 1.3.14, W09e) started
 * the product server under the wrong runtime, silently. A lane now refuses to
 * start any server unless the resolved `bun --version` and `bunx --version` both
 * equal .bun-version, and
 * names both versions when it refuses. scripts/lib/lane-bun.sh is the same guard
 * for the lane scripts, which also put the pinned Bun first on PATH.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Both entry points a lane runs through: `bun …` and `bunx …` (vite builds, vitest, Playwright). */
const LANE_BUN_TOOLS = ["bun", "bunx"] as const;

export function laneBunMismatch(tool: string, pinned: string, resolved: string): string | null {
	if (pinned === resolved) return null;
	return `lane Bun mismatch: PATH resolves ${tool} ${resolved}, .bun-version pins ${pinned}. Put the pinned Bun first on PATH (scripts/lib/lane-bun.sh does this for the lane scripts; EZCORP_PINNED_BUN_DIR names its directory).`;
}

export function resolvedBunVersion(tool: string, env: NodeJS.ProcessEnv = process.env): string {
	try {
		return execFileSync(tool, ["--version"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return `none (no ${tool} on PATH)`;
	}
}

/** Returns the webServer block unchanged, or throws before Playwright can start it under the wrong Bun. */
export function pinnedWebServer<T>(server: T, env: NodeJS.ProcessEnv = process.env): T {
	const pinned = readFileSync(join(REPO, ".bun-version"), "utf8").trim();
	const refusals = LANE_BUN_TOOLS.map((tool) => laneBunMismatch(tool, pinned, resolvedBunVersion(tool, env))).filter(Boolean);
	if (refusals.length > 0) throw new Error(refusals.join("\n"));
	return server;
}
