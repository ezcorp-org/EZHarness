import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createGenerator } from "ts-json-schema-generator";
import {
  compiledFactoryJsonSchema,
  factoryDefinitionJsonSchema,
  factoryRunnerRequestJsonSchema,
  factoryRunnerResultJsonSchema,
  isFactoryDefinition,
} from "./schema";
import { referenceCodeV1 } from "./references";

describe("generated definition schema", () => {
  test("matches every authoritative TypeScript wire definition", () => {
    const schemas = [
      ["FactoryDefinition", "urn:ezcorp:factory:definition:v1", factoryDefinitionJsonSchema],
      ["CompiledFactory", "urn:ezcorp:factory:compiled:v1", compiledFactoryJsonSchema],
      ["FactoryRunnerRequest", "urn:ezcorp:factory:runner-request:v1", factoryRunnerRequestJsonSchema],
      ["FactoryRunnerResult", "urn:ezcorp:factory:runner-result:v1", factoryRunnerResultJsonSchema],
    ] as const;
    for (const [type, id, checkedIn] of schemas) {
      const generated = createGenerator({
        path: resolve(import.meta.dir, "types.ts"),
        tsconfig: resolve(import.meta.dir, "../tsconfig.build.json"),
        type,
        id,
        skipTypeCheck: true,
      }).createSchema(type);
      expect(checkedIn).toEqual({ $id: id, ...generated });
    }
  });

  test("accepts a golden definition and rejects unknown or malformed fields", () => {
    expect(factoryDefinitionJsonSchema.$ref).toBe("#/definitions/FactoryDefinition");
    expect(isFactoryDefinition(referenceCodeV1)).toBe(true);
    expect(isFactoryDefinition({ ...referenceCodeV1, unknown: true })).toBe(false);
    expect(isFactoryDefinition({ ...referenceCodeV1, graph: { nodes: "bad", outputs: {} } })).toBe(false);
    expect(isFactoryDefinition({ ...referenceCodeV1, bounds: { ...referenceCodeV1.bounds, maxExpandedNodes: Number.NaN } })).toBe(false);
  });
});
