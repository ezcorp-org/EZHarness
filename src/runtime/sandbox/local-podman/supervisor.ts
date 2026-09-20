import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type {
	ProviderCall,
	SandboxProcess,
	SandboxProcessCancelInput,
	SandboxProcessCancelResult,
	SandboxProcessInspectInput,
	SandboxProcessInspectResult,
	SandboxProcessOutputChunk,
	SandboxProcessReadOutputInput,
	SandboxProcessReadOutputResult,
	SandboxProcessStartInput,
	SandboxProcessStartResult,
} from "@ezcorp/extension-contract";
import { validateProviderMethodValue } from "@ezcorp/extension-contract";
import { runBoundedCommand } from "./commands";

export interface OwnedProcessResource {
	resourceId: string;
	containerId: string;
	containerName: string;
	scope: ProviderCall["scope"];
	processRoot: string;
	bootId: string;
}

export interface LocalProcessSupervisorConfig {
	stateRoot: string;
	podmanPath: string;
	supervisorPath: string;
	maxOutputBytes: number;
	workspaceUid: number;
	workspaceGid: number;
}

export interface SupervisorLaunch {
	version: 1;
	podmanPath: string;
	containerId: string;
	containerName: string;
	identity: { bootId: string; processId: string };
	argv: string[];
	env: Record<string, string>;
	cwd: string;
	timeoutMs: number;
	maxOutputBytes: number;
	workspaceUid: number;
	workspaceGid: number;
	statusPath: string;
	cancelPath: string;
}

export interface SupervisorStatus {
	version: 1;
	identity: { bootId: string; processId: string };
	state: SandboxProcess["state"];
	startedAt: number;
	deadlineAt: number;
	helperPid: number;
	helperStartTime: string;
	exitCode?: number;
	outputCursor: number;
	gap: boolean;
	chunks: Array<{ cursor: number; stream: "stdout" | "stderr"; data: string; byteLength: number }>;
}

type ResolveOwnedResource = (resourceId: string) => Promise<OwnedProcessResource>;
type LaunchDetached = (argv: string[]) => void;

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_STATUS_BYTES = 2 * 1024 * 1024;

function receipt(call: ProviderCall) {
	return { operationId: call.operationId, idempotencyKey: call.idempotencyKey, requestDigest: call.requestDigest, outcome: "succeeded" as const };
}

function failure(call: ProviderCall, code: string, message: string, outcome: "failed" | "unknown" = "failed") {
	return { receipt: { operationId: call.operationId, idempotencyKey: call.idempotencyKey, requestDigest: call.requestDigest, outcome, error: { code, message, retryable: outcome === "unknown" } } };
}

function assertConfig(config: LocalProcessSupervisorConfig): LocalProcessSupervisorConfig {
	const stateRoot = resolve(config.stateRoot);
	if (!stateRoot.startsWith(sep) || !config.podmanPath.startsWith(sep) || !config.supervisorPath.startsWith(sep)) throw new Error("Supervisor paths must be absolute");
	if (!Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes < 1 || config.maxOutputBytes > 1024 * 1024) throw new Error("Invalid supervisor output limit");
	if (!Number.isSafeInteger(config.workspaceUid) || config.workspaceUid < 1 || config.workspaceUid > 2_147_483_647 || !Number.isSafeInteger(config.workspaceGid) || config.workspaceGid < 1 || config.workspaceGid > 2_147_483_647) throw new Error("Invalid workspace UID/GID");
	return Object.freeze({ ...config, stateRoot });
}

function assertOwned(config: LocalProcessSupervisorConfig, value: OwnedProcessResource, input: { resourceId: string; call: ProviderCall }): void {
	if (value.resourceId !== input.resourceId || !ID.test(value.containerId) || !ID.test(value.containerName) || !ID.test(value.bootId)) throw new Error("Invalid owned resource identity");
	if (value.scope.projectId !== input.call.scope.projectId || value.scope.bindingId !== input.call.scope.bindingId || value.scope.generation !== input.call.scope.generation) throw new Error("Resource scope mismatch");
	const processRoot = resolve(value.processRoot);
	if (!processRoot.startsWith(`${config.stateRoot}${sep}`)) throw new Error("Process root escaped state root");
}

async function atomicJson(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${crypto.randomUUID()}.tmp`;
	let handle: FileHandle | undefined;
	try {
		handle = await open(temporary, "wx", 0o600);
		await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = undefined;
		await rename(temporary, path); await chmod(path, 0o600);
		const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
	} finally { await handle?.close().catch(() => undefined); await rm(temporary, { force: true }).catch(() => undefined); }
}

async function readStatus(path: string): Promise<SupervisorStatus> {
	const info = await stat(path);
	if (!info.isFile() || info.size > MAX_STATUS_BYTES || (info.mode & 0o077) !== 0) throw new Error("Invalid supervisor status artifact");
	const value = JSON.parse(await readFile(path, "utf8")) as SupervisorStatus;
	if (value.version !== 1 || !ID.test(value.identity.bootId) || !ID.test(value.identity.processId) || !Array.isArray(value.chunks)) throw new Error("Invalid supervisor status");
	return value;
}

async function processStartTime(pid: number): Promise<string | undefined> {
	if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
	try { const value = await readFile(`/proc/${pid}/stat`, "utf8"); return value.slice(value.lastIndexOf(") ") + 2).split(" ")[19]; } catch { return undefined; }
}

function asProcess(status: SupervisorStatus): SandboxProcess {
	return { identity: status.identity, state: status.state, ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }), outputCursor: status.outputCursor };
}

export function launchDetachedSupervisor(argv: string[]): void {
	const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	child.unref();
}

export class LocalProcessSupervisor {
	private readonly config: LocalProcessSupervisorConfig;
	constructor(config: LocalProcessSupervisorConfig, private readonly resolveOwnedResource: ResolveOwnedResource, private readonly launchDetached: LaunchDetached = launchDetachedSupervisor) { this.config = assertConfig(config); }

	private paths(resource: OwnedProcessResource) {
		return { launch: `${resource.processRoot}/launch.json`, status: `${resource.processRoot}/status.json`, cancel: `${resource.processRoot}/cancel` };
	}

	private async owned(input: { resourceId: string; call: ProviderCall }): Promise<OwnedProcessResource> {
		const resource = await this.resolveOwnedResource(input.resourceId);
		assertOwned(this.config, resource, input);
		return resource;
	}

	private async stopAndVerify(resource: OwnedProcessResource): Promise<boolean> {
		await runBoundedCommand([this.config.podmanPath, "--remote=false", "stop", "--time", "1", resource.containerId], { timeoutMs: 10_000, maxOutputBytes: 4096 });
		const inspected = await runBoundedCommand([this.config.podmanPath, "--remote=false", "inspect", "--format", "{{.Id}} {{.State.Running}}", resource.containerId], { timeoutMs: 10_000, maxOutputBytes: 4096 });
		return !inspected.timedOut && inspected.code === 0 && inspected.stdout.trim() === `${resource.containerId} false`;
	}

	private async recover(resource: OwnedProcessResource, status: SupervisorStatus, path: string): Promise<SupervisorStatus> {
		if (status.state !== "starting" && status.state !== "running") return status;
		if (status.state === "starting" && status.helperPid === 0 && Date.now() <= Math.min(status.deadlineAt, status.startedAt + 5_000)) return status;
		const liveStart = await processStartTime(status.helperPid);
		if (status.identity.bootId === resource.bootId && liveStart !== undefined && liveStart === status.helperStartTime) return status;
		await this.stopAndVerify(resource);
		const recovered = { ...status, state: "unknown" as const };
		await atomicJson(path, recovered);
		return recovered;
	}

	async start(input: SandboxProcessStartInput): Promise<SandboxProcessStartResult> {
		validateProviderMethodValue("sandbox.process.v1", "start", "input", input);
		try {
			const resource = await this.owned(input);
			const paths = this.paths(resource);
			await mkdir(resource.processRoot, { recursive: true, mode: 0o700 });
			await chmod(resource.processRoot, 0o700);
			const lockPath = `${resource.processRoot}/start.lock`;
			let lock: FileHandle;
			try { lock = await open(lockPath, "wx", 0o600); } catch { return failure(input.call, "process_busy", "A process start is already in progress"); }
			try {
				try {
					const current = await readStatus(paths.status);
					if (current.state === "starting" || current.state === "running") return failure(input.call, "process_busy", "The resource already has a managed process");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") return failure(input.call, "process_state_unknown", "The prior process state cannot be verified", "unknown");
				}
				await rm(paths.cancel, { force: true });
				const identity = { bootId: resource.bootId, processId: crypto.randomUUID() };
				const launch: SupervisorLaunch = { version: 1, podmanPath: this.config.podmanPath, containerId: resource.containerId, containerName: resource.containerName, identity, argv: input.argv, env: input.env, cwd: input.cwd, timeoutMs: input.timeoutMs, maxOutputBytes: this.config.maxOutputBytes, workspaceUid: this.config.workspaceUid, workspaceGid: this.config.workspaceGid, statusPath: paths.status, cancelPath: paths.cancel };
				await atomicJson(paths.launch, launch);
				const now = Date.now();
				await atomicJson(paths.status, { version: 1, identity, state: "starting", startedAt: now, deadlineAt: now + input.timeoutMs, helperPid: 0, helperStartTime: "pending", outputCursor: 0, gap: false, chunks: [] } satisfies SupervisorStatus);
				this.launchDetached([this.config.supervisorPath, paths.launch]);
				return { receipt: receipt(input.call), process: { identity, state: "starting", outputCursor: 0 } };
			} finally {
				await lock.close(); await rm(lockPath, { force: true });
			}
		} catch (error) { return failure(input.call, "process_start_failed", error instanceof Error ? error.message : "Process start failed"); }
	}

	async inspect(input: SandboxProcessInspectInput): Promise<SandboxProcessInspectResult> {
		validateProviderMethodValue("sandbox.process.v1", "inspect", "input", input);
		try {
			const resource = await this.owned(input); const path = this.paths(resource).status; const stored = await readStatus(path);
			if (stored.identity.bootId !== input.identity.bootId || stored.identity.processId !== input.identity.processId) return failure(input.call, "process_not_found", "Process identity does not match");
			const status = await this.recover(resource, stored, path);
			return { receipt: receipt(input.call), process: asProcess(status) };
		} catch { return failure(input.call, "process_unknown", "Process state cannot be verified", "unknown"); }
	}

	async readOutput(input: SandboxProcessReadOutputInput): Promise<SandboxProcessReadOutputResult> {
		validateProviderMethodValue("sandbox.process.v1", "readOutput", "input", input);
		try {
			const resource = await this.owned(input); const status = await readStatus(this.paths(resource).status);
			if (status.identity.bootId !== input.identity.bootId || status.identity.processId !== input.identity.processId || input.cursor > status.outputCursor) return failure(input.call, "process_not_found", "Process output identity or cursor does not match");
			let budget = input.maxBytes; let cursor = input.cursor; const chunks: SandboxProcessOutputChunk[] = [];
			for (const chunk of status.chunks) {
				if (chunks.length >= 256) break;
				const end = chunk.cursor + chunk.byteLength; if (end <= cursor || budget === 0) continue;
				const bytes = Buffer.from(chunk.data, "base64"); const offset = Math.max(0, cursor - chunk.cursor); const selected = bytes.subarray(offset, offset + budget);
				if (selected.byteLength) { chunks.push({ stream: chunk.stream, encoding: "base64", data: selected.toString("base64") }); cursor += selected.byteLength; budget -= selected.byteLength; }
			}
			return { receipt: receipt(input.call), identity: status.identity, cursor, chunks, eof: status.state !== "starting" && status.state !== "running" && cursor === status.outputCursor, gap: status.gap };
		} catch { return failure(input.call, "process_output_unknown", "Process output cannot be verified", "unknown"); }
	}

	async cancel(input: SandboxProcessCancelInput): Promise<SandboxProcessCancelResult> {
		validateProviderMethodValue("sandbox.process.v1", "cancel", "input", input);
		try {
			const resource = await this.owned(input); const paths = this.paths(resource); const status = await readStatus(paths.status);
			if (status.identity.bootId !== input.identity.bootId || status.identity.processId !== input.identity.processId) return failure(input.call, "process_not_found", "Process identity does not match");
			await writeFile(paths.cancel, input.identity.processId, { mode: 0o600 });
			for (let attempts = 0; attempts < 400; attempts += 1) {
				const current = await readStatus(paths.status);
				if (current.state !== "starting" && current.state !== "running") return { receipt: receipt(input.call), process: asProcess(current) };
				await Bun.sleep(5);
			}
			return failure(input.call, "process_cancel_unknown", "Cancellation did not reach a verified terminal state", "unknown");
		} catch { return failure(input.call, "process_cancel_unknown", "Cancellation cannot be verified", "unknown"); }
	}
}
