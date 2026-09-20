import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

export interface LocalPodmanHostConfig {
  stateRoot: string;
  imageDigest: string;
  podmanPath: string;
  fuse2fsPath: string;
  supervisorPath: string;
}

export interface LocalResourceLimits {
  memoryBytes: number;
  milliCpu: number;
  pids: number;
  diskBytes: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function validateHostConfig(config: LocalPodmanHostConfig): LocalPodmanHostConfig {
  if (!resolve(config.stateRoot).startsWith(`${sep}var${sep}`) && !resolve(config.stateRoot).startsWith(`${sep}tmp${sep}`)) throw new Error("stateRoot must be absolute and private");
  if (!DIGEST.test(config.imageDigest)) throw new Error("imageDigest must be an exact sha256 digest");
  for (const key of ["podmanPath", "fuse2fsPath", "supervisorPath"] as const) if (!config[key].startsWith(sep)) throw new Error(`${key} must be absolute`);
  return Object.freeze({ ...config, stateRoot: resolve(config.stateRoot) });
}

export function resourceKey(resourceId: string): string {
  if (!ID.test(resourceId)) throw new Error("invalid resource id");
  return createHash("sha256").update(resourceId).digest("hex");
}

export function resourcePaths(stateRoot: string, resourceId: string) {
  const root = resolve(stateRoot, resourceKey(resourceId));
  if (!root.startsWith(`${resolve(stateRoot)}${sep}`)) throw new Error("resource path escaped state root");
  return Object.freeze({ root, metadata: `${root}/metadata.json`, journal: `${root}/operations.jsonl`, image: `${root}/workspace.ext2`, mount: `${root}/workspace`, output: `${root}/output` });
}

export function createContainerArgv(config: LocalPodmanHostConfig, resourceId: string, containerName: string, mount: string, limits: LocalResourceLimits): string[] {
  if (!ID.test(containerName)) throw new Error("invalid container name");
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${name}`);
  return [config.podmanPath, "--remote=false", "create", "--pull=never", "--name", containerName,
    "--label", `io.ezcorp.local-resource=${resourceKey(resourceId)}`, "--network=none", "--read-only", "--read-only-tmpfs=false", "--log-driver=none",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", `--memory=${limits.memoryBytes}`, `--memory-swap=${limits.memoryBytes}`,
    `--cpus=${limits.milliCpu / 1000}`, `--pids-limit=${limits.pids}`, "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16777216",
    `--mount=type=bind,source=${mount},destination=/workspace,rw`, config.imageDigest, "sleep", "infinity"];
}
