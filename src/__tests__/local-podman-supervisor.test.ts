import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dlopen, FFIType } from "bun:ffi";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderCall, SandboxProcessStartInput } from "@ezcorp/extension-contract";
import { flock, launchDetachedSupervisor, LocalProcessSupervisor, LOCK_RELEASE, type OwnedProcessResource } from "../runtime/sandbox/local-podman/supervisor";
import { runSupervisorEntry, supervisorEntryMain } from "../runtime/sandbox/local-podman/supervisor-entry";

const roots: string[] = [];
const bunExecutable = process.execPath;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const call: ProviderCall = { scope: { projectId: "project", bindingId: "binding", generation: 1 }, operationId: "operation", idempotencyKey: "key", requestDigest: "a".repeat(64) };

async function fixture(outputBytes = 12, stopFails = false) {
	const root = await mkdtemp(join(tmpdir(), "ez-supervisor-")); roots.push(root);
	const processRoot = join(root, "resource", "process"); await mkdir(processRoot, { recursive: true, mode: 0o700 });
	const runtimeState = join(root, "runtime-state"); await writeFile(runtimeState, "running");
	const descendantPid = join(root, "descendant-pid"); const execArgs = join(root, "exec-args"); const stopGate = join(root, "stop-gate");
	const podman = join(root, "podman");
	await writeFile(podman, `#!${bunExecutable}
import { readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2); const state = ${JSON.stringify(runtimeState)}; const descendantPid = ${JSON.stringify(descendantPid)};
if (args.includes("exec")) { await writeFile(${JSON.stringify(execArgs)}, JSON.stringify(args)); if (args.includes("utf8")) { process.stdout.write(new Uint8Array([0xe2])); await Bun.sleep(5); process.stdout.write(new Uint8Array([0x82, 0xac])); } else { process.stdout.write("abcdefghij"); process.stderr.write("KLMNOPQRST"); } if (args.includes("background")) { const child = Bun.spawn(["/bin/sh", "-c", "sleep 30"], { stdout: "inherit", stderr: "inherit" }); await writeFile(descendantPid, String(child.pid)); process.exit(0); } if (args.includes("identity-check")) process.exit(0); while ((await readFile(state, "utf8")) === "running") await Bun.sleep(5); process.exit(0); }
if (args.includes("stop") || args.includes("kill")) { if (${stopFails}) process.exit(1); while (await Bun.file(${JSON.stringify(stopGate)}).exists()) await Bun.sleep(5); await writeFile(state, "stopped"); try { process.kill(Number(await readFile(descendantPid, "utf8")), "SIGKILL"); } catch { await Promise.resolve(); } process.exit(0); }
if (args.includes("inspect")) { const running = (await readFile(state, "utf8")) === "running"; console.log(args.some(value => value.includes(".Name")) ? "containerid containername " + running : "containerid " + running); process.exit(0); }
process.exit(2);
`); await chmod(podman, 0o700);
	const resource: OwnedProcessResource = { resourceId: "resource", containerId: "containerid", containerName: "containername", scope: call.scope, processRoot, bootId: "boot-id" };
	const entries: Promise<void>[] = [];
	const config = { stateRoot: root, podmanPath: podman, supervisorPath: "/trusted/supervisor", maxOutputBytes: outputBytes, workspaceUid: 0, workspaceGid: 0 };
	const supervisor = new LocalProcessSupervisor(config, async () => resource, argv => { entries.push(runSupervisorEntry(argv[1]!)); });
	const input: SandboxProcessStartInput = { call, resourceId: "resource", argv: ["tool"], env: { SAFE: "yes" }, cwd: "/", user: "workspace", timeoutMs: 2_000 };
	return { root, processRoot, runtimeState, execArgs, stopGate, podman, resource, entries, supervisor, input, config };
}

async function terminal(f: Awaited<ReturnType<typeof fixture>>, identity: { bootId: string; processId: string }) {
	await Promise.all(f.entries);
	return f.supervisor.inspect({ call, resourceId: "resource", identity });
}

async function writeCancellation(processRoot: string, identity: { bootId: string; processId: string }): Promise<void> {
	await writeFile(join(processRoot, "cancel"), JSON.stringify({ version: 1, identity }), { mode: 0o600 });
}

describe("LocalProcessSupervisor", () => {
	test("runs one detached process, bounds output while reading, and stops descendants", async () => {
		const f = await fixture(); const started = await f.supervisor.start(f.input);
		expect(started.receipt.outcome).toBe("succeeded"); if (!("process" in started)) throw new Error("missing process");
		expect(await f.supervisor.start(f.input)).toEqual(started);
		expect(f.entries).toHaveLength(1);
		expect((await f.supervisor.start({ ...f.input, call: { ...call, requestDigest: "b".repeat(64) } })).receipt).toMatchObject({ outcome: "failed", error: { code: "idempotency_conflict" } });
		const busy = await f.supervisor.start({ ...f.input, call: { ...call, operationId: "other" } }); expect(busy.receipt.outcome).toBe("failed");
		await writeCancellation(f.processRoot, started.process.identity);
		const inspected = await terminal(f, started.process.identity); expect(inspected).toMatchObject({ receipt: { outcome: "succeeded" }, process: { state: "cancelled", outputCursor: 12 } });
		expect(await readFile(f.runtimeState, "utf8")).toBe("stopped");
		expect(JSON.parse(await readFile(f.execArgs, "utf8"))).toContain("0:0");
		const first = await f.supervisor.readOutput({ call, resourceId: "resource", identity: started.process.identity, cursor: 0, maxBytes: 5 });
		expect(first).toMatchObject({ receipt: { outcome: "succeeded" }, cursor: 5, eof: false, gap: true });
		const second = await f.supervisor.readOutput({ call, resourceId: "resource", identity: started.process.identity, cursor: 5, maxBytes: 20 });
		expect(second).toMatchObject({ cursor: 12, eof: true, gap: true });
		expect((first as { chunks: Array<{ data: string }> }).chunks.reduce((n, item) => n + Buffer.from(item.data, "base64").byteLength, 0)).toBe(5);
	});

	test("cancels through the host control artifact and rejects identity and scope swaps", async () => {
		const f = await fixture(64); const started = await f.supervisor.start(f.input); if (!("process" in started)) throw new Error("missing process");
		const wrong = { ...started.process.identity, processId: crypto.randomUUID() };
		expect((await f.supervisor.inspect({ call, resourceId: "resource", identity: wrong })).receipt.outcome).toBe("failed");
		expect((await f.supervisor.cancel({ call, resourceId: "resource", identity: wrong })).receipt.outcome).toBe("failed");
		const cancelled = await f.supervisor.cancel({ call, resourceId: "resource", identity: started.process.identity }); expect(cancelled.receipt.outcome).toBe("succeeded");
		expect((await terminal(f, started.process.identity))).toMatchObject({ process: { state: "cancelled" } });
		f.resource.scope = { ...call.scope, generation: 2 };
		expect((await f.supervisor.inspect({ call, resourceId: "resource", identity: started.process.identity })).receipt.outcome).toBe("unknown");
	});

	test("ignores a cancellation marker for a different exact process identity", async () => {
		const f = await fixture(64); const launches: string[][] = [];
		const supervisor = new LocalProcessSupervisor(f.config, async () => f.resource, argv => { launches.push(argv); });
		const wrongIdentities = [
			(identity: { bootId: string; processId: string }) => ({ bootId: "other-boot", processId: identity.processId }),
			(identity: { bootId: string; processId: string }) => ({ bootId: identity.bootId, processId: crypto.randomUUID() }),
		];
		for (const [index, wrongIdentity] of wrongIdentities.entries()) {
			await writeFile(f.runtimeState, "running");
			const processCall = { ...call, operationId: `identity-${index}`, idempotencyKey: `identity-${index}` };
			const started = await supervisor.start({ ...f.input, call: processCall, argv: ["identity-check"] }); if (!("process" in started)) throw new Error("missing process");
			const launch = launches.shift(); if (!launch) throw new Error("missing launch");
			await writeCancellation(f.processRoot, wrongIdentity(started.process.identity));
			await runSupervisorEntry(launch[1]!);
			expect(await supervisor.inspect({ call: processCall, resourceId: "resource", identity: started.process.identity })).toMatchObject({ receipt: { outcome: "succeeded" }, process: { state: "exited" } });
		}
	});

	test("serializes cancellation with later starts through the durable process lock", async () => {
		const f = await fixture(64); const started = await f.supervisor.start(f.input); if (!("process" in started)) throw new Error("missing process");
		for (let attempt = 0; attempt < 200 && !(await Bun.file(f.execArgs).exists()); attempt += 1) await Bun.sleep(5);
		await writeFile(f.stopGate, "hold");

		const lockPath = join(f.processRoot, "start.lock"); const readyPath = join(f.root, "lock-ready"); const releasePath = join(f.root, "lock-release"); const holderPath = join(f.root, "lock-holder.ts");
		await writeFile(holderPath, `import { open, writeFile } from "node:fs/promises";\nimport { dlopen, FFIType } from "bun:ffi";\nconst [lockPath, readyPath, releasePath] = process.argv.slice(2);\nif (!lockPath || !readyPath || !releasePath) throw new Error("missing lock arguments");\nconst handle = await open(lockPath, "a+", 0o600);\nconst libc = dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });\nif (libc.symbols.flock(handle.fd, 2) !== 0) throw new Error("lock failed");\nawait writeFile(readyPath, "ready");\nwhile (!(await Bun.file(releasePath).exists())) await Bun.sleep(5);\nlibc.symbols.flock(handle.fd, 8);\nawait handle.close();\nlibc.close();\n`);
		const holder = Bun.spawn([bunExecutable, holderPath, lockPath, readyPath, releasePath], { stdout: "pipe", stderr: "pipe" });
		let cancellation: ReturnType<LocalProcessSupervisor["cancel"]> | undefined;
		try {
			for (let attempt = 0; attempt < 200 && !(await Bun.file(readyPath).exists()); attempt += 1) await Bun.sleep(5);
			expect(await Bun.file(readyPath).exists()).toBe(true);
			let attemptedResolve!: () => void; const attempted = new Promise<void>(resolve => { attemptedResolve = resolve; });
			const supervisor = new LocalProcessSupervisor(f.config, async () => f.resource, argv => { f.entries.push(runSupervisorEntry(argv[1]!)); }, (descriptor, operation) => { attemptedResolve(); return flock(descriptor, operation); });
			cancellation = supervisor.cancel({ call, resourceId: "resource", identity: started.process.identity });
			await Promise.race([attempted, cancellation.then(() => { throw new Error("cancellation bypassed the held durable lock"); })]);
			expect(await Bun.file(join(f.processRoot, "cancel")).exists()).toBe(false);
			await writeFile(releasePath, "release");
			for (let attempt = 0; attempt < 200 && !(await Bun.file(join(f.processRoot, "cancel")).exists()); attempt += 1) await Bun.sleep(5);
			expect(await Bun.file(join(f.processRoot, "cancel")).exists()).toBe(true);
			const nextCall = { ...call, operationId: "next", idempotencyKey: "next" };
			expect((await supervisor.start({ ...f.input, call: nextCall })).receipt).toMatchObject({ outcome: "unknown", error: { code: "process_busy", retryable: true } });
			await rm(f.stopGate);
			expect((await cancellation).receipt.outcome).toBe("succeeded");
			expect(await Bun.file(join(f.processRoot, "cancel")).exists()).toBe(false);
			await writeFile(f.runtimeState, "running");
			const next = await supervisor.start({ ...f.input, call: nextCall }); if (!("process" in next)) throw new Error("missing next process");
			let nextState = next.process.state;
			for (let attempt = 0; attempt < 200 && nextState === "starting"; attempt += 1) {
				await Bun.sleep(5); const inspected = await supervisor.inspect({ call: nextCall, resourceId: "resource", identity: next.process.identity }); if ("process" in inspected) nextState = inspected.process.state;
			}
			expect(nextState).toBe("running");
			await supervisor.cancel({ call: nextCall, resourceId: "resource", identity: next.process.identity }); await Promise.all(f.entries);
		} finally {
			await rm(f.stopGate, { force: true }); await writeFile(releasePath, "release").catch(() => undefined); await holder.exited; await cancellation?.catch(() => undefined); await Promise.allSettled(f.entries);
		}
	});

	test("fails closed for invalid host configuration, state artifacts, and cursors", async () => {
		const f = await fixture();
		expect(() => new LocalProcessSupervisor({ stateRoot: "relative", podmanPath: f.input.argv[0]!, supervisorPath: "relative", maxOutputBytes: 0, workspaceUid: -1, workspaceGid: -1 }, async () => f.resource)).toThrow();
		const lockPath = join(f.processRoot, "start.lock"); const held = await open(lockPath, "a+", 0o600); const libc = dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }); expect(libc.symbols.flock(held.fd, 2 | 4)).toBe(0);
		expect((await f.supervisor.start(f.input)).receipt).toMatchObject({ outcome: "unknown", error: { code: "process_busy", retryable: true } }); libc.symbols.flock(held.fd, 8); await held.close(); libc.close();
		await writeFile(lockPath, "orphaned host crash artifact", { mode: 0o600 });
		const started = await f.supervisor.start(f.input); if (!("process" in started)) throw new Error("missing process");
		await writeCancellation(f.processRoot, started.process.identity); await terminal(f, started.process.identity);
		const badCursor = await f.supervisor.readOutput({ call, resourceId: "resource", identity: started.process.identity, cursor: 999, maxBytes: 1 }); expect(badCursor.receipt.outcome).toBe("failed");
		await chmod(join(f.processRoot, "status.json"), 0o644);
		expect((await f.supervisor.inspect({ call, resourceId: "resource", identity: started.process.identity })).receipt.outcome).toBe("unknown");
		await expect(supervisorEntryMain(["bun", "entry"])).rejects.toThrow("Missing supervisor launch path");
		const marker = join(f.root, "detached"); const child = join(f.root, "child");
		await writeFile(child, `#!${bunExecutable}\nawait Bun.write(${JSON.stringify(marker)}, "done");`); await chmod(child, 0o700);
		launchDetachedSupervisor([child]);
		for (let attempt = 0; attempt < 100 && !(await Bun.file(marker).exists()); attempt += 1) await Bun.sleep(5);
		expect(await readFile(marker, "utf8")).toBe("done");
	});

	test("enforces the durable deadline and safely recovers a dead helper", async () => {
		const f = await fixture(64); const started = await f.supervisor.start({ ...f.input, timeoutMs: 25 }); if (!("process" in started)) throw new Error("missing process");
		expect(await terminal(f, started.process.identity)).toMatchObject({ process: { state: "cancelled" } });
		await writeFile(f.runtimeState, "running");
		const statusPath = join(f.processRoot, "status.json");
		const deadIdentity = { bootId: "boot-id", processId: crypto.randomUUID() };
		await writeFile(statusPath, JSON.stringify({ version: 1, identity: deadIdentity, call, state: "running", startedAt: 1, deadlineAt: 2, helperPid: 99999999, helperStartTime: "missing", outputCursor: 0, gap: false, chunks: [] }), { mode: 0o600 });
		const recovered = await f.supervisor.inspect({ call, resourceId: "resource", identity: deadIdentity });
		expect(recovered).toMatchObject({ receipt: { outcome: "succeeded" }, process: { state: "failed" } });
		expect(await f.supervisor.start({ ...f.input, call })).toMatchObject({ receipt: { outcome: "failed", error: { code: "process_start_failed" } } });
		expect(await readFile(f.runtimeState, "utf8")).toBe("stopped");
	});

	test("persists unknown and exits when stop escalation cannot verify termination", async () => {
		const f = await fixture(64, true); const started = await f.supervisor.start(f.input); if (!("process" in started)) throw new Error("missing process");
		await f.supervisor.cancel({ call, resourceId: "resource", identity: started.process.identity });
		const result = await Promise.race([terminal(f, started.process.identity), Bun.sleep(2_000).then(() => { throw new Error("supervisor did not exit after failed stop escalation"); })]);
		expect(result).toMatchObject({ receipt: { outcome: "succeeded" }, process: { state: "unknown" } });
	});

	test("stops background descendants before waiting for inherited output pipes", async () => {
		const f = await fixture(64); const started = await f.supervisor.start({ ...f.input, argv: ["background"] }); if (!("process" in started)) throw new Error("missing process");
		const result = await terminal(f, started.process.identity);
		expect(result).toMatchObject({ receipt: { outcome: "succeeded" }, process: { state: "exited" } });
		expect(await readFile(f.runtimeState, "utf8")).toBe("stopped");
	});

	test("retires stale active status after a verified container boot change without stopping the new boot", async () => {
		const f = await fixture(64); const first = await f.supervisor.start(f.input); if (!("process" in first)) throw new Error("missing process");
		await f.supervisor.cancel({ call, resourceId: "resource", identity: first.process.identity }); await terminal(f, first.process.identity);
		const statusPath = join(f.processRoot, "status.json"); const stale = JSON.parse(await readFile(statusPath, "utf8")); stale.state = "running"; await writeFile(statusPath, JSON.stringify(stale), { mode: 0o600 });
		f.resource.bootId = "next-boot"; await writeFile(f.runtimeState, "running");
		const next = await f.supervisor.start({ ...f.input, call: { ...call, operationId: "next", idempotencyKey: "next" } }); expect(next.receipt.outcome).toBe("succeeded"); if (!("process" in next)) throw new Error("missing next process");
		expect(await readFile(f.runtimeState, "utf8")).toBe("running");
		expect((await f.supervisor.inspect({ call, resourceId: "resource", identity: first.process.identity })).receipt.outcome).toBe("failed");
		expect((await f.supervisor.readOutput({ call, resourceId: "resource", identity: first.process.identity, cursor: 0, maxBytes: 1 })).receipt.outcome).toBe("failed");
		expect((await f.supervisor.cancel({ call, resourceId: "resource", identity: first.process.identity })).receipt.outcome).toBe("failed");
		await f.supervisor.cancel({ call, resourceId: "resource", identity: next.process.identity }); await terminal(f, next.process.identity);
	});

	test("preserves UTF-8 bytes split across output chunks", async () => {
		const f = await fixture(64); const started = await f.supervisor.start({ ...f.input, argv: ["utf8"] }); if (!("process" in started)) throw new Error("missing process");
		for (let attempt = 0; attempt < 100 && !(await Bun.file(f.execArgs).exists()); attempt += 1) await Bun.sleep(5);
		await Bun.sleep(20); await writeFile(f.runtimeState, "stopped"); await terminal(f, started.process.identity);
		const output = await f.supervisor.readOutput({ call, resourceId: "resource", identity: started.process.identity, cursor: 0, maxBytes: 64 }); if (!("chunks" in output)) throw new Error("missing output");
		const bytes = Buffer.concat(output.chunks.map((chunk) => Buffer.from(chunk.data, "base64"))); expect(bytes.toString("utf8")).toBe("€"); expect(output.cursor).toBe(3);
	});

	test("does not report an unverified persisted process start as successful", async () => {
		const f = await fixture(64); let launches = 0; let now = 1_000;
		const supervisor = new LocalProcessSupervisor(f.config, async () => f.resource, () => { launches += 1; throw new Error("crash boundary"); }, undefined, { now: () => now });
		const first = await supervisor.start(f.input); expect(first.receipt.outcome).toBe("unknown");
		const pending = await supervisor.start(f.input); expect(pending.receipt.outcome).toBe("unknown");
		now += 5_001;
		const terminal = await supervisor.start(f.input); expect(terminal.receipt).toMatchObject({ outcome: "failed", error: { code: "process_start_failed", retryable: false } });
		expect(await supervisor.start(f.input)).toEqual(terminal);
		expect(await readFile(f.runtimeState, "utf8")).toBe("stopped");
		expect(launches).toBe(1);
	});

	test("does not turn an accepted process start into a clean failure when lock cleanup throws", async () => {
		const f = await fixture(64); let launches = 0;
		const supervisor = new LocalProcessSupervisor(f.config, async () => f.resource, () => { launches += 1; }, (_descriptor, operation) => {
			if (operation === LOCK_RELEASE) throw new Error("lock cleanup failed");
			return 0;
		});

		expect((await supervisor.start(f.input)).receipt.outcome).toBe("succeeded");
		expect(launches).toBe(1);
	});

	test("does not load the native lock binding during import or configuration", async () => {
		const f = await fixture(64); let nativeCalls = 0;
		const supervisor = new LocalProcessSupervisor(f.config, async () => f.resource, () => undefined, () => { nativeCalls += 1; throw new Error("native binding unavailable"); });
		expect(nativeCalls).toBe(0);
		expect((await supervisor.start(f.input)).receipt).toMatchObject({ outcome: "failed", error: { code: "process_start_failed" } }); expect(nativeCalls).toBe(1);
	});
});
