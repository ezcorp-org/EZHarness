import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createGenerator } from "ts-json-schema-generator";
import { factoryDefinitionJsonSchema, isFactoryDefinition } from "./schema";
import { referenceCodeV1 } from "./references";

describe("generated definition schema", () => {
  test("matches the authoritative TypeScript definition", () => {
    const generated = createGenerator({
      path: resolve(import.meta.dir, "types.ts"),
      tsconfig: resolve(import.meta.dir, "../tsconfig.build.json"),
      type: "FactoryDefinition",
      skipTypeCheck: true,
    }).createSchema("FactoryDefinition");
    expect(factoryDefinitionJsonSchema).toEqual(generated);
  });

  test("accepts a golden definition and rejects unknown or malformed fields", () => {
    expect(factoryDefinitionJsonSchema.$ref).toBe("#/definitions/FactoryDefinition");
    expect(isFactoryDefinition(referenceCodeV1)).toBe(true);
    expect(isFactoryDefinition({ ...referenceCodeV1, unknown: true })).toBe(false);
    expect(isFactoryDefinition({ ...referenceCodeV1, graph: { nodes: "bad", outputs: {} } })).toBe(false);
    expect(isFactoryDefinition({ ...referenceCodeV1, bounds: { ...referenceCodeV1.bounds, maxExpandedNodes: Number.NaN } })).toBe(false);
  });
});
