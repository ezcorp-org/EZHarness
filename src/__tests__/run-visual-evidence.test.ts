import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	evidenceGroups,
	parseEvidenceSelection,
	runEvidenceGroups,
} from "../../scripts/run-visual-evidence";

describe("visual evidence runner", () => {
	test("partitions selected mock and real-auth specs into their correct configs", () => {
		const groups = evidenceGroups(parseEvidenceSelection([
			"e2e/import-wizard\\.spec\\.ts",
			"e2e/real-auth/extension-browser-scanner\\.spec\\.ts",
		].join("\n")));
		expect(groups).toEqual([
			{
				name: "mock",
				commands: [["bunx", "playwright", "test", "--project=chromium", "--grep", "@evidence", "e2e/import-wizard\\.spec\\.ts"]],
			},
			{
				name: "real-auth",
				commands: [
					["bash", "../scripts/setup-extension-runner-ci.sh", "--probe"],
					["bunx", "playwright", "test", "--config", "playwright.real.config.ts", "--grep", "@evidence", "e2e/real-auth/extension-browser-scanner\\.spec\\.ts"],
				],
			},
		]);
	});

	test("the all fallback runs both suites and trusts a runner prepared in the parent process", () => {
		const groups = evidenceGroups(parseEvidenceSelection("__ALL__\n"), true);
		expect(groups.map((group) => group.name)).toEqual(["mock", "real-auth"]);
		expect(groups[1]?.commands).toEqual([
			["bunx", "playwright", "test", "--config", "playwright.real.config.ts", "--grep", "@evidence"],
		]);
	});

	test("a failed group does not hide the other group and returns failure", async () => {
		const calls: string[] = [];
		const exit = await runEvidenceGroups(evidenceGroups({ mode: "all", specs: [] }), async (_command, group) => {
			calls.push(group);
			return group === "mock" ? 1 : 0;
		});
		expect(exit).toBe(1);
		expect(calls).toEqual(["mock", "real-auth", "real-auth"]);
	});

	test("a command that cannot start does not hide the other group", async () => {
		const calls: string[] = [];
		const exit = await runEvidenceGroups(evidenceGroups({ mode: "all", specs: [] }, true), async (_command, group) => {
			calls.push(group);
			if (group === "mock") throw new Error("missing executable");
			return 0;
		});
		expect(exit).toBe(1);
		expect(calls).toEqual(["mock", "real-auth"]);
	});

	test("rejects empty and mixed sentinel selections", () => {
		expect(() => parseEvidenceSelection("\n")).toThrow();
		expect(() => parseEvidenceSelection("__ALL__\ne2e/a.spec.ts\n")).toThrow();
	});

	async function runCliCase(realExit: number) {
		const root = await mkdtemp(join(tmpdir(), "visual-evidence-cli-"));
		const bin = join(root, "bin");
		const web = join(root, "web");
		await mkdir(bin);
		await mkdir(join(web, "blob-report"), { recursive: true });
		await writeFile(join(web, "blob-report/stale.zip"), "stale");
		const log = join(root, "calls.log");
		const stub = join(bin, "bunx");
		await writeFile(stub, `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "$EZCORP_EVIDENCE_RUNNER_READY" "$PI_E2E_REAL" >> '${log}'\nprintf report > "$PLAYWRIGHT_BLOB_OUTPUT_FILE"\ncase "$*" in *playwright.real.config.ts*) exit ${realExit};; esac\n`);
		await chmod(stub, 0o755);
		const selection = join(root, "selection.txt");
		await writeFile(selection, "e2e/import-wizard\\.spec\\.ts\ne2e/real-auth/extension-browser-scanner\\.spec\\.ts\n");
		const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/run-visual-evidence.ts"), selection], {
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				EZCORP_VISUAL_EVIDENCE_WEB_ROOT: web,
				EZCORP_EVIDENCE_RUNNER_READY: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		return { root, web, log, exit: await proc.exited };
	}

	for (const [label, realExit, expectedExit] of [["success", 0, 0], ["real-auth failure", 7, 1]] as const) {
		test(`CLI ${label}: keeps both reports, clears stale output, and preserves config and environment`, async () => {
			const result = await runCliCase(realExit);
			try {
				expect(result.exit).toBe(expectedExit);
				expect(await Bun.file(join(result.web, "blob-report/mock.zip")).text()).toBe("report");
				expect(await Bun.file(join(result.web, "blob-report/real-auth.zip")).text()).toBe("report");
				expect(await Bun.file(join(result.web, "blob-report/stale.zip")).exists()).toBe(false);
				const calls = await Bun.file(result.log).text();
				expect(calls).toContain("--project=chromium");
				expect(calls).toContain("--config playwright.real.config.ts");
				expect(calls).toContain("|1|1");
			} finally {
				await rm(result.root, { recursive: true, force: true });
			}
		});
	}
});
