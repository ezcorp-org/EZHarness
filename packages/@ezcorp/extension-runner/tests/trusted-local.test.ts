import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildLimits, executionLimits, filesDigest, TrustedLocalRunner, TRUSTED_LOCAL_OMITTED_CONTROLS } from "../src";
import { sha256 } from "../src/core";
import { provision, source } from "./helpers";

test("trusted-local requires an exact admin approval, audit and separate execution approval, and refuses a device grant it cannot confine", async () => {
  const root = await mkdtemp(join(tmpdir(), "ez-trusted-local-"));
  const files = source();
  const sourceDigest = filesDigest(files);
  let allowed = "";
  let audited = 0;
  const runner = new TrustedLocalRunner({ root, ...await provision(), bunPath: process.execPath, bunDigest: sha256(await readFile(process.execPath)), dedicatedUid: process.getuid!(), approvalFor: async (phase, digest) => digest === allowed ? { phase, digest, approvedBy: "human-admin", expiresAt: Date.now() + 30_000, omittedControls: [...TRUSTED_LOCAL_OMITTED_CONTROLS] } : null, audit: async () => { audited++; } });
  try {
    await expect(runner.build({ operationId: randomUUID(), files, sourceDigest, entrypoint: "extension.ts", limits: buildLimits })).rejects.toThrow("Admin approval");
    allowed = sourceDigest;
    const result = await runner.build({ operationId: randomUUID(), files, sourceDigest, entrypoint: "extension.ts", limits: buildLimits });
    expect(result.diagnostics).toEqual([]);
    expect(result.imageDigest).toContain("trusted-local");
    expect(audited).toBe(1);
    const workerId = randomUUID();
    const context = { workerId, invocationId: randomUUID(), releaseId: result.artifactDigest!, principalId: "user", scopeId: "scope", token: "token", deadline: Date.now() + 10_000 };
    await expect(runner.start({ workerId, artifactDigest: result.artifactDigest!, context, limits: executionLimits }, async () => null)).rejects.toThrow("Admin approval");
    allowed = result.artifactDigest!;
    const worker = await runner.start({ workerId, artifactDigest: result.artifactDigest!, context, limits: executionLimits }, async () => null);
    try { expect(await worker.request("extension/invoke", { name: "echo", input: { message: "trusted" }, context })).toEqual({ message: "trusted" }); } finally { await worker.close(); }
    expect(audited).toBe(2);
    // This mode omits every kernel control, so it cannot hold a guest to the
    // device nodes an allocation authorized. The grant is refused, not ignored.
    const deviceWorkerId = randomUUID();
    await expect(runner.start({ workerId: deviceWorkerId, artifactDigest: result.artifactDigest!, context: { ...context, workerId: deviceWorkerId, invocationId: randomUUID(), deadline: Date.now() + 10_000 }, limits: executionLimits, devices: ["/dev/kfd"] }, async () => null)).rejects.toThrow("authorized device list");
    expect((await runner.inspect(deviceWorkerId)).state).toBe("failed");
  } finally { await runner.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);

test("trusted-local keeps the process policy: deny blocks process creation but not threads, allow starts processes, and a missing guard refuses deny", async () => {
  const root = await mkdtemp(join(tmpdir(), "ez-trusted-local-spawn-"));
  const files = source(`async () => { let spawn: string | number; try { spawn = Bun.spawnSync([process.execPath, "--version"]).exitCode ?? "none"; } catch (error) { spawn = (error as { code?: string }).code ?? "error"; } const thread = await new Promise(resolve => { const worker = new Worker(URL.createObjectURL(new Blob(["postMessage(7)"]))); worker.onmessage = event => { resolve(event.data); worker.terminate(); }; }); return { spawn, thread }; }`);
  const options = { root, ...await provision(), bunPath: process.execPath, bunDigest: sha256(await readFile(process.execPath)), dedicatedUid: process.getuid!(), approvalFor: async (phase: "build" | "execute", digest: string) => ({ phase, digest, approvedBy: "human-admin", expiresAt: Date.now() + 30_000, omittedControls: [...TRUSTED_LOCAL_OMITTED_CONTROLS] }), audit: async () => {} };
  const runner = new TrustedLocalRunner(options);
  const run = async (target: TrustedLocalRunner, artifactDigest: string, processSpawn?: "allow" | "deny") => {
    const workerId = randomUUID();
    const context = { workerId, invocationId: randomUUID(), releaseId: artifactDigest, principalId: "user", scopeId: "scope", token: "token", deadline: Date.now() + 10_000 };
    const worker = await target.start({ workerId, artifactDigest, context, limits: executionLimits, ...(processSpawn ? { processSpawn } : {}) }, async () => null);
    try { return await worker.request("extension/invoke", { name: "echo", input: {}, context }); } finally { await worker.close(); }
  };
  let artifactDigest: string;
  try {
    const result = await runner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
    expect(result.diagnostics).toEqual([]);
    artifactDigest = result.artifactDigest!;
    expect(await runner.capabilities()).toEqual({ processSpawnEnforcement: true });
    expect(await run(runner, artifactDigest)).toEqual({ spawn: "EPERM", thread: 7 });
    expect(await run(runner, artifactDigest, "allow")).toEqual({ spawn: 0, thread: 7 });
  } finally { await runner.close(); }
  // A setpriv that refuses the guard probe stands for a host where the filter
  // cannot be installed. The same store keeps the artifact built above.
  const refusing = join(root, "setpriv-refusing-guard");
  await writeFile(refusing, `#!/bin/sh\nfor a in "$@"; do case "$a" in *"spawn guard"*) exit 1;; esac; done\nexec setpriv "$@"\n`, { mode: 0o755 });
  const unguarded = new TrustedLocalRunner({ ...options, setprivPath: refusing });
  try {
    expect(await unguarded.capabilities()).toEqual({ processSpawnEnforcement: false });
    await expect(run(unguarded, artifactDigest)).rejects.toMatchObject({ code: "process_spawn_unenforced" });
    expect(await run(unguarded, artifactDigest, "allow")).toEqual({ spawn: 0, thread: 7 });
    // Discovery is a build-phase guest and may start processes, so a build still works here.
    const rebuilt = await unguarded.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
    expect(rebuilt.diagnostics).toEqual([]);
  } finally { await unguarded.close(); await rm(root, { recursive: true, force: true }); }
}, 120_000);
