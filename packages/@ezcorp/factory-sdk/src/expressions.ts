import { validateIJson } from "./canonical";
import { FACTORY_LIMITS, type BinaryExpression, type Expression, type ExpressionContext, type ExpressionResult, type JsonValue, type ValueReference } from "./types";

const MISSING = Symbol("missing");

function own(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function fail(code: string, message: string): ExpressionResult {
  return { ok: false, code, message };
}

function spend(budget: EvaluationBudget): boolean {
  budget.steps += 1;
  return budget.steps <= FACTORY_LIMITS.maxExpressionSteps;
}

function readReference(reference: ValueReference, context: ExpressionContext, budget: EvaluationBudget): JsonValue | typeof MISSING {
  const root = reference.root === "input" ? context.inputs : reference.root === "node" ? context.nodes : reference.root === "map" ? context.map : context.loop;
  if (!root || !own(root, reference.name)) return MISSING;
  let value: JsonValue | undefined = root[reference.name];
  for (const segment of reference.path ?? []) {
    if (!spend(budget)) return MISSING;
    if (typeof segment === "number") {
      if (!Array.isArray(value) || !Number.isSafeInteger(segment) || segment < 0 || segment >= value.length) return MISSING;
      value = value[segment];
    } else {
      if (!value || typeof value !== "object" || Array.isArray(value) || !own(value, segment)) return MISSING;
      value = value[segment];
    }
  }
  return value === undefined ? MISSING : value;
}

interface EvaluationBudget {
  nodes: number;
  steps: number;
}

const EXPRESSION_KINDS = new Set(["literal", "ref", "exists", "eq", "lt", "lte", "gt", "gte", "not", "and", "or", "in", "length"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => own(record, key)) && Object.keys(record).every((key) => required.includes(key) || optional.includes(key));
}

function inspect(expression: unknown, budget: EvaluationBudget, depth: number): ExpressionResult | undefined {
  budget.nodes += 1;
  if (budget.nodes > FACTORY_LIMITS.maxExpressionNodes) return fail("EXPRESSION_NODE_LIMIT", "Expression exceeds the AST node limit.");
  if (depth > FACTORY_LIMITS.maxExpressionDepth) return fail("EXPRESSION_DEPTH_LIMIT", "Expression exceeds the depth limit.");
  if (!isRecord(expression) || typeof expression.kind !== "string" || !EXPRESSION_KINDS.has(expression.kind)) return fail("EXPRESSION_KIND", "Expression kind is unsupported.");
  if (expression.kind === "literal") return exactKeys(expression, ["kind", "value"]) ? undefined : fail("EXPRESSION_SHAPE", "literal has invalid fields.");
  if (expression.kind === "ref") {
    if (!exactKeys(expression, ["kind", "root", "name"], ["path"])) return fail("EXPRESSION_SHAPE", "ref has invalid fields.");
    if (!(["input", "node", "map", "loop"] as const).includes(expression.root as never) || typeof expression.name !== "string") return fail("EXPRESSION_REFERENCE", "ref root and name are invalid.");
    if (expression.path !== undefined && (!Array.isArray(expression.path) || expression.path.some((segment) => typeof segment !== "string" && !(typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0)))) return fail("EXPRESSION_REFERENCE", "ref path is invalid.");
    return undefined;
  }
  const children: unknown[] = [];
  if (expression.kind === "exists") {
    if (!exactKeys(expression, ["kind", "value"]) || !isRecord(expression.value) || expression.value.kind !== "ref") return fail("EXPRESSION_SHAPE", "exists requires one ref.");
    children.push(expression.value);
  } else if (expression.kind === "not" || expression.kind === "length") {
    if (!exactKeys(expression, ["kind", "value"])) return fail("EXPRESSION_SHAPE", `${expression.kind} has invalid fields.`);
    children.push(expression.value);
  } else if (expression.kind === "and" || expression.kind === "or") {
    if (!exactKeys(expression, ["kind", "values"]) || !Array.isArray(expression.values)) return fail("EXPRESSION_SHAPE", `${expression.kind} requires values.`);
    children.push(...expression.values);
  } else if (expression.kind === "in") {
    if (!exactKeys(expression, ["kind", "value", "collection"])) return fail("EXPRESSION_SHAPE", "in has invalid fields.");
    children.push(expression.value, expression.collection);
  } else {
    if (!exactKeys(expression, ["kind", "left", "right"])) return fail("EXPRESSION_SHAPE", `${expression.kind} has invalid fields.`);
    children.push(expression.left, expression.right);
  }
  for (const child of children) {
    const result = inspect(child, budget, depth + 1);
    if (result) return result;
  }
  return undefined;
}

function equalBounded(left: JsonValue, right: JsonValue, budget: EvaluationBudget): boolean | typeof MISSING {
  if (!spend(budget)) return MISSING;
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      const result = equalBounded(left[index] as JsonValue, right[index] as JsonValue, budget);
      if (result !== true) return result;
    }
    return true;
  }
  const leftObject = left as Record<string, JsonValue>;
  const rightObject = right as Record<string, JsonValue>;
  const keys = Object.keys(leftObject);
  if (keys.length !== Object.keys(rightObject).length) return false;
  for (const key of keys) {
    if (!own(rightObject, key)) return false;
    const result = equalBounded(leftObject[key] as JsonValue, rightObject[key] as JsonValue, budget);
    if (result !== true) return result;
  }
  return true;
}

function evaluate(expression: Expression, context: ExpressionContext, budget: EvaluationBudget, depth: number): ExpressionResult {
  budget.steps += 1;
  if (budget.steps > FACTORY_LIMITS.maxExpressionSteps) return fail("EXPRESSION_STEP_LIMIT", "Expression exceeds the evaluation step limit.");

  if (expression.kind === "literal") return { ok: true, value: expression.value };
  if (expression.kind === "ref") {
    const value = readReference(expression, context, budget);
    return value === MISSING ? fail(budget.steps > FACTORY_LIMITS.maxExpressionSteps ? "EXPRESSION_STEP_LIMIT" : "EXPRESSION_REFERENCE_MISSING", budget.steps > FACTORY_LIMITS.maxExpressionSteps ? "Expression exceeds the evaluation step limit." : "Expression reference is missing.") : { ok: true, value };
  }
  if (expression.kind === "exists") {
    const value = readReference(expression.value, context, budget);
    return budget.steps > FACTORY_LIMITS.maxExpressionSteps ? fail("EXPRESSION_STEP_LIMIT", "Expression exceeds the evaluation step limit.") : { ok: true, value: value !== MISSING };
  }
  if (expression.kind === "not") {
    const value = evaluate(expression.value, context, budget, depth + 1);
    if (!value.ok) return value;
    return typeof value.value === "boolean" ? { ok: true, value: !value.value } : fail("EXPRESSION_BOOLEAN_REQUIRED", "not requires a boolean.");
  }
  if (expression.kind === "and" || expression.kind === "or") {
    for (const child of expression.values) {
      const value = evaluate(child, context, budget, depth + 1);
      if (!value.ok) return value;
      if (typeof value.value !== "boolean") return fail("EXPRESSION_BOOLEAN_REQUIRED", `${expression.kind} requires booleans.`);
      if (expression.kind === "and" && !value.value) return { ok: true, value: false };
      if (expression.kind === "or" && value.value) return { ok: true, value: true };
    }
    return { ok: true, value: expression.kind === "and" };
  }
  if (expression.kind === "length") {
    const value = evaluate(expression.value, context, budget, depth + 1);
    if (!value.ok) return value;
    return typeof value.value === "string" || Array.isArray(value.value)
      ? { ok: true, value: value.value.length }
      : fail("EXPRESSION_LENGTH_TYPE", "length requires a string or array.");
  }

  const binary = expression as BinaryExpression;
  const leftExpression = expression.kind === "in" ? expression.value : binary.left;
  const rightExpression = expression.kind === "in" ? expression.collection : binary.right;
  const left = evaluate(leftExpression, context, budget, depth + 1);
  if (!left.ok) return left;
  const right = evaluate(rightExpression, context, budget, depth + 1);
  if (!right.ok) return right;
  if (expression.kind === "eq") {
    const result = equalBounded(left.value, right.value, budget);
    return result === MISSING ? fail("EXPRESSION_STEP_LIMIT", "Expression exceeds the evaluation step limit.") : { ok: true, value: result };
  }
  if (expression.kind === "in") {
    if (!Array.isArray(right.value)) return fail("EXPRESSION_COLLECTION_REQUIRED", "in requires an array collection.");
    for (const item of right.value) {
      const result = equalBounded(left.value, item, budget);
      if (result === MISSING) return fail("EXPRESSION_STEP_LIMIT", "Expression exceeds the evaluation step limit.");
      if (result) return { ok: true, value: true };
    }
    return { ok: true, value: false };
  }
  if (typeof left.value !== typeof right.value || (typeof left.value !== "number" && typeof left.value !== "string")) {
    return fail("EXPRESSION_ORDERED_TYPE", "Ordered comparison requires two numbers or two strings of the same type.");
  }
  const leftOrdered = left.value as number | string;
  const rightOrdered = right.value as number | string;
  const comparison = leftOrdered < rightOrdered ? -1 : leftOrdered > rightOrdered ? 1 : 0;
  if (expression.kind === "lt") return { ok: true, value: comparison < 0 };
  if (expression.kind === "lte") return { ok: true, value: comparison <= 0 };
  if (expression.kind === "gt") return { ok: true, value: comparison > 0 };
  return { ok: true, value: comparison >= 0 };
}

export function evaluateExpression(expression: Expression, context: ExpressionContext): ExpressionResult {
  const json = validateIJson(expression);
  if (!json.ok) return fail("EXPRESSION_IJSON", json.issues[0]?.message ?? "Expression must be I-JSON.");
  const inspectionBudget = { nodes: 0, steps: 0 };
  const inspection = inspect(expression, inspectionBudget, 1);
  if (inspection) return inspection;
  return evaluate(expression, context, { nodes: inspectionBudget.nodes, steps: 0 }, 1);
}
