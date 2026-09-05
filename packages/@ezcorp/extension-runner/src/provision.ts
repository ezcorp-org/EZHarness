import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { RunnerError } from "./core";

const require = createRequire(import.meta.url);
type Provision = { sdkFiles: WorkspaceFiles; toolchainFiles: WorkspaceFiles };
const provisions = new Map<string, Promise<Provision>>();
async function readTree(path: string, destination: string, declarationsOnly = false): Promise<WorkspaceFiles> {
  const files: WorkspaceFiles = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules") await visit(join(directory, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile() && (!declarationsOnly || entry.name.endsWith(".d.ts"))) files[`${destination}/${prefix}${entry.name}`] = await readFile(join(directory, entry.name), "utf8");
      else if (entry.isSymbolicLink()) throw new RunnerError("toolchain_link", "Trusted toolchain package contains a symbolic link");
    }
  }
  await visit(path, "");
  return files;
}
async function packageFiles(name: string): Promise<WorkspaceFiles> {
  const resolvePaths = [dirname(require.resolve("@types/bun/package.json")), dirname(require.resolve("@types/node/package.json")), import.meta.dirname];
  const path = await realpath(dirname(require.resolve(`${name}/package.json`, { paths: resolvePaths })));
  return readTree(path, `node_modules/${name}`);
}

export async function provisionToolchain(options: { sdkEntrypoint?: string } = {}): Promise<Provision> {
  const entrypoint = options.sdkEntrypoint ?? new URL("../../sdk/src/v4/index.ts", import.meta.url).pathname;
  let provision = provisions.get(entrypoint);
  if (!provision) { provision = loadProvision(entrypoint).catch(error => { provisions.delete(entrypoint); throw error; }); provisions.set(entrypoint, provision); }
  return structuredClone(await provision);
}
async function loadProvision(entrypoint: string): Promise<Provision> {
  const sdkRoot = resolve(dirname(entrypoint), "../..");
  const sdkFiles = await bundleTrustedPackages(sdkRoot);
  const packageNames = ["typescript", "@types/bun", "bun-types", "@types/node", "undici-types"];
  const toolchainFiles: WorkspaceFiles = Object.assign({}, ...await Promise.all(packageNames.map(packageFiles)));
  return { sdkFiles, toolchainFiles };
}

async function bundleTrustedPackages(sdkRoot: string): Promise<WorkspaceFiles> {
  const root = resolve(sdkRoot, "..");
  const files: WorkspaceFiles = {};
  const sources: string[] = [];
  for (const name of ["sdk", "extension-contract"]) {
    const packageRoot = join(root, name);
    const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (name === "sdk") metadata.exports["./v4/runtime"] ??= { bun: "./src/v4/runtime.ts", types: "./dist/v4/runtime.d.ts" };
    const entrypoints = metadata.exports as Record<string, { bun: string; types: string }>;
    sources.push(...Object.values(entrypoints).map(value => resolve(packageRoot, value.bun)));
    const destination = `node_modules/${metadata.name}`;
    Object.assign(files, await readTree(join(packageRoot, "dist"), `${destination}/dist`, true));
    files[`${destination}/package.json`] = JSON.stringify({ name: metadata.name, version: metadata.version, type: "module", exports: Object.fromEntries(Object.entries(entrypoints).map(([entry, value]) => [entry, { types: value.types, default: value.bun.replace(/\.ts$/, ".js") }])) });
  }
  const result = await Bun.build({ entrypoints: sources, root, naming: { entry: "[dir]/[name].[ext]", chunk: "sdk/shared/[name]-[hash].[ext]" }, splitting: true, target: "bun", format: "esm", packages: "bundle" });
  if (!result.success) throw new RunnerError("sdk_build_failed", "Trusted SDK could not be bundled");
  for (const output of result.outputs) files[`node_modules/@ezcorp/${output.path.replace(/^(?:\.\/)+/, "")}`] = await output.text();
  return files;
}
