import { constants } from "node:fs";
import { access, mkdir, stat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { configureSandboxWorkspaceDispatcher } from "../workspace/target";
import { createSandboxWorkspaceDispatcher } from "../workspace/dispatcher";
import { configureSandboxController } from "./controller";
import { invokeSandboxProvider } from "./provider-invoker";
import { ResourceRoot } from "./local-podman/resource-root";
import { LocalPodmanDriver } from "./local-podman/driver";
import { runBoundedCommand, validateHostConfig, type LocalPodmanHostConfig } from "./local-podman/commands";

function parseHostConfig(value: unknown): LocalPodmanHostConfig {
  const paths = ["stateRoot", "imageReference", "imageId", "podmanPath", "fuse2fsPath", "supervisorPath", "nativeToolsArtifact"];
  const allowed = [...paths, "workspaceUid", "workspaceGid"];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local sandbox configuration");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key)) || paths.some(key => typeof record[key] !== "string") || record.workspaceUid !== 0 || record.workspaceGid !== 0) throw new Error("Invalid local sandbox configuration");
  return validateHostConfig(record as unknown as LocalPodmanHostConfig);
}

/** Only the host operator supplies this file. No project or provider value
 * selects an executable, image, or host directory. */
export async function loadLocalSandboxConfig(path: string): Promise<LocalPodmanHostConfig> {
  if (!isAbsolute(path)) throw new Error("Local sandbox configuration path must be absolute");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let config: LocalPodmanHostConfig;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0 || info.size > 16 * 1024) throw new Error("Local sandbox configuration must be a private, bounded, host-owned file");
    config = parseHostConfig(JSON.parse(await file.readFile("utf8")));
  } finally { await file.close(); }
  for (const [path, executable] of [[config.podmanPath, true], [config.fuse2fsPath, true], [config.supervisorPath, true], [config.nativeToolsArtifact!, false]] as const) {
    const info = await stat(path);
    if (!info.isFile() || (info.mode & 0o022) !== 0 || (info.uid !== 0 && info.uid !== process.getuid!())) throw new Error("Local sandbox artifacts must not be writable by other users");
    await access(path, executable ? constants.X_OK : constants.R_OK);
  }
  return config;
}

export async function verifyLocalSandboxHost(config: LocalPodmanHostConfig): Promise<void> {
  const result = await runBoundedCommand([config.podmanPath, "--remote=false", "info", "--format", "json"], { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 });
  if (result.code !== 0 || result.timedOut) throw new Error("Local sandbox runtime is unavailable");
  const info = JSON.parse(result.stdout) as { host?: { cgroupVersion?: string; security?: { rootless?: boolean; seccompEnabled?: boolean } } };
  if (info.host?.cgroupVersion !== "v2" || info.host.security?.rootless !== true || info.host.security.seccompEnabled !== true) throw new Error("Local sandbox requires rootless Podman, cgroups v2, and seccomp");
}

/** Existing installations remain usable when no local runtime is configured.
 * A configured but invalid runtime fails startup before any sandbox dispatch. */
export async function initializeLocalSandbox(path = process.env.EZHARNESS_LOCAL_SANDBOX_CONFIG): Promise<boolean> {
  configureSandboxWorkspaceDispatcher(null);
  if (!path) return false;
  const config = await loadLocalSandboxConfig(path);
  await verifyLocalSandboxHost(config);
  await mkdir(config.stateRoot, { recursive: true, mode: 0o700 });
  await new ResourceRoot(config.stateRoot).verifyPrivateRoot();
  const controller = configureSandboxController(new LocalPodmanDriver(config), undefined, invokeSandboxProvider);
  configureSandboxWorkspaceDispatcher(createSandboxWorkspaceDispatcher((...args) => controller.runNativeWorkspaceProcess(...args)));
  return true;
}
