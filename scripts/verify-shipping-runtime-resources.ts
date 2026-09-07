/** Production R4: repeat lifecycle work and authenticated SSE reconnects.
 *
 * One owned production app and runner are supplied by the shared launcher.
 * The verifier measures its exact app process and runner-labelled containers,
 * then checks that every completed cycle returns to the observed warm state.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { command, productionLifecycleClient, required } from "./lib/production-lifecycle-client";
import { echoSource, echoText } from "./lib/shipping-runtime-helpers";
import { resourceRunConfig, type ResourceRunConfig } from "./lib/shipping-runtime-resource-config";

type CleanupObservation = { baselineConnections: number; remainingConnections: number; polls: number; durationMs: number };
type FdClasses = { socket: number; pipe: number; anon: number; path: number; other: number };
type RelationDescriptor = { path: string; inode: string };
type FdSnapshot = { classes: FdClasses; pgliteRelationDescriptors: RelationDescriptor[] };
type Sample = {
  cycle: number;
  runnerContainers: number;
  runnerFds: number;
  appFds: number;
  appEstablishedTcpConnections: number;
  appContainerMemoryBytes: number;
  appFdClasses?: FdClasses;
  pgliteRelationDescriptors?: RelationDescriptor[];
  sseCleanup?: CleanupObservation;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}


function bytes(text: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)(B|[KMGT]i?B)\b/.exec(text.trim());
  if (!match) throw new Error(`Unable to parse app container memory: ${text}`);
  const unit = { B: 1, KB: 1_000, MB: 1_000 ** 2, GB: 1_000 ** 3, TB: 1_000 ** 4, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }[match[2]!];
  return Math.round(Number(match[1]) * unit!);
}

async function runnerContainerCount(store: string): Promise<number> {
  const output = await command("podman", ["ps", "--all", "--filter", `label=io.ezcorp.runner=${sha256(store)}`, "--format", "{{.Names}}"]);
  return output ? output.split("\n").length : 0;
}

async function processFdCount(pid: string): Promise<number> {
  return (await readdir(`/proc/${pid}/fd`)).length;
}

function isPgliteRelationDescriptor(path: string): boolean {
  return /\/base\/[0-9]+\/[0-9]+(?:\.[0-9]+|_(?:fsm|vm|init))?$/.test(path);
}

async function processFdSnapshot(pid: string): Promise<FdSnapshot> {
  const classes: FdClasses = { socket: 0, pipe: 0, anon: 0, path: 0, other: 0 };
  const pgliteRelationDescriptors: RelationDescriptor[] = [];
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    try {
      const target = await readlink(`/proc/${pid}/fd/${fd}`);
      if (target.startsWith("socket:")) classes.socket++;
      else if (target.startsWith("pipe:")) classes.pipe++;
      else if (target.startsWith("anon_inode:")) classes.anon++;
      else if (target.startsWith("/")) {
        classes.path++;
        if (isPgliteRelationDescriptor(target)) pgliteRelationDescriptors.push({ path: target, inode: String((await stat(`/proc/${pid}/fd/${fd}`)).ino) });
      }
      else classes.other++;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  return { classes, pgliteRelationDescriptors };
}

function duplicateRelationInodes(snapshot: FdSnapshot): string[] {
  const counts = new Map<string, number>();
  for (const descriptor of snapshot.pgliteRelationDescriptors) counts.set(descriptor.inode, (counts.get(descriptor.inode) ?? 0) + 1);
  return [...counts].flatMap(([inode, count]) => count > 1 ? [inode] : []);
}

function resourceReport(sample: Sample): Omit<Sample, "pgliteRelationDescriptors"> & { pgliteRelationDescriptorCount: number } {
  const { pgliteRelationDescriptors = [], ...safe } = sample;
  return { ...safe, pgliteRelationDescriptorCount: pgliteRelationDescriptors.length };
}

async function runnerFdCount(pid: string): Promise<number> {
  if ((await readFile(`/proc/${pid}/comm`, "utf8")).trim() !== "bun") throw new Error("The supplied runner PID is not the Bun runner process.");
  return processFdCount(pid);
}

async function appPid(container: string): Promise<string> {
  const pid = await command("docker", ["inspect", container, "--format", "{{.State.Pid}}"]);
  if (!/^[1-9][0-9]*$/.test(pid)) throw new Error(`The owned app did not expose a live process PID: ${pid}`);
  return pid;
}

async function appEstablishedTcpConnections(pid: string): Promise<number> {
  const tables = await Promise.all([readFile(`/proc/${pid}/net/tcp`, "utf8"), readFile(`/proc/${pid}/net/tcp6`, "utf8")]);
  return tables.flatMap(table => table.split("\n").slice(1)).filter(line => {
    const fields = line.trim().split(/\s+/);
    return fields[1]?.endsWith(":0BB8") && fields[3] === "01";
  }).length;
}

async function appContainerMemoryBytes(container: string): Promise<number> {
  return bytes(await command("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", container]));
}

async function sample(cycle: number, store: string, runnerPid: string, appProcessPid: string, appContainer: string): Promise<Sample> {
  return {
    cycle,
    runnerContainers: await runnerContainerCount(store),
    runnerFds: await runnerFdCount(runnerPid),
    appFds: await processFdCount(appProcessPid),
    appEstablishedTcpConnections: await appEstablishedTcpConnections(appProcessPid),
    appContainerMemoryBytes: await appContainerMemoryBytes(appContainer),
  };
}

async function waitForAppSseCleanup(pid: string, baselineConnections: number): Promise<CleanupObservation> {
  const started = Date.now();
  let remainingConnections = baselineConnections;
  for (let poll = 1; poll <= 20; poll++) {
    remainingConnections = await appEstablishedTcpConnections(pid);
    if (remainingConnections <= baselineConnections) return { baselineConnections, remainingConnections, polls: poll, durationMs: Date.now() - started };
    if (poll < 20) await Bun.sleep(100);
  }
  throw new Error(`App retained ${remainingConnections} established port-3000 connections above its pre-SSE ${baselineConnections} after reader cancellation.`);
}

async function reconnectRuntimeEvents(origin: string, cookie: string): Promise<void> {
  // A browser EventSource close ends its dedicated streaming socket. Bun's
  // fetch pool can otherwise retain this HTTP/1 connection after reader.cancel,
  // which would measure pooling rather than the route's cancel cleanup.
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 5_000);
  try {
    const response = await fetch(`${origin}/api/runtime-events`, { headers: { cookie, connection: "close" }, signal: abort.signal });
    if (!response.ok || !response.body) throw new Error(`Runtime event reconnect failed with ${response.status}.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let frame = "";
    try {
      while (!frame.includes(": connected\n\n")) {
        const next = await reader.read();
        if (next.done || !next.value) throw new Error("Runtime event reconnect ended before its connected frame.");
        frame += decoder.decode(next.value, { stream: true });
        if (frame.length > 4_096) throw new Error("Runtime event reconnect did not provide its connected frame.");
      }
    } finally {
      await reader.cancel();
    }
  } finally {
    // Bun's fetch reader cancellation releases local stream state but does
    // not always terminate the pooled request. Abort makes the server see
    // the same connection-close event as EventSource.close().
    abort.abort();
    clearTimeout(deadline);
  }
}

export { resourceRunConfig, type ResourceRunConfig };

export async function main(config = resourceRunConfig()): Promise<void> {
const appContainer = required("EZ_PRODUCTION_CONTAINER");
const runRoot = required("EZ_PRODUCTION_RUN_ROOT");
const runnerPid = required("EZ_PRODUCTION_RUNNER_PID");
const production = await productionLifecycleClient();
const { origin, cookie, client, createBuild, approveAndActivate, inspect } = production;
const appProcessPid = await appPid(appContainer);
const count = config.maximumCycles;
const reconnectsPerCycle = 10;
const start = Date.now();
const requestedMinimumDurationMs = config.mode === "duration" ? config.requestedMinimumDurationMs : undefined;
const store = join(runRoot, "store");
const samples: Sample[] = [await sample(0, store, runnerPid, appProcessPid, appContainer)];
const baseline = samples[0]!;
if (baseline.runnerContainers !== 0) throw new Error(`The owned runner began with ${baseline.runnerContainers} containers.`);
if (baseline.appEstablishedTcpConnections !== 0) throw new Error(`The owned app began with ${baseline.appEstablishedTcpConnections} established port-3000 connections.`);
const name = `r4-${crypto.randomUUID().replaceAll("-", "")}`;
const firstBuild = await createBuild(name, echoSource(name, "1.0.0", "cycle-1:", "R4 repeated lifecycle echo"));
const installationId = firstBuild.installation.id;
const workspaceId = firstBuild.workspace.id;
let revision = firstBuild.workspace.revision;
let activeReleaseId: string | null = null;
const conversation = await client.createConversation({ title: "R4 repeat lifecycle" });
// Each pass uses the same installation and a new candidate. The private receipt
// records PGlite relation paths and inodes. The default leaves four identical
// passes after the observed relation-cache warm-up; smaller configured runs
// retain two post-warm observations as diagnostics.
const relationCacheWarmupCycles = Math.min(6, count - 2);
let relationCacheWarmup: Sample | undefined;
let firstLifecycleFdSnapshot: FdSnapshot | undefined;
let previousFdSnapshot: FdSnapshot | undefined;

for (let cycle = 1; cycle <= count; cycle++) {
  const marker = `cycle-${cycle}-${crypto.randomUUID()}`;
  let releaseId: string;
  if (cycle === 1) releaseId = firstBuild.release.id;
  else {
    const edited = await client.extensionControl<{ revision: number }>("extensions_workspace", { action: "edit", installationId, workspaceId, expectedRevision: revision, writes: echoSource(name, `1.0.${cycle - 1}`, `cycle-${cycle}:`, "R4 repeated lifecycle echo") });
    revision = edited.revision;
    const build = await client.extensionControl<{ id: string }>("extensions_build", { installationId, workspaceId, expectedRevision: revision, idempotencyKey: crypto.randomUUID() });
    const built = await production.waitVerified(installationId, build.id);
    releaseId = built.operations[build.id]!.releaseId!;
  }
  await approveAndActivate(installationId, releaseId, activeReleaseId);
  if (cycle === 1) {
    const wired = await client.wireExtensions(conversation.id, [name]);
    if (!wired.wired.includes(name)) throw new Error("R4 extension was not wired to its owned conversation.");
  }
  if (echoText(await client.invokeExtensionTool(conversation.id, name, "echo", { text: marker })) !== `cycle-${cycle}:${marker}`) throw new Error(`Cycle ${cycle} did not produce its real echo output.`);
  const appConnectionsBeforeSse = await appEstablishedTcpConnections(appProcessPid);
  for (let connection = 0; connection < reconnectsPerCycle; connection++) await reconnectRuntimeEvents(origin, cookie);
  const sseCleanup = await waitForAppSseCleanup(appProcessPid, appConnectionsBeforeSse);
  await client.extensionControl("extensions_release", { action: "disable", installationId, idempotencyKey: crypto.randomUUID() });
  const disabled = await inspect(installationId);
  if (disabled.installation.enabled || disabled.installation.activeReleaseId !== releaseId) throw new Error(`Cycle ${cycle} disable changed release history or remained enabled.`);
  activeReleaseId = releaseId;
  const after = { ...await sample(cycle, store, runnerPid, appProcessPid, appContainer), sseCleanup };
  const fdSnapshot = await processFdSnapshot(appProcessPid);
  after.appFdClasses = fdSnapshot.classes;
  after.pgliteRelationDescriptors = fdSnapshot.pgliteRelationDescriptors;
  if (after.runnerContainers !== 0) throw new Error(`Cycle ${cycle} retained ${after.runnerContainers} owned runner containers.`);
  if (after.runnerFds !== baseline.runnerFds) throw new Error(`Cycle ${cycle} runner FDs ${after.runnerFds} did not return to baseline ${baseline.runnerFds}.`);
  if (after.appEstablishedTcpConnections > appConnectionsBeforeSse) throw new Error(`Cycle ${cycle} app TCP connections ${after.appEstablishedTcpConnections} exceeded its pre-SSE count ${appConnectionsBeforeSse}.`);
  const duplicates = duplicateRelationInodes(fdSnapshot);
  if (duplicates.length) throw new Error(`Cycle ${cycle} retained duplicate PGlite relation descriptors for ${duplicates.length} inode(s).`);
  if (cycle === 1) firstLifecycleFdSnapshot = fdSnapshot;
  else {
    for (const key of ["socket", "pipe", "anon", "other"] as const) {
      if (fdSnapshot.classes[key] > firstLifecycleFdSnapshot!.classes[key]) throw new Error(`Cycle ${cycle} app ${key} descriptors grew above the first lifecycle sample.`);
    }
    const fdDelta = after.appFds - samples.at(-1)!.appFds;
    const relationDelta = fdSnapshot.pgliteRelationDescriptors.length - previousFdSnapshot!.pgliteRelationDescriptors.length;
    if (fdDelta > 0 && fdDelta !== relationDelta) throw new Error(`Cycle ${cycle} added ${fdDelta} app descriptors but only ${relationDelta} PGlite relation descriptors.`);
  }
  previousFdSnapshot = fdSnapshot;
  if (cycle === relationCacheWarmupCycles) {
    relationCacheWarmup = after;
  } else if (cycle > relationCacheWarmupCycles) {
    if (after.appFds > relationCacheWarmup!.appFds) {
      throw new Error(`Cycle ${cycle} app FDs grew above the relation-cache warm baseline ${relationCacheWarmup!.appFds}.`);
    }
    if (after.appContainerMemoryBytes > relationCacheWarmup!.appContainerMemoryBytes + 64 * 1024 ** 2) throw new Error(`Cycle ${cycle} app container memory exceeded the relation-cache warm baseline by more than 64 MiB.`);
  }
  samples.push(after);
  const actualDurationMs = Date.now() - start;
  const receipt = { check: "R4", mode: config.mode, requestedMinimumDurationMs, maximumCycles: count, completedCycles: cycle, reconnectsPerCycle, totalReconnects: cycle * reconnectsPerCycle, relationCacheWarmupCycles, actualDurationMs, baseline, relationCacheWarmup, samples };
  await writeFile(join(required("EZ_PRODUCTION_RECEIPT_DIR"), "r4-resource-samples.json"), JSON.stringify(receipt) + "\n", { mode: 0o600 });
  if (requestedMinimumDurationMs !== undefined && actualDurationMs >= requestedMinimumDurationMs) break;
}

const actualDurationMs = Date.now() - start;
const completedCycles = samples.length - 1;
if (requestedMinimumDurationMs !== undefined && actualDurationMs < requestedMinimumDurationMs) {
  throw new Error(`R4 duration soak reached its ${count}-cycle ceiling after ${actualDurationMs}ms, before the requested ${requestedMinimumDurationMs}ms.`);
}
console.log(JSON.stringify({ check: "R4", mode: config.mode, requestedMinimumDurationMs, maximumCycles: count, completedCycles, reconnectsPerCycle, totalReconnects: completedCycles * reconnectsPerCycle, relationCacheWarmupCycles, actualDurationMs, baseline: resourceReport(baseline), relationCacheWarmup: relationCacheWarmup && resourceReport(relationCacheWarmup), final: resourceReport(samples.at(-1)!), samples: samples.map(resourceReport) }));

}

if (import.meta.main) await main();
