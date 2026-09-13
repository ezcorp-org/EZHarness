import factoryDefinitionJsonSchema from "./factory-definition.schema.json";
import { validateIJson } from "./canonical";

export { factoryDefinitionJsonSchema };

type SchemaObject = Readonly<Record<string, unknown>>;

function own(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function resolveReference(root: SchemaObject, reference: string): SchemaObject | undefined {
  if (!reference.startsWith("#/definitions/")) return undefined;
  const name = reference.slice(14);
  const definitions = root.definitions;
  if (!definitions || typeof definitions !== "object" || Array.isArray(definitions) || !own(definitions, name)) return undefined;
  const target = (definitions as Record<string, unknown>)[name];
  return target && typeof target === "object" && !Array.isArray(target) ? (target as SchemaObject) : undefined;
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => equal(item, right[index]));
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const keys = Object.keys(leftObject);
  return keys.length === Object.keys(rightObject).length && keys.every((key) => own(rightObject, key) && equal(leftObject[key], rightObject[key]));
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
  if (schema.const !== undefined && !equal(schema.const, value)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => equal(candidate, value))) return false;
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.items && typeof schema.items === "object" && !value.every((item) => validate(schema.items as SchemaObject, root, item))) return false;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
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
