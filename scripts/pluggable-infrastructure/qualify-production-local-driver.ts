#!/usr/bin/env bun
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalPodmanDriver } from "../../src/runtime/sandbox/local-podman/driver";

type Session = { resourceId: string; identity: { bootId: string; processId: string } };
const scope = { projectId: "qualification-project", bindingId: "qualification-binding", generation: 1 };
let sequence = 0;
function call(name: string) { const value = `${name}-${++sequence}`; return { scope, operationId: value, idempotencyKey: value, requestDigest: createHash("sha256").update(value).digest("hex") }; }
function required<T>(value: T | undefined, name: string): T { if (value === undefined) throw new Error(`${name} is required`); return value; }

async function waitProcess(driver: LocalPodmanDriver, resourceId: string, identity: Session["identity"]) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await driver.processInspect({ call: call("inspect-process"), resourceId, identity });
    if ("process" in result && result.process.state !== "starting" && result.process.state !== "running") return result.process;
    await Bun.sleep(25);
  }
  throw new Error("managed process did not become terminal");
}

async function readOutput(driver: LocalPodmanDriver, resourceId: string, identity: Session["identity"]) {
  const result = await driver.processReadOutput({ call: call("read-output"), resourceId, identity, cursor: 0, maxBytes: 256 * 1024 });
  if (!("chunks" in result)) throw new Error(`output unavailable: ${JSON.stringify(result)}`);
  return Buffer.concat(result.chunks.map((chunk) => Buffer.from(chunk.data, "base64"))).toString("utf8");
}

async function clientPhase(phase: string) {
  const config = JSON.parse(required(process.env.EZ_LOCAL_DRIVER_CONFIG, "EZ_LOCAL_DRIVER_CONFIG"));
  const sessionPath = required(process.env.EZ_LOCAL_DRIVER_SESSION, "EZ_LOCAL_DRIVER_SESSION"); const driver = new LocalPodmanDriver(config);
  const limits = { memoryBytes: 128 * 1024 * 1024, milliCpu: 500, pids: 32, diskBytes: 32 * 1024 * 1024 };
  if (phase === "initial") {
    const created = await driver.create({ call: call("create"), profile: "linux-exec.v1", limits }); if (!("resource" in created)) throw new Error(JSON.stringify(created));
    const resourceId = created.resource.resourceId; const started = await driver.start({ call: call("start"), resourceId }); if (started.receipt.outcome !== "succeeded") throw new Error(JSON.stringify(started));
    const process = await driver.processStart({ call: call("process-long"), resourceId, argv: ["sh", "-c", "printf persistent-value > /workspace/client-restart.txt; printf 'client-one-€'; sleep 300"], env: {}, cwd: "/workspace", user: "workspace", timeoutMs: 60_000 });
    if (!("process" in process)) throw new Error(JSON.stringify(process)); await writeFile(sessionPath, JSON.stringify({ resourceId, identity: process.process.identity } satisfies Session), { mode: 0o600 }); return;
  }
  const session = JSON.parse(await readFile(sessionPath, "utf8")) as Session;
  const before = await driver.processInspect({ call: call("inspect-after-client-restart"), resourceId: session.resourceId, identity: session.identity }); if (!("process" in before)) throw new Error(JSON.stringify(before));
  let retained = ""; for (let attempt = 0; attempt < 200 && !retained.includes("client-one-€"); attempt += 1) { retained = await readOutput(driver, session.resourceId, session.identity); if (!retained.includes("client-one-€")) await Bun.sleep(25); }
  if (!retained.includes("client-one-€")) throw new Error(`first client output was not retained: ${JSON.stringify(retained)}`);
  const cancel = await driver.processCancel({ call: call("cancel"), resourceId: session.resourceId, identity: session.identity }); if (cancel.receipt.outcome !== "succeeded") throw new Error(JSON.stringify(cancel));
  await waitProcess(driver, session.resourceId, session.identity); await driver.inspect({ call: call("reconcile-stopped"), resourceId: session.resourceId });
  const file = await driver.fileRead({ call: call("read-workspace"), resourceId: session.resourceId, path: "/client-restart.txt", offsetBytes: 0, lengthBytes: 1024 }); if (!("data" in file) || file.data !== "persistent-value") throw new Error(JSON.stringify(file));
  const restarted = await driver.start({ call: call("restart"), resourceId: session.resourceId }); if (restarted.receipt.outcome !== "succeeded") throw new Error(JSON.stringify(restarted));
  const repeated = await driver.processStart({ call: call("process-repeat"), resourceId: session.resourceId, argv: ["sh", "-c", "cat /workspace/client-restart.txt; printf ':client-two'"], env: {}, cwd: "/workspace", user: "workspace", timeoutMs: 10_000 }); if (!("process" in repeated)) throw new Error(JSON.stringify(repeated));
  await waitProcess(driver, session.resourceId, repeated.process.identity); const output = await readOutput(driver, session.resourceId, repeated.process.identity); if (output !== "persistent-value:client-two") throw new Error(`unexpected repeated output: ${JSON.stringify(output)}`);
  await driver.inspect({ call: call("reconcile-final-stop"), resourceId: session.resourceId }); const destroyed = await driver.destroy({ call: call("destroy"), resourceId: session.resourceId }); if (destroyed.receipt.outcome !== "succeeded") throw new Error(JSON.stringify(destroyed));
}

async function command(argv: string[]) { const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${result.stderr.toString()}`); return result.stdout.toString().trim(); }
async function main() {
  const phase = process.argv.find((item) => item.startsWith("--phase="))?.slice(8); if (phase) return clientPhase(phase);
  const fuse2fsPath = process.env.EZ_FUSE2FS_PATH ?? Bun.which("fuse2fs"); if (!fuse2fsPath?.startsWith("/")) throw new Error("Set EZ_FUSE2FS_PATH to the trusted absolute fuse2fs executable");
  const imageReference = process.env.EZ_LOCAL_IMAGE ?? "localhost/ezharness-local-mvp@sha256:cbdad798c9d85113d326c04eddcea0e3ce272dedb00465e66aa6c6a2e8e4a437";
  const work = await mkdtemp(join(tmpdir(), "ez-production-driver-")); await chmod(work, 0o700); const stateRoot = join(work, "state"); await mkdir(stateRoot, { mode: 0o700 });
  const supervisorPath = join(work, "sandbox-supervisor"); await command([process.execPath, "build", "--compile", join(import.meta.dir, "../../src/runtime/sandbox/local-podman/supervisor-entry.ts"), "--outfile", supervisorPath]);
  const imageId = (await command(["podman", "--remote=false", "image", "inspect", imageReference, "--format", "{{.Id}}"])) .replace(/^sha256:/, ""); const sessionPath = join(work, "session.json");
  const config = { stateRoot, imageReference, imageId, podmanPath: required(Bun.which("podman"), "podman"), fuse2fsPath, supervisorPath, workspaceUid: 0, workspaceGid: 0 };
  const env = { ...process.env, EZ_LOCAL_DRIVER_CONFIG: JSON.stringify(config), EZ_LOCAL_DRIVER_SESSION: sessionPath }; let resourceId = "";
  try {
    for (const phaseName of ["initial", "resume"]) { const child = Bun.spawn([process.execPath, import.meta.path, `--phase=${phaseName}`], { env, stdout: "inherit", stderr: "inherit" }); if (await child.exited) throw new Error(`${phaseName} client failed`); }
    resourceId = (JSON.parse(await readFile(sessionPath, "utf8")) as Session).resourceId; const containers = await command(["podman", "--remote=false", "ps", "--all", "--quiet", "--filter", `name=ez-local-${resourceId}`]);
    const mounts = (await readFile("/proc/self/mountinfo", "utf8")).split("\n").filter((line) => line.includes(stateRoot)); if (containers || mounts.length) throw new Error(`cleanup incomplete: containers=${containers} mounts=${mounts.length}`);
    const receipt = { qualified: true, separateClientProcesses: 2, resourceId, workspacePersisted: true, repeatedProcessOutput: true, cleanup: { containers: 0, mounts: 0 } }; const receiptPath = process.env.EZ_LOCAL_DRIVER_RECEIPT ?? join(process.cwd(), "local-driver-qualification-receipt.json"); await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`); console.log(JSON.stringify({ ...receipt, receiptPath }));
  } finally {
    const ids = Bun.spawnSync(["podman", "--remote=false", "ps", "--all", "--quiet"], { stdout: "pipe" }).stdout.toString().trim().split("\n").filter(Boolean);
    for (const id of ids) { const inspected = Bun.spawnSync(["podman", "--remote=false", "inspect", id], { stdout: "pipe" }); if (inspected.exitCode === 0 && inspected.stdout.toString().includes(stateRoot)) Bun.spawnSync(["podman", "--remote=false", "rm", "--force", "--volumes", id]); }
    const ownedMounts = (await readFile("/proc/self/mountinfo", "utf8")).split("\n").map((line) => line.split(" ")[4]?.replaceAll("\\040", " ")).filter((path): path is string => Boolean(path?.startsWith(stateRoot))).sort((a, b) => b.length - a.length);
    for (const mount of ownedMounts) Bun.spawnSync(["fusermount3", "-u", mount]); await rm(work, { recursive: true, force: true });
  }
}

await main();
