import { describe, expect, test } from "bun:test";
import { factoryDefinitionJsonSchema, isFactoryDefinition } from "./schema";
import { referenceCodeV1 } from "./references";

describe("generated definition schema", () => {
  test("accepts a golden definition and rejects unknown or malformed fields", () => {
    expect(factoryDefinitionJsonSchema.$ref).toBe("#/definitions/FactoryDefinition");
    expect(isFactoryDefinition(referenceCodeV1)).toBe(true);
    expect(isFactoryDefinition({ ...referenceCodeV1, unknown: true })).toBe(false);
    expect(isFactoryDefinition({ ...referenceCodeV1, graph: { nodes: "bad", outputs: {} } })).toBe(false);
    expect(isFactoryDefinition({ ...referenceCodeV1, bounds: { ...referenceCodeV1.bounds, maxExpandedNodes: Number.NaN } })).toBe(false);
  });
});
