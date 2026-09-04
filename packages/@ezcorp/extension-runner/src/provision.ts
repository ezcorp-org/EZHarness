import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { RunnerError } from "./core";

const require = createRequire(import.meta.url);
type Provision = { sdkFiles: WorkspaceFiles; toolchainFiles: WorkspaceFiles };
const provisions = new Map<string, Promise<Provision>>();
async function packageFiles(name: string): Promise<WorkspaceFiles> {
  const resolvePaths = [dirname(require.resolve("@types/bun/package.json")), dirname(require.resolve("@types/node/package.json")), import.meta.dirname];
  const path = await realpath(dirname(require.resolve(`${name}/package.json`, { paths: resolvePaths })));
  const files: WorkspaceFiles = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules") await visit(join(directory, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) files[`node_modules/${name}/${prefix}${entry.name}`] = await readFile(join(directory, entry.name), "utf8");
      else if (entry.isSymbolicLink()) throw new RunnerError("toolchain_link", "Trusted toolchain package contains a symbolic link");
    }
  }
  await visit(path, "");
  return files;
}

export async function provisionToolchain(options: { sdkEntrypoint?: string } = {}): Promise<Provision> {
  const entrypoint = options.sdkEntrypoint ?? new URL("../../sdk/src/v4/index.ts", import.meta.url).pathname;
  let provision = provisions.get(entrypoint);
  if (!provision) { provision = loadProvision(entrypoint).catch(error => { provisions.delete(entrypoint); throw error; }); provisions.set(entrypoint, provision); }
  return structuredClone(await provision);
}
async function loadProvision(entrypoint: string): Promise<Provision> {
  const result = await Bun.build({ entrypoints: [entrypoint], target: "bun", format: "esm", packages: "bundle" });
  if (!result.success) throw new RunnerError("sdk_build_failed", "Trusted SDK could not be bundled");
  const sdkFiles = {
    "node_modules/@ezcorp/sdk/package.json": JSON.stringify({ name: "@ezcorp/sdk", version: "4.0.0", type: "module", exports: { "./v4": "./v4.js" } }),
    "node_modules/@ezcorp/sdk/v4.js": await result.outputs[0]!.text(),
  };
  const packageNames = ["typescript", "@types/bun", "bun-types", "@types/node", "undici-types"];
  const toolchainFiles: WorkspaceFiles = Object.assign({}, ...await Promise.all(packageNames.map(packageFiles)));
  return { sdkFiles, toolchainFiles };
}
