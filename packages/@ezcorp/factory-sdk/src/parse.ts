import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";
import { validateIJson } from "./canonical.js";
import { isFactoryDefinition } from "./schema.js";
import type { FactoryDefinition, JsonValue } from "./types.js";
import { FACTORY_LIMITS } from "./types.js";

export class FactoryParseError extends Error {
  readonly code: string;
  readonly offset?: number;

  constructor(code: string, message: string, offset?: number) {
    super(message);
    this.name = "FactoryParseError";
    this.code = code;
    this.offset = offset;
  }
}

class JsonParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): JsonValue {
    this.whitespace();
    const value = this.value(1);
    this.whitespace();
    if (this.offset !== this.source.length) this.error("JSON_TRAILING", "Unexpected content after the JSON value.");
    return value;
  }

  private error(code: string, message: string): never {
    throw new FactoryParseError(code, message, this.offset);
  }

  private whitespace(): void {
    while (this.offset < this.source.length) {
      const code = this.source.charCodeAt(this.offset);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      this.offset += 1;
    }
  }

  private consume(word: string, value: JsonValue): JsonValue {
    if (this.source.slice(this.offset, this.offset + word.length) !== word) this.error("JSON_TOKEN", `Expected ${word}.`);
    this.offset += word.length;
    return value;
  }

  private value(depth: number): JsonValue {
    if (depth > FACTORY_LIMITS.maxJsonDepth) this.error("IJSON_DEPTH", "JSON value exceeds the nesting limit.");
    const character = this.source[this.offset];
    if (character === '"') return this.string();
    if (character === "{") return this.object(depth);
    if (character === "[") return this.array(depth);
    if (character === "t") return this.consume("true", true);
    if (character === "f") return this.consume("false", false);
    if (character === "n") return this.consume("null", null);
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) return this.number();
    this.error("JSON_VALUE", "Expected a JSON value.");
  }

  private string(): string {
    this.offset += 1;
    let value = "";
    while (this.offset < this.source.length) {
      const character = this.source[this.offset] as string;
      this.offset += 1;
      if (character === '"') return value;
      if (character.charCodeAt(0) < 0x20) this.error("JSON_STRING", "Control characters are not permitted in strings.");
      if (character !== "\\") {
        value += character;
        continue;
      }
      const escapedCharacter = this.source[this.offset] as string;
      this.offset += 1;
      if (escapedCharacter === '"' || escapedCharacter === "\\" || escapedCharacter === "/") value += escapedCharacter;
      else if (escapedCharacter === "b") value += "\b";
      else if (escapedCharacter === "f") value += "\f";
      else if (escapedCharacter === "n") value += "\n";
      else if (escapedCharacter === "r") value += "\r";
      else if (escapedCharacter === "t") value += "\t";
      else if (escapedCharacter === "u") {
        const hex = this.source.slice(this.offset, this.offset + 4);
        if (hex.length !== 4 || [...hex].some((digit) => !((digit >= "0" && digit <= "9") || (digit >= "A" && digit <= "F") || (digit >= "a" && digit <= "f")))) this.error("JSON_ESCAPE", "Unicode escapes require four hexadecimal digits.");
        value += String.fromCharCode(Number.parseInt(hex, 16));
        this.offset += 4;
      } else this.error("JSON_ESCAPE", "Unsupported string escape.");
    }
    this.error("JSON_STRING", "Unterminated JSON string.");
  }

  private number(): number {
    const start = this.offset;
    if (this.source[this.offset] === "-") this.offset += 1;
    if (this.source[this.offset] === "0") this.offset += 1;
    else {
      const first = this.source[this.offset];
      if (first === undefined || first < "1" || first > "9") this.error("JSON_NUMBER", "Invalid JSON number.");
      while (this.source[this.offset] !== undefined && this.source[this.offset]! >= "0" && this.source[this.offset]! <= "9") this.offset += 1;
    }
    if (this.source[this.offset] === ".") {
      this.offset += 1;
      const digit = this.source[this.offset];
      if (digit === undefined || digit < "0" || digit > "9") this.error("JSON_NUMBER", "A decimal point requires digits.");
      while (this.source[this.offset] !== undefined && this.source[this.offset]! >= "0" && this.source[this.offset]! <= "9") this.offset += 1;
    }
    if (this.source[this.offset] === "e" || this.source[this.offset] === "E") {
      this.offset += 1;
      if (this.source[this.offset] === "+" || this.source[this.offset] === "-") this.offset += 1;
      const digit = this.source[this.offset];
      if (digit === undefined || digit < "0" || digit > "9") this.error("JSON_NUMBER", "An exponent requires digits.");
      while (this.source[this.offset] !== undefined && this.source[this.offset]! >= "0" && this.source[this.offset]! <= "9") this.offset += 1;
    }
    const value = Number(this.source.slice(start, this.offset));
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) this.error("IJSON_NUMBER", "Number is outside the safe I-JSON range.");
    return value;
  }

  private array(depth: number): JsonValue[] {
    this.offset += 1;
    const values: JsonValue[] = [];
    this.whitespace();
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return values;
    }
    while (true) {
      values.push(this.value(depth + 1));
      this.whitespace();
      const character = this.source[this.offset];
      this.offset += 1;
      if (character === "]") return values;
      if (character !== ",") this.error("JSON_ARRAY", "Expected a comma or closing bracket.");
      this.whitespace();
    }
  }

  private object(depth: number): { [key: string]: JsonValue } {
    this.offset += 1;
    const value: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
    this.whitespace();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return value;
    }
    while (true) {
      if (this.source[this.offset] !== '"') this.error("JSON_OBJECT", "Object keys must be strings.");
      const key = this.string();
      if (Object.hasOwn(value, key)) this.error("IJSON_DUPLICATE_KEY", `Duplicate object key: ${key}.`);
      this.whitespace();
      if (this.source[this.offset] !== ":") this.error("JSON_OBJECT", "Expected a colon after an object key.");
      this.offset += 1;
      this.whitespace();
      Object.defineProperty(value, key, { value: this.value(depth + 1), enumerable: true, configurable: true, writable: true });
      this.whitespace();
      const character = this.source[this.offset];
      this.offset += 1;
      if (character === "}") return value;
      if (character !== ",") this.error("JSON_OBJECT", "Expected a comma or closing brace.");
      this.whitespace();
    }
  }
}

function checked(value: unknown): JsonValue {
  const result = validateIJson(value);
  if (!result.ok) throw new FactoryParseError(result.issues[0]?.code ?? "IJSON_INVALID", result.issues[0]?.message ?? "Invalid I-JSON value.");
  return value as JsonValue;
}

export function parseIJson(source: string): JsonValue {
  return checked(new JsonParser(source).parse());
}

export function parseIYaml(source: string): JsonValue {
  const document = parseDocument(source, { merge: false, schema: "core", strict: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new FactoryParseError("YAML_PARSE", document.errors[0]?.message ?? "Invalid YAML.");
  if (document.warnings.length > 0) throw new FactoryParseError("YAML_WARNING", document.warnings[0]?.message ?? "Unsupported YAML.");
  let unsupported: string | undefined;
  visit(document, (_key, node) => {
    if (isAlias(node)) unsupported = "YAML aliases are not supported.";
    else if (isMap(node) && node.items.some((pair) => !isScalar(pair.key) || typeof pair.key.value !== "string")) unsupported = "YAML mapping keys must be strings.";
    else if (node && typeof node === "object" && "tag" in node && typeof node.tag === "string" && !node.tag.startsWith("tag:yaml.org,2002:")) unsupported = "Custom YAML tags are not supported.";
  });
  if (unsupported) throw new FactoryParseError("YAML_UNSUPPORTED", unsupported);
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch (error) {
    throw new FactoryParseError("YAML_UNSUPPORTED", error instanceof Error ? error.message : "Unsupported YAML value.");
  }
  return checked(value);
}

function asDefinition(value: JsonValue): FactoryDefinition {
  if (!isFactoryDefinition(value)) throw new FactoryParseError("FACTORY_SCHEMA", "Value does not match the canonical FactoryDefinition schema.");
  return value as unknown as FactoryDefinition;
}

export function parseFactoryJson(source: string): FactoryDefinition {
  return asDefinition(parseIJson(source));
}

export function parseFactoryYaml(source: string): FactoryDefinition {
  return asDefinition(parseIYaml(source));
}
