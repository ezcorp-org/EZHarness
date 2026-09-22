import { createHash } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";

export interface LocalPodmanHostConfig {
  stateRoot: string;
  imageReference: string;
  imageId: string;
  podmanPath: string;
  fuse2fsPath: string;
  supervisorPath: string;
  workspaceUid: number;
  workspaceGid: number;
  nativeToolsArtifact?: string;
}

export interface LocalResourceLimits {
  memoryBytes: number;
  milliCpu: number;
  pids: number;
  diskBytes: number;
}

export const RESOURCE_LABEL = "io.ezcorp.local-resource";
export const CONFIG_LABEL = "io.ezcorp.local-config";
export const WORKSPACE_DESTINATION = "/workspace";
export const NATIVE_TOOLS_DESTINATION = "/opt/ezharness/native-tools.js";

export interface BoundedCommandResult { code: number; stdout: string; stderr: string; timedOut: boolean }
export interface BoundedCommandOptions { timeoutMs: number; maxOutputBytes: number }

function captureBounded(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let retained = 0;
  const done = (async () => { for (;;) { const value = await reader.read(); if (value.done) break; if (retained < limit) { const part = value.value.subarray(0, limit - retained); chunks.push(part); retained += part.byteLength; } } })();
  return async () => { await Promise.race([done.catch(() => undefined), Bun.sleep(100)]); await reader.cancel().catch(() => undefined); await done.catch(() => undefined); const joined = new Uint8Array(retained); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; } return new TextDecoder().decode(joined); };
}

export async function runBoundedCommand(argv: string[], options: BoundedCommandOptions): Promise<BoundedCommandResult> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" }); const finishStdout = captureBounded(proc.stdout, options.maxOutputBytes); const finishStderr = captureBounded(proc.stderr, options.maxOutputBytes); let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, options.timeoutMs);
  try { const code = await proc.exited; const [stdout, stderr] = await Promise.all([finishStdout(), finishStderr()]); return { code, stdout, stderr, timedOut }; }
  finally { clearTimeout(timer); }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;

export function validateHostConfig(config: LocalPodmanHostConfig): LocalPodmanHostConfig {
  if (!resolve(config.stateRoot).startsWith(`${sep}var${sep}`) && !resolve(config.stateRoot).startsWith(`${sep}tmp${sep}`)) throw new Error("stateRoot must be absolute and private");
  if (!IMAGE_REFERENCE.test(config.imageReference)) throw new Error("imageReference must be qualified and digest-pinned");
  if (!/^[a-f0-9]{64}$/.test(config.imageId)) throw new Error("imageId must be an exact full image ID");
  for (const key of ["podmanPath", "fuse2fsPath", "supervisorPath"] as const) if (!isAbsolute(config[key])) throw new Error(`${key} must be absolute`);
  for (const key of ["workspaceUid", "workspaceGid"] as const) if (!Number.isSafeInteger(config[key]) || config[key] < 0 || config[key] > 2_147_483_647) throw new Error(`${key} must be a non-negative 32-bit integer`);
  if (config.nativeToolsArtifact !== undefined && !isAbsolute(config.nativeToolsArtifact)) throw new Error("nativeToolsArtifact must be absolute");
  return Object.freeze({
    ...config,
    stateRoot: resolve(config.stateRoot),
    nativeToolsArtifact: config.nativeToolsArtifact === undefined ? undefined : resolve(config.nativeToolsArtifact),
  });
}

export function resourceKey(resourceId: string): string {
  if (!ID.test(resourceId)) throw new Error("invalid resource id");
  return createHash("sha256").update(resourceId).digest("hex");
}
export function configurationDigest(config: LocalPodmanHostConfig, limits: LocalResourceLimits): string { return createHash("sha256").update(JSON.stringify({ imageReference: config.imageReference, imageId: config.imageId, workspaceUid: config.workspaceUid, workspaceGid: config.workspaceGid, limits, nativeToolsArtifact: config.nativeToolsArtifact ?? null })).digest("hex"); }
export function containerIdFromCreateOutput(output: string): string | null { const value = output.trim(); return /^[a-f0-9]{64}$/.test(value) ? value : null; }

export function validateProcessConfinement(status: string): void {
  const fields = new Map(status.split("\n").flatMap((line) => {
    const separator = line.indexOf(":");
    return separator === -1 ? [] : [[line.slice(0, separator), line.slice(separator + 1).trim()] as const];
  }));
  if (fields.get("Seccomp") !== "2" || fields.get("NoNewPrivs") !== "1") throw new Error("container process confinement is unavailable");
}

export interface ExpectedContainerIdentity {
  containerName: string;
  imageReference: string;
  imageId: string;
  user: string;
  labels: Readonly<Record<typeof RESOURCE_LABEL | typeof CONFIG_LABEL, string>>;
  networkMode: "none";
  pidMode: "private"; ipcMode: "private"; utsMode: null; privileged: false; capDrop: readonly string[]; securityOpt: readonly string[];
  readonlyRootfs: true;
  memoryBytes: number;
  memorySwapBytes: number;
  nanoCpus: number;
  pids: number;
  bindMounts: readonly { source: string; destination: string; readWrite: boolean }[];
}

export function expectedContainerIdentity(config: LocalPodmanHostConfig, resourceId: string, containerName: string, mount: string, limits: LocalResourceLimits): ExpectedContainerIdentity {
  return Object.freeze({
    containerName,
    imageReference: config.imageReference,
    imageId: config.imageId,
    user: `${config.workspaceUid}:${config.workspaceGid}`,
    labels: Object.freeze({ [RESOURCE_LABEL]: resourceKey(resourceId), [CONFIG_LABEL]: configurationDigest(config, limits) }),
    networkMode: "none",
    pidMode: "private", ipcMode: "private", utsMode: null, privileged: false, capDrop: Object.freeze(["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_FSETID", "CAP_KILL", "CAP_NET_BIND_SERVICE", "CAP_SETFCAP", "CAP_SETGID", "CAP_SETPCAP", "CAP_SETUID", "CAP_SYS_CHROOT"]), securityOpt: Object.freeze(["no-new-privileges"]),
    readonlyRootfs: true,
    memoryBytes: limits.memoryBytes,
    memorySwapBytes: limits.memoryBytes,
    nanoCpus: limits.milliCpu * 1_000_000,
    pids: limits.pids,
    bindMounts: Object.freeze([
      Object.freeze({ source: resolve(mount), destination: WORKSPACE_DESTINATION, readWrite: true }),
      ...(config.nativeToolsArtifact === undefined ? [] : [Object.freeze({ source: config.nativeToolsArtifact, destination: NATIVE_TOOLS_DESTINATION, readWrite: false })]),
    ]),
  });
}

export function resourcePaths(stateRoot: string, resourceId: string) {
  const root = resolve(stateRoot, resourceKey(resourceId));
  if (!root.startsWith(`${resolve(stateRoot)}${sep}`)) throw new Error("resource path escaped state root");
  return Object.freeze({ root, metadata: `${root}/metadata.json`, journal: `${root}/operations.jsonl`, image: `${root}/workspace.ext2`, mount: `${root}/workspace`, output: `${root}/output` });
}

export function createContainerArgv(config: LocalPodmanHostConfig, resourceId: string, containerName: string, mount: string, limits: LocalResourceLimits): string[] {
  if (!ID.test(containerName)) throw new Error("invalid container name");
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${name}`);
  const identity = expectedContainerIdentity(config, resourceId, containerName, mount, limits);
  const tools = config.nativeToolsArtifact ? [`--mount=type=bind,source=${config.nativeToolsArtifact},destination=${NATIVE_TOOLS_DESTINATION},ro`] : [];
  return [config.podmanPath, "--remote=false", "create", "--pull=never", "--name", containerName, "--user", identity.user,
    "--label", `${RESOURCE_LABEL}=${identity.labels[RESOURCE_LABEL]}`, "--label", `${CONFIG_LABEL}=${identity.labels[CONFIG_LABEL]}`, "--network=none", "--pid=private", "--ipc=private", "--uts=private", "--read-only", "--read-only-tmpfs=false", "--log-driver=none",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", `--memory=${limits.memoryBytes}`, `--memory-swap=${limits.memoryBytes}`,
    `--cpus=${limits.milliCpu / 1000}`, `--pids-limit=${limits.pids}`, "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16777216",
    `--mount=type=bind,source=${mount},destination=${WORKSPACE_DESTINATION},rw`, ...tools, config.imageReference, "sleep", "infinity"];
}
