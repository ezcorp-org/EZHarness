import { expect, test } from "bun:test";
import { createGenerator } from "ts-json-schema-generator";
import { resolve } from "node:path";
import schema from "./wire-schema.json";

test("wire schema matches the authoritative data types", () => {
  const generated = createGenerator({ path: resolve(import.meta.dir, "types.ts"), tsconfig: resolve(import.meta.dir, "../tsconfig.build.json"), type: "WireData", skipTypeCheck: true }).createSchema("WireData");
  expect(schema).toEqual(generated);
});
