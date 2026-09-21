import factoryDefinitionJsonSchema from "./factory-definition.schema.json" with { type: "json" };
import compiledFactoryJsonSchema from "./compiled-factory.schema.json" with { type: "json" };
import compiledExecutionManifestJsonSchema from "./compiled-execution-manifest.schema.json" with { type: "json" };
import compiledPartitionArtifactJsonSchema from "./compiled-partition-artifact.schema.json" with { type: "json" };
import factoryRunnerRequestJsonSchema from "./factory-runner-request.schema.json" with { type: "json" };
import factoryRunnerResultJsonSchema from "./factory-runner-result.schema.json" with { type: "json" };
import factoryApiRequestJsonSchema from "./factory-api-request.schema.json" with { type: "json" };
import factoryApiResponseJsonSchema from "./factory-api-response.schema.json" with { type: "json" };
import factoryValidatorClaimsJsonSchema from "./factory-validator-claims.schema.json" with { type: "json" };
import factoryValidatorReportJsonSchema from "./factory-validator-report.schema.json" with { type: "json" };
import factoryDurableInputJsonSchema from "./factory-durable-input.schema.json" with { type: "json" };
import factoryGuestModelRequestJsonSchema from "./factory-guest-model-request.schema.json" with { type: "json" };
import factoryGuestModelResponseJsonSchema from "./factory-guest-model-response.schema.json" with { type: "json" };
import { jsonEqual, unicodeLength, validateIJson } from "./canonical.js";
import type { CompiledExecutionManifest, CompiledFactory, CompiledPartitionArtifact, FactoryApiRequest, FactoryApiResponse, FactoryDurableInput, FactoryGuestModelRequest, FactoryGuestModelResponse, FactoryRunnerRequest, FactoryRunnerResult, FactoryValidatorClaimReport, FactoryValidatorReport, JsonValue } from "./types.js";

export {
  compiledFactoryJsonSchema,
  compiledExecutionManifestJsonSchema,
  compiledPartitionArtifactJsonSchema,
  factoryDefinitionJsonSchema,
  factoryRunnerRequestJsonSchema,
  factoryRunnerResultJsonSchema,
  factoryApiRequestJsonSchema,
  factoryApiResponseJsonSchema,
  factoryValidatorClaimsJsonSchema,
  factoryValidatorReportJsonSchema,
  factoryDurableInputJsonSchema,
  factoryGuestModelRequestJsonSchema,
  factoryGuestModelResponseJsonSchema,
};

type SchemaObject = Readonly<Record<string, unknown>>;

function own(object: object, key: PropertyKey): boolean {
  return  Object.hasOwn(object, key);
}

function resolveReference(root: SchemaObject, reference: string): SchemaObject | undefined {
  if (!reference.startsWith("#/definitions/")) return undefined;
  const name = decodeURIComponent(reference.slice(14));
  const definitions = root.definitions;
  if (!definitions || typeof definitions !== "object" || Array.isArray(definitions) || !own(definitions, name)) return undefined;
  const target = (definitions as Record<string, unknown>)[name];
  return target && typeof target === "object" && !Array.isArray(target) ? (target as SchemaObject) : undefined;
}

function typeMatches(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  return typeof value === type;
}

function validate(schema: SchemaObject, root: SchemaObject, value: unknown): boolean {
  if (typeof schema.$ref === "string") {
    const target = resolveReference(root, schema.$ref);
    return target ? validate(target, root, value) : false;
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((candidate) => candidate && typeof candidate === "object" && validate(candidate as SchemaObject, root, value))) return false;
  if (typeof schema.type === "string" && !typeMatches(schema.type, value)) return false;
  if (Array.isArray(schema.type) && !schema.type.some((candidate) => typeof candidate === "string" && typeMatches(candidate, value))) return false;
  if (schema.const !== undefined && !jsonEqual(schema.const as JsonValue, value as JsonValue)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(candidate as JsonValue, value as JsonValue))) return false;
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.items && typeof schema.items === "object" && !value.every((item) => validate(schema.items as SchemaObject, root, item))) return false;
  }
  if (typeof value === "string") {
    const length = unicodeLength(value);
    if (typeof schema.minLength === "number" && length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && length > schema.maxLength) return false;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return false;
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (Array.isArray(schema.required) && schema.required.some((key) => typeof key !== "string" || !own(object, key))) return false;
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? (schema.properties as Record<string, unknown>) : {};
    for (const [key, child] of Object.entries(object)) {
      if (own(properties, key)) {
        const property = properties[key];
        if (!property || typeof property !== "object" || Array.isArray(property) || !validate(property as SchemaObject, root, child)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object" && !validate(schema.additionalProperties as SchemaObject, root, child)) return false;
    }
  }
  return true;
}

export function isFactoryDefinition(value: unknown): boolean {
  return validateIJson(value).ok && validate(factoryDefinitionJsonSchema as SchemaObject, factoryDefinitionJsonSchema as SchemaObject, value);
}

function matchesGeneratedSchema(schema: SchemaObject, value: unknown): boolean {
  return validateIJson(value).ok && validate(schema, schema, value);
}

export function isCompiledFactory(value: unknown): value is CompiledFactory {
  return matchesGeneratedSchema(compiledFactoryJsonSchema as SchemaObject, value);
}

export function isCompiledExecutionManifest(value: unknown): value is CompiledExecutionManifest {
  return matchesGeneratedSchema(compiledExecutionManifestJsonSchema as SchemaObject, value);
}

export function isCompiledPartitionArtifact(value: unknown): value is CompiledPartitionArtifact {
  return matchesGeneratedSchema(compiledPartitionArtifactJsonSchema as SchemaObject, value);
}

export function isFactoryRunnerRequest(value: unknown): value is FactoryRunnerRequest {
  return matchesGeneratedSchema(factoryRunnerRequestJsonSchema as SchemaObject, value);
}

export function isFactoryRunnerResult(value: unknown): value is FactoryRunnerResult {
  return matchesGeneratedSchema(factoryRunnerResultJsonSchema as SchemaObject, value);
}

export function isFactoryGuestModelRequest(value: unknown): value is FactoryGuestModelRequest {
  return matchesGeneratedSchema(factoryGuestModelRequestJsonSchema as SchemaObject, value);
}

export function isFactoryGuestModelResponse(value: unknown): value is FactoryGuestModelResponse {
  return matchesGeneratedSchema(factoryGuestModelResponseJsonSchema as SchemaObject, value);
}

export function isFactoryApiRequest(value: unknown): value is FactoryApiRequest {
  return matchesGeneratedSchema(factoryApiRequestJsonSchema as SchemaObject, value);
}

export function isFactoryApiResponse(value: unknown): value is FactoryApiResponse {
  return matchesGeneratedSchema(factoryApiResponseJsonSchema as SchemaObject, value);
}

export function isFactoryValidatorClaimReport(value: unknown): value is FactoryValidatorClaimReport {
  return matchesGeneratedSchema(factoryValidatorClaimsJsonSchema as SchemaObject, value);
}

export function isFactoryValidatorReport(value: unknown): value is FactoryValidatorReport {
  return matchesGeneratedSchema(factoryValidatorReportJsonSchema as SchemaObject, value);
}

export function isFactoryDurableInput(value: unknown): value is FactoryDurableInput {
  return matchesGeneratedSchema(factoryDurableInputJsonSchema as SchemaObject, value);
}
