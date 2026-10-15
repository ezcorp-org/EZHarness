/**
 * Process and network helpers for the `factory-services` stack launcher.
 *
 * Every child starts in its own process group, so one signal stops the child
 * and anything it spawned. Output is kept in memory and written to the log
 * directory when the stack stops.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export interface StackChild {
	readonly name: string;
	readonly child: ChildProcess;
	readonly log: string[];
}

export class StackProcesses {
	readonly children: StackChild[] = [];

	start(name: string, command: string, args: readonly string[], options: { cwd: string; env?: Record<string, string> }): StackChild {
		const child = spawn(command, [...args], { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
		const log: string[] = [];
		child.stdout?.on("data", chunk => log.push(String(chunk)));
		child.stderr?.on("data", chunk => log.push(String(chunk)));
		const entry = { name, child, log };
		this.children.push(entry);
		return entry;
	}

	/** Signals every group. A group that has already exited is not an error. */
	stopAll(signal: NodeJS.Signals): void {
		for (const { child } of this.children) stopGroup(child.pid, signal);
	}
}

export function stopGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid === undefined) return;
	try { process.kill(-pid, signal); } catch {
		try { process.kill(pid, signal); } catch { /* the process has already exited */ }
	}
}

/** True when a TCP listener accepts on the loopback port. No bytes are sent. */
export function reachable(port: number): Promise<boolean> {
	return new Promise(settle => {
		const socket = connect({ host: "127.0.0.1", port });
		const done = (value: boolean) => { socket.destroy(); settle(value); };
		socket.setTimeout(1_000, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

export function freePort(): number {
	const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const port = server.port;
	server.stop(true);
	return port;
}

/** Polls until `probe` returns a value, or returns null at the deadline. */
export async function waitFor<T>(probe: () => Promise<T | null | undefined>, attempts: number, intervalMs: number): Promise<T | null> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const value = await probe();
		if (value !== null && value !== undefined) return value;
		await sleep(intervalMs);
	}
	return null;
}

/** One cookie-carrying HTTP session against the real application. */
export function httpSession(baseURL: string) {
	let cookie = "";
	return async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
		const response = await fetch(`${baseURL}${path}`, {
			method,
			redirect: "manual",
			headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const issued = response.headers.getSetCookie();
		if (issued.length > 0) cookie = issued.map(entry => entry.split(";")[0]).join("; ");
		const text = await response.text();
		try { return { status: response.status, body: JSON.parse(text) as unknown }; } catch { return { status: response.status, body: text.slice(0, 400) }; }
	};
}
