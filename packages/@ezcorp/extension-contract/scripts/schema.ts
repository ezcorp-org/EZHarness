import { createGenerator } from "ts-json-schema-generator";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const root = resolve(import.meta.dir, "..");
const schema = createGenerator({ path: resolve(root, "src/types.ts"), tsconfig: resolve(root, "tsconfig.build.json"), type: "WireData", skipTypeCheck: true }).createSchema("WireData");
const text = `${JSON.stringify(schema, null, 2)}\n`;
const target = resolve(root, "src/wire-schema.json");
if (process.argv.includes("--check")) {
  if (!isDeepStrictEqual(JSON.parse(await readFile(target, "utf8")), schema)) throw new Error("Wire schema differs from canonical types; run schema:generate");
} else {
  await writeFile(target, text);
}
