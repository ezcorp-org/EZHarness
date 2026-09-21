import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dlopen, FFIType } from "bun:ffi";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderCall, SandboxProcessStartInput } from "@ezcorp/extension-contract";
import { launchDetachedSupervisor, LocalProcessSupervisor, type OwnedProcessResource } from "../runtime/sandbox/local-podman/supervisor";
import { runSupervisorEntry, supervisorEntryMain } from "../runtime/sandbox/local-podman/supervisor-entry";

const roots: string[] = [];
const bunExecutable = process.execPath;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const call: ProviderCall = { scope: { projectId: "project", bindingId: "binding", generation: 1 }, operationId: "operation", idempotencyKey: "key", requestDigest: "a".repeat(64) };

async function fixture(outputBytes = 12, stopFails = false) {
	const root = await mkdtemp(join(tmpdir(), "ez-supervisor-")); roots.push(root);
	const processRoot = join(root, "resource", "process"); await mkdir(processRoot, { recursive: true, mode: 0o700 });
	const runtimeState = join(root, "runtime-state"); await writeFile(runtimeState, "running");
	const descendantPid = join(root, "descendant-pid"); const execArgs = join(root, "exec-args");
	const podman = join(root, "podman");
	await writeFile(podman, `#!${bunExecutable}
import { readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2); const state = ${JSON.stringify(runtimeState)}; const descendantPid = ${JSON.stringify(descendantPid)};
if (args.includes("exec")) { await writeFile(${JSON.stringify(execArgs)}, JSON.stringify(args)); if (args.includes("utf8")) { process.stdout.write(new Uint8Array([0xe2])); await Bun.sleep(5); process.stdout.write(new Uint8Array([0x82, 0xac])); } else { process.stdout.write("abcdefghij"); process.stderr.write("KLMNOPQRST"); } if (args.includes("background")) { const child = Bun.spawn(["/bin/sh", "-c", "sleep 30"], { stdout: "inherit", stderr: "inherit" }); await writeFile(descendantPid, String(child.pid)); process.exit(0); } while ((await readFile(state, "utf8")) === "running") await Bun.sleep(5); process.exit(0); }
if (args.includes("stop") || args.includes("kill")) { if (${stopFails}) process.exit(1); await writeFile(state, "stopped"); try { process.kill(Number(await readFile(descendantPid, "utf8")), "SIGKILL"); } catch { await Promise.resolve(); } process.exit(0); }
if (args.includes("inspect")) { const running = (await readFile(state, "utf8")) === "running"; console.log(args.some(value => value.includes(".Name")) ? "containerid containername " + running : "containerid " + running); process.exit(0); }
process.exit(2);
`); await chmod(podman, 0o700);
	const resource: OwnedProcessResource = { resourceId: "resource", containerId: "containerid", containerName: "containername", scope: call.scope, processRoot, bootId: "boot-id" };
	const entries: Promise<void>[] = [];
	const supervisor = new LocalProcessSupervisor({ stateRoot: root, podmanPath: podman, supervisorPath: "/trusted/supervisor", maxOutputBytes: outputBytes, workspaceUid: 0, workspaceGid: 0 }, async () => resource, argv => { entries.push(runSupervisorEntry(argv[1]!)); });
	const input: SandboxProcessStartInput = { call, resourceId: "resource", argv: ["tool"], env: { SAFE: "yes" }, cwd: "/", user: "workspace", timeoutMs: 2_000 };
	return { root, processRoot, runtimeState, execArgs, podman, resource, entries, supervisor, input };
}

async function terminal(f: Awaited<ReturnType<typeof fixture>>, identity: { bootId: string; processId: string }) {
	await Promise.all(f.entries);
	return f.supervisor.inspect({ call, resourceId: "resource", identity });
}

describe("LocalProcessSupervisor", () => {
	test("runs one detached process, bounds output while reading, and stops descendants", async () => {
		const f = await fixture(); const started = await f.supervisor.start(f.input);
		expect(started.receipt.outcome).toBe("succeeded"); if (!("process" in started)) throw new Error("missing process");
		expect(await f.supervisor.start(f.input)).toEqual(started);
		expect(f.entries).toHaveLength(1);
		expect((await f.supervisor.start({ ...f.input, call: { ...call, requestDigest: "b".repeat(64) } })).receipt).toMatchObject({ outcome: "failed", error: { code: "idempotency_conflict" } });
		const busy = await f.supervisor.start({ ...f.input, call: { ...call, operationId: "other" } }); expect(busy.receipt.outcome).toBe("failed");
		await writeFile(join(f.processRoot, "cancel"), started.process.identity.processId);
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

	test("fails closed for invalid host configuration, state artifacts, and cursors", async () => {
		const f = await fixture();
		expect(() => new LocalProcessSupervisor({ stateRoot: "relative", podmanPath: f.input.argv[0]!, supervisorPath: "relative", maxOutputBytes: 0, workspaceUid: -1, workspaceGid: -1 }, async () => f.resource)).toThrow();
		const lockPath = join(f.processRoot, "start.lock"); const held = await open(lockPath, "a+", 0o600); const libc = dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }); expect(libc.symbols.flock(held.fd, 2 | 4)).toBe(0);
		expect((await f.supervisor.start(f.input)).receipt).toMatchObject({ outcome: "failed", error: { code: "process_busy" } }); libc.symbols.flock(held.fd, 8); await held.close(); libc.close();
		await writeFile(lockPath, "orphaned host crash artifact", { mode: 0o600 });
		const started = await f.supervisor.start(f.input); if (!("process" in started)) throw new Error("missing process");
		await writeFile(join(f.processRoot, "cancel"), started.process.identity.processId); await terminal(f, started.process.identity);
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
		expect(recovered).toMatchObject({ receipt: { outcome: "succeeded" }, process: { state: "unknown" } });
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

	test("retains a replayable identity when detached launch throws", async () => {
		const f = await fixture(64); let launches = 0;
		const supervisor = new LocalProcessSupervisor({ stateRoot: f.root, podmanPath: f.podman, supervisorPath: "/trusted/supervisor", maxOutputBytes: 64, workspaceUid: 0, workspaceGid: 0 }, async () => f.resource, () => { launches += 1; throw new Error("crash boundary"); });
		const first = await supervisor.start(f.input); expect(first.receipt.outcome).toBe("unknown");
		const replayed = await supervisor.start(f.input); expect(replayed.receipt.outcome).toBe("succeeded"); expect("process" in replayed && replayed.process.state).toBe("starting"); expect(launches).toBe(1);
	});

	test("does not load the native lock binding during import or configuration", async () => {
		const f = await fixture(64); let nativeCalls = 0;
		const supervisor = new LocalProcessSupervisor({ stateRoot: f.root, podmanPath: f.podman, supervisorPath: "/trusted/supervisor", maxOutputBytes: 64, workspaceUid: 0, workspaceGid: 0 }, async () => f.resource, () => undefined, () => { nativeCalls += 1; throw new Error("native binding unavailable"); });
		expect(nativeCalls).toBe(0);
		expect((await supervisor.start(f.input)).receipt).toMatchObject({ outcome: "failed", error: { code: "process_start_failed" } }); expect(nativeCalls).toBe(1);
	});
});
