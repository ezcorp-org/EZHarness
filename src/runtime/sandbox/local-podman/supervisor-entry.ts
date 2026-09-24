import { chmod, open, readFile, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { SupervisorCancellation, SupervisorLaunch, SupervisorStatus } from "./supervisor";
import { runBoundedCommand } from "./commands";

const MAX_LAUNCH_BYTES = 128 * 1024;
const MAX_CANCELLATION_BYTES = 1024;

async function atomicStatus(path: string, value: SupervisorStatus): Promise<void> {
	const temporary = `${path}.${crypto.randomUUID()}.tmp`;
	let handle: FileHandle | undefined;
	try {
		handle = await open(temporary, "wx", 0o600); await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = undefined;
		await rename(temporary, path); await chmod(path, 0o600);
		const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
	} finally { await handle?.close().catch(() => undefined); await rm(temporary, { force: true }).catch(() => undefined); }
}

async function stopped(launch: SupervisorLaunch): Promise<boolean> {
	const result = await runBoundedCommand([launch.podmanPath, "--remote=false", "inspect", "--format", "{{.Id}} {{.State.Running}}", launch.containerId], { timeoutMs: 10_000, maxOutputBytes: 4096 });
	return !result.timedOut && result.code === 0 && result.stdout.trim() === `${launch.containerId} false`;
}

async function ownedAndRunning(launch: SupervisorLaunch): Promise<boolean> {
	const result = await runBoundedCommand([launch.podmanPath, "--remote=false", "inspect", "--format", "{{.Id}} {{.Name}} {{.State.Running}}", launch.containerId], { timeoutMs: 10_000, maxOutputBytes: 4096 });
	return !result.timedOut && result.code === 0 && result.stdout.trim() === `${launch.containerId} ${launch.containerName} true`;
}

async function stopAndVerify(launch: SupervisorLaunch): Promise<boolean> {
	await runBoundedCommand([launch.podmanPath, "--remote=false", "stop", "--time", "1", launch.containerId], { timeoutMs: 10_000, maxOutputBytes: 4096 });
	if (await stopped(launch)) return true;
	await runBoundedCommand([launch.podmanPath, "--remote=false", "kill", launch.containerId], { timeoutMs: 10_000, maxOutputBytes: 4096 });
	return stopped(launch);
}

async function helperStartTime(): Promise<string> {
	const value = await readFile(`/proc/${process.pid}/stat`, "utf8");
	return value.slice(value.lastIndexOf(") ") + 2).split(" ")[19] ?? "unknown";
}

async function cancellationRequested(launch: SupervisorLaunch): Promise<boolean> {
	try {
		const info = await stat(launch.cancelPath);
		if (!info.isFile() || info.size > MAX_CANCELLATION_BYTES || (info.mode & 0o077) !== 0) return false;
		const cancellation = JSON.parse(await readFile(launch.cancelPath, "utf8")) as SupervisorCancellation;
		return cancellation.version === 1 && cancellation.identity.bootId === launch.identity.bootId && cancellation.identity.processId === launch.identity.processId;
	} catch { return false; }
}

export async function runSupervisorEntry(launchPath: string): Promise<void> {
	const info = await stat(launchPath);
	if (!info.isFile() || info.size > MAX_LAUNCH_BYTES || (info.mode & 0o077) !== 0) throw new Error("Invalid supervisor launch artifact");
	const launch = JSON.parse(await readFile(launchPath, "utf8")) as SupervisorLaunch;
	if (launch.version !== 1 || !launch.podmanPath.startsWith("/") || !launch.statusPath.startsWith("/") || !launch.cancelPath.startsWith("/")) throw new Error("Invalid supervisor launch");
	const startedAt = Date.now();
	const status: SupervisorStatus = { version: 1, identity: launch.identity, call: launch.call, state: "running", startedAt, deadlineAt: startedAt + launch.timeoutMs, helperPid: process.pid, helperStartTime: await helperStartTime(), outputCursor: 0, gap: false, chunks: [] };
	let writes = Promise.resolve(); const persist = () => { writes = writes.then(() => atomicStatus(launch.statusPath, status)); return writes; };
	await persist();
	if (!(await ownedAndRunning(launch))) { await stopAndVerify(launch); status.state = "unknown"; await persist(); return; }
	const envArgs = Object.entries(launch.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
	const child = Bun.spawn([launch.podmanPath, "--remote=false", "exec", "--user", `${launch.workspaceUid}:${launch.workspaceGid}`, "--workdir", launch.cwd, ...envArgs, launch.containerId, ...launch.argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let written = 0;
	const capture = (stream: "stdout" | "stderr", source: ReadableStream<Uint8Array>) => {
		const reader = source.getReader();
		const done = (async () => {
			try {
				while (true) {
					const item = await reader.read(); if (item.done) break;
					const allowed = Math.max(0, launch.maxOutputBytes - written); const bytes = item.value.subarray(0, allowed);
					if (bytes.byteLength && status.chunks.length < 1024) { status.chunks.push({ cursor: status.outputCursor, stream, data: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength }); status.outputCursor += bytes.byteLength; written += bytes.byteLength; await persist(); }
					if (bytes.byteLength !== item.value.byteLength || status.chunks.length >= 1024) status.gap = true;
				}
			} finally { reader.releaseLock(); }
		})();
		return { done, cancel: () => reader.cancel().catch(() => undefined) };
	};
	const output = [capture("stdout", child.stdout), capture("stderr", child.stderr)];
	let cancelled = false; let timedOut = false;
	let childDone = false;
	const watcher = (async () => {
		while (!childDone) {
			await Bun.sleep(25);
			timedOut = Date.now() >= status.deadlineAt;
			cancelled = await cancellationRequested(launch);
			if (timedOut || cancelled) {
				if (!(await stopAndVerify(launch))) { status.state = "unknown"; await persist(); }
				try { child.kill("SIGKILL"); } catch { await Promise.resolve(); }
				return;
			}
		}
	})();
	const exitCode = await child.exited; childDone = true; await watcher;
	cancelled ||= await cancellationRequested(launch);
	timedOut ||= Date.now() >= status.deadlineAt;
	const isStopped = await stopAndVerify(launch);
	await Promise.race([Promise.all(output.map(item => item.done.catch(() => undefined))), Bun.sleep(100)]);
	await Promise.all(output.map(item => item.cancel()));
	await Promise.all(output.map(item => item.done.catch(() => undefined)));
	status.state = isStopped ? (cancelled || timedOut ? "cancelled" : exitCode === 0 ? "exited" : "failed") : "unknown";
	status.exitCode = exitCode; await persist();
}

export async function supervisorEntryMain(argv = process.argv): Promise<void> {
	const launchPath = argv[2];
	if (!launchPath) throw new Error("Missing supervisor launch path");
	await runSupervisorEntry(launchPath);
}

if (import.meta.main) await supervisorEntryMain();
