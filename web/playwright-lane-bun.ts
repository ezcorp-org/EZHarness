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
import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
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

/** The first executable named `tool` on env.PATH, as the webServer's shell would resolve it. */
function resolvedPath(tool: string, env: NodeJS.ProcessEnv): string {
	const executable = (path: string) => ((statSync(path, { throwIfNoEntry: false })?.mode ?? 0) & 0o111) !== 0;
	const dir = (env.PATH ?? "").split(delimiter).find((entry) => executable(join(entry, tool)));
	return dir === undefined ? `no ${tool}` : join(dir, tool);
}

/**
 * Returns the webServer block unchanged, or throws before Playwright can start it under the wrong Bun. On a
 * pass the main Playwright process prints one "lane Bun:" line naming what was asserted and the runner's own
 * runtime, so the lane log records them (workers load the config again and stay silent).
 */
export function pinnedWebServer<T>(server: T, env: NodeJS.ProcessEnv = process.env, print: (line: string) => void = console.error): T {
	const pinned = readFileSync(join(REPO, ".bun-version"), "utf8").trim();
	const resolved = LANE_BUN_TOOLS.map((tool) => ({ tool, version: resolvedBunVersion(tool, env) }));
	const refusals = resolved.map(({ tool, version }) => laneBunMismatch(tool, pinned, version)).filter(Boolean);
	if (refusals.length > 0) throw new Error(refusals.join("\n"));
	if (env.TEST_WORKER_INDEX === undefined) {
		const tools = resolved.map(({ tool, version }) => `${tool} ${version} (${resolvedPath(tool, env)})`).join(", ");
		const runner = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
		print(`lane Bun: ${tools}; Playwright runner ${runner} (${process.execPath})`);
	}
	return server;
}
