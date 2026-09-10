/**
 * E2E — deterministic v4 extension acceptance at the CLI boundary.
 *
 * The CLI talks to a separately started rootless runner over its authenticated
 * Unix socket. These tests therefore cover the same isolated build path that
 * accepts source for a release; they do not replace it with a mock runner.
 */

import { test, expect } from "./fixtures/hydration.js";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import type { BuildResult } from "@ezcorp/extension-contract";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const HARNESS_DIR = join(REPO_ROOT, "docs/extensions/examples/harness-smoke-test");
const RUNNER_READY_TIMEOUT_MS = 120_000;

interface StartedRunner {
	directory: string;
	child: ChildProcessByStdio<null, Readable, Readable>;
	clientEnv: Record<string, string>;
}

function runCli(args: string[], env: Record<string, string> = {}) {
	return spawnSync("bun", ["run", "index.ts", ...args], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, PI_SKIP_INIT: "1", ...env },
	});
}

function cliOutput(result: ReturnType<typeof runCli>): string {
	return `${result.stdout}\n${result.stderr}`;
}

function buildResult(result: ReturnType<typeof runCli>): BuildResult {
	const output = cliOutput(result);
	expect(result.error, output).toBeUndefined();
	expect(result.status, output).not.toBeNull();
	expect(result.stdout, output).not.toBe("");
	return JSON.parse(result.stdout) as BuildResult;
}

async function terminateRunner(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit").then(() => true);
	child.kill("SIGTERM");
	const graceful = await Promise.race([
		exited,
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
	]);
	if (graceful || child.exitCode !== null || child.signalCode !== null) return;
	const killed = once(child, "exit");
	child.kill("SIGKILL");
	await Promise.race([
		killed,
		new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
	]);
}

async function startRunner(): Promise<StartedRunner> {
	const directory = mkdtempSync(join(tmpdir(), "ezh-det-gate-"));
	chmodSync(directory, 0o700);
	const socket = join(directory, "runner.sock");
	const tokenFile = join(directory, "token");
	const env = {
		...process.env,
		EZ_EXTENSION_RUNNER_SOCKET: socket,
		EZ_EXTENSION_RUNNER_TOKEN_FILE: tokenFile,
		EZ_EXTENSION_RUNNER_STORE: join(directory, "store"),
	};
	const child = spawn("bash", ["scripts/start-extension-runner-e2e.sh"], {
		cwd: REPO_ROOT,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => { output += chunk; });
	child.stderr.on("data", (chunk: Buffer) => { output += chunk; });

	try {
		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + RUNNER_READY_TIMEOUT_MS;
			const timer = setInterval(() => {
				if (existsSync(socket) && existsSync(tokenFile)) {
					clearInterval(timer);
					resolve();
					return;
				}
				if (child.exitCode !== null || child.signalCode !== null) {
					clearInterval(timer);
					reject(new Error(`Extension runner stopped before readiness: ${output}`));
					return;
				}
				if (Date.now() >= deadline) {
					clearInterval(timer);
					reject(new Error(`Extension runner did not become ready: ${output}`));
				}
			}, 100);
		});
	} catch (error) {
		await terminateRunner(child);
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}

	const clientEnv = {
		EZCORP_EXTENSION_RUNNER_SOCKET: socket,
		EZCORP_EXTENSION_RUNNER_TOKEN: readFileSync(tokenFile, "utf8").trim(),
	};
	const probe = spawnSync("bun", ["-e", `
		const response = await fetch("http://localhost/v4/inspect", {
			unix: process.env.EZCORP_EXTENSION_RUNNER_SOCKET,
			method: "POST",
			headers: { authorization: \`Bearer \${process.env.EZCORP_EXTENSION_RUNNER_TOKEN}\`, "content-type": "application/json" },
			body: JSON.stringify({ id: "readiness-probe" }),
		});
		if (!response.ok || (await response.json()).state !== "unknown") process.exit(1);
	`], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: 5_000,
		env: { ...process.env, ...clientEnv },
	});
	if (probe.status !== 0) {
		await stopRunner({ directory, child, clientEnv });
		throw new Error(`Extension runner readiness probe failed: ${probe.stdout}\n${probe.stderr}`);
	}

	return {
		directory,
		child,
		clientEnv,
	};
}

async function stopRunner(runner: StartedRunner | undefined): Promise<void> {
	if (!runner) return;
	await terminateRunner(runner.child);
	rmSync(runner.directory, { recursive: true, force: true });
}

test.describe("deterministic extension-build gate (CLI surface)", () => {
	let runner: StartedRunner | undefined;

	test.beforeAll(async () => {
		runner = await startRunner();
	});

	test.afterAll(async () => {
		await stopRunner(runner);
	});

	test("canonical source completes the authenticated isolated v4 build", () => {
		const cli = runCli([
			"ext",
			"verify",
			"./docs/extensions/examples/harness-smoke-test",
			"--json",
		], runner!.clientEnv);
		expect(cli.status, cliOutput(cli)).toBe(0);
		const result = buildResult(cli);

		expect(result.state).toBe("succeeded");
		expect(result.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(result.diagnostics).toEqual([]);
		expect(result.manifest).toMatchObject({
			schemaVersion: 4,
			name: "harness-smoke-test",
			smokeTest: { tool: "ping", expect: { textIncludes: '"ok": true' } },
		});
		expect(result.evidence).toMatchObject({ protocolVersion: 4, validatorVersion: "runner-v4.1" });
		expect(result.evidence.tests).toEqual([
			{ name: "typecheck", passed: true },
			{ name: "compile", passed: true },
			{ name: "feature:extension.test.ts", passed: true },
			{ name: "feature:index.test.ts", passed: true },
			{ name: "metadata-discovery", passed: true },
		]);
	});

	test("a source whose own feature test fails is rejected by the isolated runner", () => {
		const directory = mkdtempSync(join(tmpdir(), "harness-feature-fail-"));
		try {
			cpSync(HARNESS_DIR, directory, { recursive: true });
			const testFile = join(directory, "index.test.ts");
			const source = readFileSync(testFile, "utf8");
			const broken = source.replace('expect(text).toContain(\'"ok": true\');', 'expect(text).toContain("never emitted by ping");');
			expect(broken).not.toBe(source);
			writeFileSync(testFile, broken);

			const cli = runCli(["ext", "verify", directory, "--json"], runner!.clientEnv);
			expect(cli.status, cliOutput(cli)).toBe(1);
			const result = buildResult(cli);
			expect(result.state).toBe("failed");
			expect(result.artifactDigest).toBeUndefined();
			expect(result.diagnostics).toEqual([
				expect.objectContaining({
				code: "command_failed",
				stage: "runner",
				message: expect.stringContaining("never emitted by ping"),
			}),
		]);
			expect(result.evidence.tests).toEqual([
				{ name: "typecheck", passed: true },
				{ name: "compile", passed: true },
				{ name: "feature:extension.test.ts", passed: true },
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("ext install --yes remains blocked before any unattended approval", () => {
		const result = runCli([
			"ext",
			"install",
			"./docs/extensions/examples/harness-smoke-test",
			"--yes",
		], runner!.clientEnv);
		const output = cliOutput(result);
		expect(result.status, output).toBe(1);
		expect(output).toContain("--yes cannot approve an extension. Review the exact tested release in a human session.");
		expect(output).not.toMatch(/Failed query|insert into "extensions"|duplicate key value/i);
	});
});
