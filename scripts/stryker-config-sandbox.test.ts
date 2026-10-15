import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = resolve(repoRoot, "web");

test("Stryker can load the copied Svelte config without the root build helper", async () => {
	const tempRoot = resolve(webRoot, ".stryker-tmp");
	await mkdir(tempRoot, { recursive: true });
	const sandbox = await mkdtemp(resolve(tempRoot, "sandbox-config-"));
	try {
		const config = resolve(sandbox, "svelte.config.js");
		await copyFile(resolve(webRoot, "svelte.config.js"), config);
		expect(existsSync(resolve(tempRoot, "scripts/ensure-bun-websocket-hook.js"))).toBe(false);
		const script = "import { pathToFileURL } from 'node:url'; const config = await import(pathToFileURL(process.argv[1]).href); if (typeof config.default?.kit?.adapter?.adapt !== 'function') process.exit(2);";
		const result = spawnSync("node", ["--input-type=module", "-e", script, config], { encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
});

test("the pinned Stryker runner uses Vitest's nested suite separator", async () => {
	const helper = resolve(webRoot, "node_modules/@stryker-mutator/vitest-runner/dist/src/test-helpers.js");
	const { collectTestName, toRawTestId, VITEST_5_TEST_NAME_SEPARATOR } = await import(pathToFileURL(helper).href);
	const file = { filepath: "/tmp/example.test.ts" };
	const outer = { name: "outer [A+B]" };
	const inner = { name: "nested (x)", suite: outer };
	const task = { name: "case #1 > literal [x]", suite: inner, file };
	const name = "outer [A+B] > nested (x) > case #1 > literal [x]";
	expect(collectTestName(task, VITEST_5_TEST_NAME_SEPARATOR)).toBe(name);
	expect(toRawTestId(task, VITEST_5_TEST_NAME_SEPARATOR)).toBe(`${file.filepath}#${name}`);
	const legacyName = "outer [A+B] nested (x) case #1 > literal [x]";
	expect(collectTestName(task)).toBe(legacyName);
	expect(toRawTestId(task)).toBe(`${file.filepath}#${legacyName}`);

	const runnerModule = resolve(webRoot, "node_modules/@stryker-mutator/vitest-runner/dist/src/vitest-test-runner.js");
	const { VitestTestRunner } = await import(pathToFileURL(runnerModule).href);
	const runner = new VitestTestRunner({ vitest: { related: false } }, {}, "__stryker__");
	runner.ctx = {
		config: {}, projects: [],
		state: { filesMap: new Map(), errorsSet: new Set(), getFiles: () => [{ ...file, tasks: [{ ...task, type: "test", result: { state: "pass" } }] }] },
		start: async () => {},
	};
	const result = await runner.run();
	expect(result.tests).toMatchObject([{ name }]);
	expect(result.tests[0].id).toEndWith(`#${name}`);
});
