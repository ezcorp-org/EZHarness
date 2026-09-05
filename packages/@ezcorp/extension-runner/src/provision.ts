import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
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
  const metadata = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
  const entrypoints = Object.fromEntries(Object.entries(metadata.exports as Record<string, { bun: string; types: string }>).map(([name, target]) => [name, { source: resolve(sdkRoot, target.bun), types: target.types }]));
  entrypoints["./v4/runtime"] ??= { source: join(sdkRoot, "src/v4/runtime.ts"), types: "./dist/v4/runtime.d.ts" };
  const result = await Bun.build({ entrypoints: Object.values(entrypoints).map(value => value.source), root: join(sdkRoot, "src"), naming: "[dir]/[name].[ext]", splitting: true, target: "bun", format: "esm", packages: "bundle" });
  if (!result.success) throw new RunnerError("sdk_build_failed", "Trusted SDK could not be bundled");
  const sdkFiles: WorkspaceFiles = await readTree(join(sdkRoot, "dist"), "node_modules/@ezcorp/sdk/dist", true);
  sdkFiles["node_modules/@ezcorp/sdk/package.json"] = JSON.stringify({ name: "@ezcorp/sdk", version: "4.0.0", type: "module", exports: Object.fromEntries(Object.entries(entrypoints).map(([name, value]) => [name, { types: value.types, default: `./${relative(join(sdkRoot, "src"), value.source).replace(/\.ts$/, ".js")}` }])) });
  for (const output of result.outputs) sdkFiles[`node_modules/@ezcorp/sdk/${output.path.replace(/^(?:\.\/)+/, "")}`] = await output.text();
  const packageNames = ["typescript", "@types/bun", "bun-types", "@types/node", "undici-types"];
  const toolchainFiles: WorkspaceFiles = Object.assign({}, ...await Promise.all(packageNames.map(packageFiles)));
  const contractRoot = resolve(dirname(require.resolve("@ezcorp/extension-contract")), "..");
  Object.assign(toolchainFiles, await readTree(join(contractRoot, "dist"), "node_modules/@ezcorp/extension-contract/dist", true));
  toolchainFiles["node_modules/@ezcorp/extension-contract/package.json"] = await readFile(join(contractRoot, "package.json"), "utf8");
  return { sdkFiles, toolchainFiles };
}
