import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFactoryOrchestrationReadinessWriter } from "../factory/orchestration-readiness-writer";
import { readPrivateText } from "../factory/private-files";
import { makeFactoryTempPrivateRoot } from "./helpers/factory-private-root";
import { saveStackFailureDiagnostics, stackFailureDiagnostics, StackProcesses, type StackChild } from "../../web/e2e/factory-services/processes";

const SECRET = "fixture-secret-that-must-not-be-printed";

test("reports the real failed child and writer error without child logs or secret fields", async () => {
	const root = await makeFactoryTempPrivateRoot("factory-failure-diagnostic-");
	try {
		const readinessFilePath = join(root, "orchestration.json");
		const writer = createFactoryOrchestrationReadinessWriter({ installationId: "installation", tenantId: "tenant", namespace: "tenant.factory", taskQueue: "factory-orchestrator", readinessFilePath });
		await writer.write({ lifecycle: "failed", workerPolling: false, dispatcherLive: false, credentialGeneration: 0, errorCode: "factory_workflow_bundle_missing" });
		const record = JSON.parse(await readPrivateText(readinessFilePath, 4_096));
		const processes = new StackProcesses();
		const entry = processes.start("orchestrator-4", "node", ["-e", `console.error(${JSON.stringify(SECRET)}); process.exit(7);`], { cwd: root });
		await new Promise<void>(resolve => entry.child.once("close", () => resolve()));
		expect(entry.log.join("")).toContain(SECRET);
		const diagnostic = stackFailureDiagnostics(processes.children, { orchestration: { ...record, credentials: SECRET } });
		expect(diagnostic.processes).toEqual([{ name: "orchestrator-4", pid: entry.child.pid!, exitCode: 7, signalCode: null }]);
		expect(diagnostic.readiness.orchestration).toEqual({ available: true, lifecycle: "failed", errorCode: "factory_workflow_bundle_missing", workerPolling: false, dispatcherLive: false });
		expect(JSON.stringify(diagnostic)).not.toContain(SECRET);
		const saved = await saveStackFailureDiagnostics(processes.children, root, root);
		expect(JSON.parse(saved)).toEqual(diagnostic);
		expect(await readFile(join(root, "failure.json"), "utf8")).toBe(saved);
		expect((await stat(join(root, "failure.json"))).mode & 0o777).toBe(0o600);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 5_000);

function child(name: string, pid: number): StackChild {
	return { name, log: [SECRET], child: { pid, exitCode: 1, signalCode: null } as ChildProcess };
}

test("keeps the latest restart and bounds process facts without command output", () => {
	const restarts = Array.from({ length: 100 }, (_, index) => child(`orchestrator-${index}`, index));
	const diagnostic = stackFailureDiagnostics(restarts, {});
	expect(diagnostic.processes).toEqual([{ name: "orchestrator-99", pid: 99, exitCode: 1, signalCode: null }]);
	const many = Array.from({ length: 30 }, (_, index) => child(`${"a".repeat(80)}-${String.fromCharCode(97 + index)}`, index));
	const bounded = stackFailureDiagnostics(many, {});
	expect(bounded.processes).toHaveLength(16);
	expect(bounded.processes.every(entry => entry.name.length <= 64)).toBe(true);
	expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(4_096);
});

test("omits unrecognized readiness values instead of logging arbitrary objects", () => {
	const diagnostic = stackFailureDiagnostics([], {
		pool: null,
		supervisor: [],
		orchestration: { lifecycle: SECRET, errorCode: SECRET, workerPolling: SECRET, dispatcherLive: true, environment: SECRET },
	});
	expect(diagnostic.readiness.pool).toEqual({ available: false });
	expect(diagnostic.readiness.supervisor).toEqual({ available: false });
	expect(diagnostic.readiness.orchestration).toEqual({ available: true, dispatcherLive: true });
	expect(JSON.stringify(diagnostic)).not.toContain(SECRET);
});

test("failure capture tolerates missing, malformed and oversized readiness without exposing bytes", async () => {
	const root = await makeFactoryTempPrivateRoot("factory-failure-missing-");
	try {
		await writeFile(join(root, "pool.json"), `invalid ${SECRET}`, { mode: 0o600 });
		await writeFile(join(root, "supervisor.json"), SECRET.repeat(300), { mode: 0o600 });
		const saved = await saveStackFailureDiagnostics([], root, root);
		expect(JSON.parse(saved).readiness).toEqual({ pool: { available: false }, supervisor: { available: false }, orchestration: { available: false } });
		expect(saved).not.toContain(SECRET);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
