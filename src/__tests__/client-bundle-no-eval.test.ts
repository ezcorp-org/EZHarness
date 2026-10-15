/**
 * Browser code must never bundle the contract validators. Ajv compiles its
 * meta-schema with `new Function` when the module loads; the page CSP has no
 * 'unsafe-eval', so the page fails to load ("Error compiling schema"). That is
 * how the author page broke when permission-text.ts imported the contract root.
 *
 * The test follows the real client module graph: every value import that a
 * Svelte component or a client module under web/src makes into server source
 * (`$server/...`) or a workspace package (`@ezcorp/...`), bundled for the
 * browser with the conditions Vite uses for a client build, from web/.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";

const root = resolve(import.meta.dir, "../..");
const web = join(root, "web");
const cacheDir = join(web, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const scratch = mkdtempSync(join(cacheDir, "browser-bundle-check-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const transpiler = new Bun.Transpiler({ loader: "ts" });
/** Code that runs in the browser: not lib/server, not an API route, not a server-only or test module. */
const isClientFile = (path: string) => !path.startsWith("src/routes/api/") && !/(^|\/)(server|__tests__)\//.test(path) && !/\.(test|spec)\.ts$|\.server\.ts$|(^|\/)\+server\.ts$|hooks\.server/.test(path);

/** Runtime import specifiers of one client file (`import type` is dropped by the transpiler's scan). */
function runtimeImports(path: string): string[] {
  const text = readFileSync(join(web, path), "utf8");
  const code = path.endsWith(".svelte") ? [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join("\n") : text;
  return transpiler.scanImports(code).map(entry => entry.path);
}

function clientEntrySpecifiers(): string[] {
  const found = new Set<string>();
  for (const path of new Glob("src/**/*.{svelte,ts}").scanSync(web)) {
    if (!isClientFile(path)) continue;
    for (const specifier of runtimeImports(path)) if (specifier.startsWith("$server/") || specifier.startsWith("@ezcorp/")) found.add(specifier);
  }
  return [...found].sort();
}

const specifiers = clientEntrySpecifiers();

test("the client imports server or package code, including the author page's permission text", () => {
  expect(specifiers).toContain("$server/extensions/permission-text");
});

test.each(specifiers)("%s bundles for the browser without the contract validators", async specifier => {
  const entry = join(scratch, `${Bun.hash(specifier).toString(16)}.ts`);
  const target = specifier.startsWith("$server/") ? join(root, "src", specifier.slice("$server/".length)) : specifier;
  writeFileSync(entry, `export * from ${JSON.stringify(target)};\n`);
  const result = await Bun.build({ entrypoints: [entry], target: "browser", conditions: ["browser", "module", "import", "default"] });
  expect(result.logs.filter(log => log.level === "error").map(String)).toEqual([]);
  const code = await result.outputs[0]!.text();
  // Booleans, so a failure does not print the whole bundle.
  expect(code.includes("node_modules/ajv") || code.includes("ajv/dist")).toBe(false);
  expect(code.includes("new Function")).toBe(false);
});
