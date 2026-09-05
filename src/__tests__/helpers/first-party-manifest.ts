import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { FramedExecution } from "@ezcorp/extension-runner";
import { validateManifest, type ExtensionManifestV4 } from "@ezcorp/extension-contract";
import { listFirstPartyExtensionSources } from "../../../scripts/migrate-extension-v4";
import { getProjectRoot } from "../../extensions/project-root";

const manifests = new Map<string, Promise<ExtensionManifestV4>>();

export async function withFirstPartyExecution<Result>(directory: string, inspect: (manifest: ExtensionManifestV4, execution: FramedExecution) => Promise<Result>): Promise<Result> {
  const root = getProjectRoot();
  const path = resolve(directory);
  const source = (await listFirstPartyExtensionSources(root)).find((candidate) => resolve(root, candidate.directory) === path);
  if (!source) throw new Error("Test discovery accepts only exact first-party inventory sources");
  const child = spawn(process.execPath, [resolve(path, source.entrypoint)], { cwd: path, stdio: "pipe", env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" } });
  const execution = new FramedExecution("first-party-metadata-test", child, async () => { throw new Error("Discovery has no host capabilities"); }, async () => { child.kill("SIGKILL"); }, 4 * 1024 * 1024, 10_000);
  try { return await inspect(validateManifest(await execution.request("extension/discover", {})), execution); }
  finally { await execution.close(); }
}

export async function discoverFirstPartyManifest(directory: string): Promise<ExtensionManifestV4> {
  const path = resolve(directory);
  const existing = manifests.get(path);
  if (existing) return existing;
  const discovered = withFirstPartyExecution(path, async (manifest) => manifest);
  manifests.set(path, discovered);
  try { return await discovered; } catch (error) { manifests.delete(path); throw error; }
}
