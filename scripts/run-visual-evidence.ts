#!/usr/bin/env bun
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type EvidenceSelection = { mode: "none" | "all" | "some"; specs: string[] };
export type EvidenceGroup = { name: "mock" | "real-auth"; commands: string[][] };

export function parseEvidenceSelection(text: string): EvidenceSelection {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (lines.length === 1 && lines[0] === "__NONE__") return { mode: "none", specs: [] };
	if (lines.length === 1 && lines[0] === "__ALL__") return { mode: "all", specs: [] };
	if (lines.length === 0 || lines.some((line) => line.startsWith("__"))) {
		throw new Error("Evidence selection is empty or contains an invalid sentinel");
	}
	return { mode: "some", specs: lines };
}

export function evidenceGroups(selection: EvidenceSelection, runnerReady = false): EvidenceGroup[] {
	if (selection.mode === "none") return [];
	const all = selection.mode === "all";
	const mock = all ? [] : selection.specs.filter((spec) => !spec.startsWith("e2e/real-auth/"));
	const real = all ? [] : selection.specs.filter((spec) => spec.startsWith("e2e/real-auth/"));
	const groups: EvidenceGroup[] = [];
	if (all || mock.length > 0) {
		groups.push({
			name: "mock",
			commands: [["bunx", "playwright", "test", "--project=chromium", "--grep", "@evidence", ...mock]],
		});
	}
	if (all || real.length > 0) {
		groups.push({
			name: "real-auth",
			commands: [
				...(!runnerReady ? [["bash", "../scripts/setup-extension-runner-ci.sh", "--probe"]] : []),
				["bunx", "playwright", "test", "--config", "playwright.real.config.ts", "--grep", "@evidence", ...real],
			],
		});
	}
	return groups;
}

export async function runEvidenceGroups(
	groups: EvidenceGroup[],
	run: (command: string[], group: EvidenceGroup["name"]) => Promise<number>,
): Promise<number> {
	let failed = false;
	for (const group of groups) {
		for (const command of group.commands) {
			let exit = 1;
			try {
				exit = await run(command, group.name);
			} catch (error) {
				console.error(`[visual-evidence:${group.name}] failed to start`, error);
			}
			if (exit !== 0) {
				failed = true;
				break;
			}
		}
	}
	return failed ? 1 : 0;
}

async function main(): Promise<void> {
	const selectionFile = process.argv[2];
	if (!selectionFile) throw new Error("usage: bun scripts/run-visual-evidence.ts <selection-file>");
	const selection = parseEvidenceSelection(await Bun.file(selectionFile).text());
	const groups = evidenceGroups(selection, process.env.EZCORP_EVIDENCE_RUNNER_READY === "1");
	const webRoot = process.env.EZCORP_VISUAL_EVIDENCE_WEB_ROOT ?? resolve(import.meta.dir, "../web");
	const reportRoot = await mkdtemp(join(tmpdir(), "ez-visual-evidence-"));
	const outputRoot = join(webRoot, "blob-report");
	await rm(outputRoot, { recursive: true, force: true });
	await mkdir(outputRoot, { recursive: true });
	let exit = 1;
	try {
		exit = await runEvidenceGroups(groups, async (command, group) => {
			console.log(`[visual-evidence:${group}] ${command.join(" ")}`);
			const proc = Bun.spawn(command, {
				cwd: webRoot,
				env: {
					...process.env,
					EZCORP_E2E_EVIDENCE: "1",
					PLAYWRIGHT_BLOB_OUTPUT_FILE: join(reportRoot, `${group}.zip`),
					...(group === "real-auth" ? { PI_E2E_REAL: "1" } : {}),
				},
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
			return proc.exited;
		});
		for (const group of groups) {
			const source = join(reportRoot, `${group.name}.zip`);
			if (await Bun.file(source).exists()) {
				await copyFile(source, join(outputRoot, `${group.name}.zip`));
			}
		}
	} finally {
		await rm(reportRoot, { recursive: true, force: true });
	}
	process.exit(exit);
}

if (import.meta.main) await main();
