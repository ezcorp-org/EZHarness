import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { RunnerError } from "./core";

const require = createRequire(import.meta.url);
type Provision = { sdkFiles: WorkspaceFiles; toolchainFiles: WorkspaceFiles };
/**
 * The SDK bundle and the toolchain are cached SEPARATELY, each under the only
 * input it depends on: the bundle on the SDK entrypoint, the toolchain on the
 * root it is read from. Caching the pair under both would rebuild an
 * identical bundle once per toolchain root, and a SECOND `Bun.build()` in one
 * `bun test` process reads the wrong files — bun's bundler reuses file
 * descriptors cached by the first build, which by then name whatever the
 * process opened after it. Measured on the isolated `node_modules/.bun`
 * layout (bun's default linker for a workspace repo since 1.3): build one
 * succeeds, build two reports `EISDIR` for regular files and parses
 * `typescript/package.json` as `@modelcontextprotocol/sdk/…/client/index.js`.
 * One cache per input holds the process to one build, which is also all the
 * inputs ever asked for.
 */
const sdkBundles = new Map<string, Promise<WorkspaceFiles>>();
const toolchains = new Map<string, Promise<WorkspaceFiles>>();
function cached(cache: Map<string, Promise<WorkspaceFiles>>, key: string, load: () => Promise<WorkspaceFiles>): Promise<WorkspaceFiles> {
  let pending = cache.get(key);
  if (!pending) { pending = load().catch(error => { cache.delete(key); throw error; }); cache.set(key, pending); }
  return pending;
}
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
/**
 * Where the five toolchain packages are looked up from. Resolution walks the
 * `node_modules` hierarchy upward from `root`, then from the resolved
 * `@types/bun` and `@types/node` directories (`bun-types` and `undici-types`
 * may be nested under them rather than hoisted).
 */
function toolchainResolvePaths(root: string): string[] {
  const from = { paths: [root] };
  return [dirname(require.resolve("@types/bun/package.json", from)), dirname(require.resolve("@types/node/package.json", from)), root];
}
async function packageFiles(name: string, resolvePaths: string[]): Promise<WorkspaceFiles> {
  const path = await realpath(dirname(require.resolve(`${name}/package.json`, { paths: resolvePaths })));
  return readTree(path, `node_modules/${name}`);
}

/**
 * `toolchainRoot` names the tree the trusted toolchain is provisioned from.
 * The default — this module's own directory — is right for the host runner,
 * which always runs from source. It is WRONG for any caller that has been
 * bundled elsewhere (the in-process trusted-local runner inside the SvelteKit
 * server build): from `web/build/server/…` the walk finds `web/node_modules`
 * first, which carries a different `typescript` major than the pinned root
 * closure and no `@types/bun` at all. "Only from the installed trusted
 * application release" therefore requires the caller to say where that is.
 */
export async function provisionToolchain(options: { sdkEntrypoint?: string; toolchainRoot?: string } = {}): Promise<Provision> {
  const entrypoint = options.sdkEntrypoint ?? new URL("../../sdk/src/v4/index.ts", import.meta.url).pathname;
  const toolchainRoot = options.toolchainRoot ?? import.meta.dirname;
  // Sequential, not Promise.all: the bundler's file-descriptor cache is what
  // this split exists to protect, so don't interleave unrelated reads with it.
  const sdkFiles = await cached(sdkBundles, entrypoint, () => bundleTrustedPackages(resolve(dirname(entrypoint), "../..")));
  const toolchainFiles = await cached(toolchains, toolchainRoot, () => loadToolchain(toolchainRoot));
  return structuredClone({ sdkFiles, toolchainFiles });
}
async function loadToolchain(toolchainRoot: string): Promise<WorkspaceFiles> {
  const packageNames = ["typescript", "@types/bun", "bun-types", "@types/node", "undici-types"];
  const resolvePaths = toolchainResolvePaths(toolchainRoot);
  return Object.assign({}, ...await Promise.all(packageNames.map(name => packageFiles(name, resolvePaths))));
}

async function bundleTrustedPackages(sdkRoot: string): Promise<WorkspaceFiles> {
  const root = resolve(sdkRoot, "..");
  const files: WorkspaceFiles = {};
  const sources: string[] = [];
  for (const name of ["sdk", "extension-contract"]) {
    const packageRoot = join(root, name);
    const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (name === "sdk") metadata.exports["./v4/runtime"] ??= { bun: "./src/v4/runtime.ts", types: "./dist/v4/runtime.d.ts" };
    const entrypoints = metadata.exports as Record<string, { bun?: string; types: string }>;
    sources.push(...Object.values(entrypoints).flatMap(value => value.bun ? [resolve(packageRoot, value.bun)] : []));
    const destination = `node_modules/${metadata.name}`;
    Object.assign(files, await readTree(join(packageRoot, "dist"), `${destination}/dist`, true));
    Object.assign(files, await readTree(join(packageRoot, "src"), `${destination}/src`, true));
    files[`${destination}/package.json`] = JSON.stringify({ name: metadata.name, version: metadata.version, type: "module", exports: Object.fromEntries(Object.entries(entrypoints).map(([entry, value]) => [entry, { types: value.types, ...(value.bun ? { default: value.bun.replace(/\.ts$/, ".js") } : {}) }])) });
  }
  const result = await Bun.build({ entrypoints: sources, root, naming: { entry: "[dir]/[name].[ext]", chunk: "sdk/shared/[name]-[hash].[ext]" }, splitting: true, target: "bun", format: "esm", packages: "bundle" });
  if (!result.success) throw new RunnerError("sdk_build_failed", "Trusted SDK could not be bundled");
  for (const output of result.outputs) files[`node_modules/@ezcorp/${output.path.replace(/^(?:\.\/)+/, "")}`] = await output.text();
  return files;
}
