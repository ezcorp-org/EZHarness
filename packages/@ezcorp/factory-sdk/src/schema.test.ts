import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createGenerator } from "ts-json-schema-generator";
import {
  compiledExecutionManifestJsonSchema,
  compiledFactoryJsonSchema,
  compiledPartitionArtifactJsonSchema,
  factoryDefinitionJsonSchema,
  factoryRunnerRequestJsonSchema,
  factoryRunnerResultJsonSchema,
  factoryApiRequestJsonSchema,
  factoryApiResponseJsonSchema,
  factoryDurableInputJsonSchema,
  isFactoryDurableInput,
  isFactoryDefinition,
} from "./schema";
import { referenceCodeV1 } from "./references";
import { FACTORY_LAZY_INPUT_SCHEMA_VERSION } from "./types";

describe("generated definition schema", () => {
  test("matches every authoritative TypeScript wire definition", () => {
    const schemas = [
      ["FactoryDefinition", "urn:ezcorp:factory:definition:v1", factoryDefinitionJsonSchema],
      ["CompiledFactory", "urn:ezcorp:factory:compiled:v1", compiledFactoryJsonSchema],
      ["CompiledExecutionManifest", "urn:ezcorp:factory:execution-manifest:v1", compiledExecutionManifestJsonSchema],
      ["CompiledPartitionArtifact", "urn:ezcorp:factory:partition:v1", compiledPartitionArtifactJsonSchema],
      ["FactoryRunnerRequest", "urn:ezcorp:factory:runner-request:v1", factoryRunnerRequestJsonSchema],
      ["FactoryRunnerResult", "urn:ezcorp:factory:runner-result:v1", factoryRunnerResultJsonSchema],
      ["FactoryApiRequest", "urn:ezcorp:factory:api-request:v1", factoryApiRequestJsonSchema],
      ["FactoryApiResponse", "urn:ezcorp:factory:api-response:v1", factoryApiResponseJsonSchema],
      ["FactoryDurableInput", "urn:ezcorp:factory:lazy-input:v1", factoryDurableInputJsonSchema],
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

  test("the durable input descriptor has one constant and one generated schema", () => {
    expect(FACTORY_LAZY_INPUT_SCHEMA_VERSION).toBe("factory.lazy-input.v1");
    expect(factoryDurableInputJsonSchema.$ref).toBe("#/definitions/FactoryDurableInput");
    const descriptor = { schemaVersion: FACTORY_LAZY_INPUT_SCHEMA_VERSION, parameters: { data: { kind: "inline", value: 1 } } };
    expect(isFactoryDurableInput(descriptor)).toBe(true);
    expect(isFactoryDurableInput({ ...descriptor, schemaVersion: "factory.lazy-input.v2" })).toBe(false);
    expect(isFactoryDurableInput({ ...descriptor, unknown: true })).toBe(false);
    expect(isFactoryDurableInput({ schemaVersion: FACTORY_LAZY_INPUT_SCHEMA_VERSION })).toBe(false);
  });

  test("accepts a golden definition and rejects unknown or malformed fields", () => {
    expect(factoryDefinitionJsonSchema.$ref).toBe("#/definitions/FactoryDefinition");
    expect(isFactoryDefinition(referenceCodeV1)).toBe(true);
    expect(isFactoryDefinition({ ...referenceCodeV1, unknown: true })).toBe(false);
    expect(isFactoryDefinition({ ...referenceCodeV1, graph: { nodes: "bad", outputs: {} } })).toBe(false);
    expect(isFactoryDefinition({ ...referenceCodeV1, bounds: { ...referenceCodeV1.bounds, maxExpandedNodes: Number.NaN } })).toBe(false);
  });
});
