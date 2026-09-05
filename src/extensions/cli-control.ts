import { basename, dirname, isAbsolute, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { buildLimits, filesDigest, RunnerClient } from "@ezcorp/extension-runner";
import { getUserById } from "../db/queries/users";
import { getExtensionByName } from "../db/queries/extensions";
import { getExtensionLifecycle } from "./extension-lifecycle-service";
import { createExtensionFiles } from "./extension-control";
import { importExtensionSource, type ExtensionSourceInput } from "./source-import";
import { snapshotExtensionSource } from "../../scripts/migrate-extension-v4";
import { LifecycleError, type LifecycleActor } from "./v4/types";

export function parseExtensionSource(source: string): ExtensionSourceInput {
  if (source.startsWith("bundled:")) return { kind: "bundled", name: source.slice(8) };
  if (source.startsWith("https://")) {
    const url = new URL(source);
    if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash || !/^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname)) throw new LifecycleError("invalid_source", "Use a GitHub repository URL or a local source directory.");
    return { kind: "github", repository: url.pathname.slice(1).replace(/\/$/, "").replace(/\.git$/, "") };
  }
  if (source.startsWith("github:")) return { kind: "github", repository: source.slice(7) };
  if (source.includes(":") && !isAbsolute(source)) throw new LifecycleError("invalid_source", "Other Git transports are not approved. Import a reviewed local snapshot instead.");
  return { kind: "local", path: resolve(source) };
}

async function cliActor(): Promise<LifecycleActor> {
  const principalId = process.env.EZCORP_USER_ID;
  const user = principalId ? await getUserById(principalId) : undefined;
  if (user?.status !== "active" || user.role !== "admin") throw new LifecycleError("human_admin_required", "Set EZCORP_USER_ID to an active administrator. CLI commands cannot approve releases.");
  return { principalId: user.id, scope: "global", kind: "human" };
}

export async function stageCliExtension(source: string) { return importExtensionSource(await cliActor(), parseExtensionSource(source)); }

export async function updateCliExtension(name: string) {
  const actor = await cliActor();
  const extension = await getExtensionByName(name);
  if (!extension) throw new LifecycleError("not_found", "Extension not found.");
  const lifecycle = await getExtensionLifecycle();
  const state = await lifecycle.inspect(actor, extension.id);
  if (!state.installation.activeReleaseId) throw new LifecycleError("release_required", "No active release exists to fork.");
  const created = await lifecycle.createWorkspace(actor, { installationId: extension.id, releaseId: state.installation.activeReleaseId });
  return { ...created, openUrl: `/extensions/author?installation=${encodeURIComponent(extension.id)}&workspace=${encodeURIComponent(created.workspace.id)}` };
}

export async function removeCliExtension(name: string): Promise<void> {
  const actor = await cliActor();
  const extension = await getExtensionByName(name);
  if (!extension) throw new LifecycleError("not_found", "Extension not found.");
  await (await getExtensionLifecycle()).uninstall(actor, extension.id);
}

export async function initCliExtension(name: string): Promise<string> {
  const files = createExtensionFiles(name);
  const directory = resolve(name);
  await mkdir(directory);
  for (const [path, contents] of Object.entries(files)) {
    const destination = resolve(directory, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, { flag: "wx", mode: 0o600 });
  }
  return directory;
}

export function getCliExtensionRunner(): RunnerClient {
  const socketPath = process.env.EZCORP_EXTENSION_RUNNER_SOCKET;
  const token = process.env.EZCORP_EXTENSION_RUNNER_TOKEN;
  if (!socketPath || !isAbsolute(socketPath) || !token || token.length < 32) throw new LifecycleError("runner_unconfigured", "Configure the authenticated isolated extension runner before testing source.");
  return new RunnerClient({ socketPath, token });
}

export async function verifyCliExtension(directory: string) {
  const runner = getCliExtensionRunner();
  const path = resolve(directory);
  const { files } = await snapshotExtensionSource(dirname(path), { name: basename(path), directory: basename(path), entrypoint: "extension.ts" });
  return runner.build({ operationId: crypto.randomUUID(), sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
}
