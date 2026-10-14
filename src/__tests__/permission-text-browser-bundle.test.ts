/**
 * The author page imports permission-text.ts into the browser. Its module
 * graph must not reach the contract's validators: Ajv compiles its meta-schema
 * with `new Function` when the module loads, the page CSP has no
 * 'unsafe-eval', and the page then fails to load ("Error compiling schema").
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

test("permission-text bundles for the browser without the contract validators", async () => {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, "../extensions/permission-text.ts")], target: "browser" });
  expect(result.success).toBe(true);
  const code = await result.outputs[0]!.text();
  // Booleans, so a failure does not print the whole bundle.
  expect(code.includes("node_modules/ajv")).toBe(false);
  expect(code.includes("new Function")).toBe(false);
});
