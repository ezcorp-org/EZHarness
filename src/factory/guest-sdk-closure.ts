/**
 * The factory SDK files a flat guest workspace needs, found by following
 * relative imports instead of listed by hand.
 *
 * A guest package stages SDK modules flat beside its own entry files. A fixed
 * list went stale once already: W14 added `console-types.ts`, `types.ts`
 * imports it, and every guest built from the list failed with TS2307. Walking
 * the imports means a new SDK module is staged the moment something imports it.
 *
 * Specifiers are rewritten from `./x.js` to `./x.ts`, because the guest build
 * type-checks the TypeScript sources directly. JSON schemas imported with
 * `./x.json` are staged as they are.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A relative specifier in `from "./x.js"`, `import "./x.json"`, or a type-position `import("./x.js")`. */
const RELATIVE = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']\.\/([A-Za-z0-9_.-]+?)\.(js|ts|json)["']/g;

/** The flat file each relative import of `source` names, in order of appearance. */
export function relativeImports(source: string): string[] {
  return [...source.matchAll(RELATIVE)].map(([, name, extension]) => `${name}.${extension === "json" ? "json" : "ts"}`);
}

/** A staged file: text, or an encoded binary that imports nothing. */
type StagedFile = string | { readonly data: string };

/** The relative imports of one staged file; a binary file has none. */
function stagedImports(file: StagedFile): string[] {
  return typeof file === "string" ? relativeImports(file) : [];
}

/** Relative imports of staged files that name no staged file, as `file -> missing`. */
export function unresolvedImports(files: Readonly<Record<string, StagedFile>>): string[] {
  return Object.entries(files).flatMap(([file, source]) => stagedImports(source).filter(target => !(target in files)).map(target => `${file} -> ${target}`));
}

export class FactorySdkClosureError extends Error {
  constructor(readonly module: string, readonly importedBy: string) {
    super(`factory_sdk_closure_missing: ${importedBy} imports ./${module}, which the SDK does not have`);
    this.name = "FactorySdkClosureError";
  }
}

/**
 * Every SDK file reachable from the relative imports of `seeds` (the guest's
 * own files, by flat name), rewritten for a flat workspace. A seed is never
 * looked up in the SDK. An import naming no file is refused by name.
 */
export async function factorySdkClosure(sdkDirectory: string, seeds: Readonly<Record<string, StagedFile>>, read: (path: string) => Promise<string> = path => readFile(path, "utf8")): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const pending = Object.entries(seeds).flatMap(([file, source]) => stagedImports(source).map(module => ({ module, importedBy: file })));
  while (pending.length > 0) {
    const { module, importedBy } = pending.shift()!;
    if (module in files || module in seeds) continue;
    let source: string;
    try { source = await read(join(sdkDirectory, module)); } catch { throw new FactorySdkClosureError(module, importedBy); }
    files[module] = module.endsWith(".json") ? source : source.replaceAll(/(\bfrom\s*|\bimport\s*\(?\s*)(["'])\.\/([A-Za-z0-9_.-]+?)\.js\2/g, "$1$2./$3.ts$2");
    pending.push(...relativeImports(source).map(next => ({ module: next, importedBy: module })));
  }
  return files;
}
