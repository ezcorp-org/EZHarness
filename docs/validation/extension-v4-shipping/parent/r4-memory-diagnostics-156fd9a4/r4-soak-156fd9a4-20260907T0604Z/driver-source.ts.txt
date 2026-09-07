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
import { resourceRunConfig, resourceRunReachedTarget } from "./lib/shipping-runtime-resource-config";
import { type FdClasses, type OpenDescriptor, type RelationDescriptor, fdClass, isPgliteRelationFile, isPgliteRelationPath, nonRelationPathGrew, relationDescriptorProblems } from "./lib/shipping-runtime-resource-accounting";

type CleanupObservation = { baselineConnections: number; remainingConnections: number; polls: number; durationMs: number };
type MappedPgliteFile = { address: string; permissions: string; offset: string; device: string; inode: string; path: string };
type FdSnapshot = { classes: FdClasses; pgliteRelationDescriptors: RelationDescriptor[]; descriptors: OpenDescriptor[] };
type FdEvidence = { descriptors: OpenDescriptor[]; mappedPgliteFiles: MappedPgliteFile[] };
type FailureEvidence = {
  cycle: number;
  reason: string;
  observedSample: Sample;
  warmSample: Sample;
  addedDescriptors: OpenDescriptor[];
  removedDescriptors: OpenDescriptor[];
  addedMappedPgliteFiles: MappedPgliteFile[];
  removedMappedPgliteFiles: MappedPgliteFile[];
  observed: FdEvidence;
  warm?: FdEvidence;
};
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

async function processFdSnapshot(pid: string): Promise<FdSnapshot> {
  const classes: FdClasses = { socket: 0, pipe: 0, anon: 0, path: 0, other: 0 };
  const pgliteRelationDescriptors: RelationDescriptor[] = [];
  const descriptors: OpenDescriptor[] = [];
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    try {
      const target = await readlink(`/proc/${pid}/fd/${fd}`);
      const kind = fdClass(target);
      const metadata = kind === "path" ? await stat(`/proc/${pid}/fd/${fd}`) : undefined;
      descriptors.push({ fd, target, class: kind, ...(metadata ? { device: String(metadata.dev), inode: String(metadata.ino) } : {}) });
      classes[kind]++;
      if (kind === "path" && isPgliteRelationFile(target)) {
        let backing: { device: string; inode: string } | undefined;
        try {
          const backingMetadata = await stat(`/proc/${pid}/root${target.replace(/ \(deleted\)$/, "")}`);
          backing = { device: String(backingMetadata.dev), inode: String(backingMetadata.ino) };
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ESTALE"].includes(String(error.code))) throw error;
        }
        pgliteRelationDescriptors.push({ ...descriptors.at(-1)!, backingDevice: backing?.device, backingInode: backing?.inode, backingMissing: !backing });
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  return { classes, pgliteRelationDescriptors, descriptors };
}

function descriptorIdentity(descriptor: OpenDescriptor | MappedPgliteFile): string {
  if ("target" in descriptor) return `${descriptor.class}\u0000${descriptor.target}\u0000${descriptor.device ?? ""}\u0000${descriptor.inode ?? ""}`;
  return `${descriptor.address}\u0000${descriptor.permissions}\u0000${descriptor.offset}\u0000${descriptor.device}\u0000${descriptor.inode}\u0000${descriptor.path}`;
}

function multisetDelta<T extends OpenDescriptor | MappedPgliteFile>(before: T[], after: T[]): { added: T[]; removed: T[] } {
  const remaining = new Map<string, T[]>();
  for (const item of before) {
    const identity = descriptorIdentity(item);
    remaining.set(identity, [...(remaining.get(identity) ?? []), item]);
  }
  const added: T[] = [];
  for (const item of after) {
    const identity = descriptorIdentity(item);
    const matches = remaining.get(identity);
    if (matches?.length) matches.pop();
    else added.push(item);
  }
  return { added, removed: [...remaining.values()].flat() };
}

async function mappedPgliteFiles(pid: string, pgliteDataRoot: string): Promise<MappedPgliteFile[]> {
  return (await readFile(`/proc/${pid}/maps`, "utf8"))
    .split("\n")
    .flatMap(line => {
      const match = /^([0-9a-f]+-[0-9a-f]+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\/.*)$/.exec(line);
      if (!match || !isPgliteRelationPath(pgliteDataRoot, match[6]!)) return [];
      return [{ address: match[1]!, permissions: match[2]!, offset: match[3]!, device: match[4]!, inode: match[5]!, path: match[6]! }];
    });
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

async function sample(cycle: number, store: string, runnerPid: string, appProcessPid: string, appContainer: string): Promise<{ observed: Sample; fdSnapshot: FdSnapshot }> {
  const fdSnapshot = await processFdSnapshot(appProcessPid);
  return { observed: {
    cycle,
    runnerContainers: await runnerContainerCount(store),
    runnerFds: await runnerFdCount(runnerPid),
    appFds: fdSnapshot.descriptors.length,
    appEstablishedTcpConnections: await appEstablishedTcpConnections(appProcessPid),
    appContainerMemoryBytes: await appContainerMemoryBytes(appContainer),
  }, fdSnapshot };
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

const config = resourceRunConfig();
const appContainer = required("EZ_PRODUCTION_CONTAINER");
const runRoot = required("EZ_PRODUCTION_RUN_ROOT");
const runnerPid = required("EZ_PRODUCTION_RUNNER_PID");
const production = await productionLifecycleClient();
const { origin, cookie, client, createBuild, approveAndActivate, inspect } = production;
const appProcessPid = await appPid(appContainer);
const pgliteDataRoot = "/app/data/ezcorp";
const count = config.maximumCycles;
const reconnectsPerCycle = 10;
const start = Date.now();
const requestedMinimumDurationMs = config.mode === "duration" ? config.requestedMinimumDurationMs : undefined;
const store = join(runRoot, "store");
const initialSample = await sample(0, store, runnerPid, appProcessPid, appContainer);
const samples: Sample[] = [initialSample.observed];
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
let relationCacheWarmEvidence: FdEvidence | undefined;
let firstLifecycleFdSnapshot: FdSnapshot | undefined;

async function writeReceipt(completedCycles: number, failure?: FailureEvidence): Promise<void> {
  const actualDurationMs = Date.now() - start;
  const receipt = {
    check: "R4",
    mode: config.mode,
    requestedMinimumDurationMs,
    maximumCycles: count,
    cycles: count,
    completedCycles,
    reconnectsPerCycle,
    totalReconnects: completedCycles * reconnectsPerCycle,
    relationCacheWarmupCycles,
    actualDurationMs,
    durationMs: actualDurationMs,
    baseline,
    relationCacheWarmup,
    samples,
    ...(failure ? { failure } : {}),
  };
  await writeFile(join(required("EZ_PRODUCTION_RECEIPT_DIR"), "r4-resource-samples.json"), JSON.stringify(receipt) + "\n", { mode: 0o600 });
}

async function failResourceCheck(cycle: number, reason: string, observedSample: Sample, observedSnapshot: FdSnapshot): Promise<never> {
  const observed: FdEvidence = { descriptors: observedSnapshot.descriptors, mappedPgliteFiles: await mappedPgliteFiles(appProcessPid, pgliteDataRoot) };
  const warm = relationCacheWarmEvidence;
  const descriptorDelta = warm ? multisetDelta(warm.descriptors, observed.descriptors) : { added: observed.descriptors, removed: [] };
  const mappedPgliteFileDelta = warm ? multisetDelta(warm.mappedPgliteFiles, observed.mappedPgliteFiles) : { added: observed.mappedPgliteFiles, removed: [] };
  await writeReceipt(samples.length - 1, {
    cycle,
    reason,
    observedSample,
    warmSample: relationCacheWarmup ?? baseline,
    addedDescriptors: descriptorDelta.added,
    removedDescriptors: descriptorDelta.removed,
    addedMappedPgliteFiles: mappedPgliteFileDelta.added,
    removedMappedPgliteFiles: mappedPgliteFileDelta.removed,
    observed,
    ...(warm ? { warm } : {}),
  });
  throw new Error(reason);
}

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
  const measured = await sample(cycle, store, runnerPid, appProcessPid, appContainer);
  const after = { ...measured.observed, sseCleanup };
  const fdSnapshot = measured.fdSnapshot;
  after.appFdClasses = fdSnapshot.classes;
  after.pgliteRelationDescriptors = fdSnapshot.pgliteRelationDescriptors;
  if (after.runnerContainers !== 0) await failResourceCheck(cycle, `Cycle ${cycle} retained ${after.runnerContainers} owned runner containers.`, after, fdSnapshot);
  if (after.runnerFds !== baseline.runnerFds) await failResourceCheck(cycle, `Cycle ${cycle} runner FDs ${after.runnerFds} did not return to baseline ${baseline.runnerFds}.`, after, fdSnapshot);
  if (after.appEstablishedTcpConnections > appConnectionsBeforeSse) await failResourceCheck(cycle, `Cycle ${cycle} app TCP connections ${after.appEstablishedTcpConnections} exceeded its pre-SSE count ${appConnectionsBeforeSse}.`, after, fdSnapshot);
  const relationProblems = relationDescriptorProblems(pgliteDataRoot, fdSnapshot.pgliteRelationDescriptors);
  if (relationProblems.length) await failResourceCheck(cycle, `Cycle ${cycle} invalid PGlite relation descriptor: ${relationProblems[0]}`, after, fdSnapshot);
  if (cycle === 1) firstLifecycleFdSnapshot = fdSnapshot;
  else {
    for (const key of ["socket", "pipe", "anon", "other"] as const) {
      if (fdSnapshot.classes[key] > firstLifecycleFdSnapshot!.classes[key]) await failResourceCheck(cycle, `Cycle ${cycle} app ${key} descriptors grew above the first lifecycle sample.`, after, fdSnapshot);
    }
    if (nonRelationPathGrew(firstLifecycleFdSnapshot!, fdSnapshot)) await failResourceCheck(cycle, `Cycle ${cycle} app non-relation path descriptors grew above the first lifecycle sample.`, after, fdSnapshot);
  }
  if (cycle === relationCacheWarmupCycles) {
    relationCacheWarmup = after;
    relationCacheWarmEvidence = { descriptors: fdSnapshot.descriptors, mappedPgliteFiles: await mappedPgliteFiles(appProcessPid, pgliteDataRoot) };
  } else if (cycle > relationCacheWarmupCycles) {
    if (after.appContainerMemoryBytes > relationCacheWarmup!.appContainerMemoryBytes + 64 * 1024 ** 2) await failResourceCheck(cycle, `Cycle ${cycle} app container memory exceeded the relation-cache warm baseline by more than 64 MiB.`, after, fdSnapshot);
  }
  samples.push(after);
  await writeReceipt(cycle);
  if (resourceRunReachedTarget(config, Date.now() - start, cycle)) break;
}

const actualDurationMs = Date.now() - start;
const completedCycles = samples.length - 1;
if (config.mode === "duration" && !resourceRunReachedTarget(config, actualDurationMs, completedCycles)) {
  throw new Error(`R4 duration soak reached its ${count}-cycle ceiling after ${actualDurationMs}ms and ${completedCycles} cycles; it requires ${requestedMinimumDurationMs}ms and at least 10 completed cycles.`);
}
console.log(JSON.stringify({ check: "R4", mode: config.mode, requestedMinimumDurationMs, maximumCycles: count, cycles: completedCycles, completedCycles, reconnectsPerCycle, totalReconnects: completedCycles * reconnectsPerCycle, relationCacheWarmupCycles, actualDurationMs, durationMs: actualDurationMs, baseline: resourceReport(baseline), relationCacheWarmup: relationCacheWarmup && resourceReport(relationCacheWarmup), final: resourceReport(samples.at(-1)!), samples: samples.map(resourceReport) }));
