/**
 * The `$server` alias inside Stryker's sandbox (web/vitest.stryker.config.ts).
 *
 * Stryker copies web/ into web/.stryker-tmp/sandbox-* and loads the Vitest
 * config there. vitest.config.ts maps `$server` to "../src" next to itself, which
 * in the sandbox is web/.stryker-tmp/src: a folder that does not exist. Every
 * test that reaches the repository's src/ through `$server` then failed to load,
 * and its mutants "survived" with no test run. W4H-33b: the PR mutation job on
 * send-message.ts (21 mutants), whose test reaches
 * `$server/runtime/routing/default-selection` through model-selector-logic.ts.
 *
 * These cases load the real config files from a sandbox-shaped folder, as
 * Stryker does, and check where `$server` points.
 */
// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WEB = resolve(import.meta.dirname, "../..");
const REPOSITORY_SOURCE = resolve(WEB, "../src");
const PROBE = "runtime/routing/default-selection.ts";
const CONFIGS = ["vitest.config.ts", "vitest.stryker.config.ts", "stryker.config.json"] as const;
const TEMP_ROOT = join(WEB, ".stryker-tmp");
const tempRootExisted = existsSync(TEMP_ROOT);
const sandboxes: string[] = [];

afterAll(() => {
	for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
	if (!tempRootExisted && readdirSync(TEMP_ROOT).length === 0) rmSync(TEMP_ROOT, { recursive: true });
});

type AliasConfig = { resolve?: { alias?: Record<string, string> } };

async function serverAlias(configFile: string): Promise<string | undefined> {
	const config = (await import(pathToFileURL(configFile).href)).default as AliasConfig;
	return config.resolve?.alias?.$server;
}

function strykerSandbox(): string {
	mkdirSync(TEMP_ROOT, { recursive: true });
	const sandbox = mkdtempSync(join(TEMP_ROOT, "sandbox-alias-probe-"));
	sandboxes.push(sandbox);
	for (const file of CONFIGS) copyFileSync(join(WEB, file), join(sandbox, file));
	return sandbox;
}

describe("vitest.stryker.config.ts $server alias", () => {
	it("points at the repository's src/ when Stryker loads it from its sandbox", async () => {
		const alias = await serverAlias(join(strykerSandbox(), "vitest.stryker.config.ts"));
		expect(alias).toBe(REPOSITORY_SOURCE);
		expect(existsSync(join(alias ?? "", PROBE))).toBe(true);
	});

	it("points at the same src/ when loaded in place", async () => {
		expect(await serverAlias(join(WEB, "vitest.stryker.config.ts"))).toBe(REPOSITORY_SOURCE);
	});
});
