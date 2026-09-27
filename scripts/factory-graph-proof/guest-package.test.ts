import { expect, test } from "bun:test";
import { join } from "node:path";
import { unresolvedImports } from "../lib/factory-sdk-closure";
import { graphGuestSource } from "./guest-package";

const REPO = join(import.meta.dir, "..", "..");

// The guard for the W14 regression: types.ts gained an import of console-types.ts, a fixed module list
// left it out, and the guest build failed with TS2307. Every relative import of every staged file must
// name a file the package stages, for the SDK as it is now.
test("every relative import in the staged graph guest names a staged file", async () => {
  const files = await graphGuestSource(REPO);
  expect(unresolvedImports(files)).toEqual([]);
  // The entry files and the SDK's type root are staged, with the schemas the validators import.
  for (const name of ["extension.ts", "graph-guest.ts", "feature.test.ts", "types.ts", "console-types.ts", "guest-materials.ts", "factory-runner-result.schema.json"]) expect(files).toHaveProperty([name]);
  // No SDK specifier is left pointing at a .js file the flat workspace does not have.
  expect(Object.entries(files).filter(([name, source]) => name.endsWith(".ts") && /from\s*["']\.\/[^"']+\.js["']/.test(source)).map(([name]) => name)).toEqual([]);
});
