// ── @ezcorp/sdk entities — public types ──────────────────────────
//
// User-managed, named, sub-typed records owned by an extension. The
// substrate for substack-pilot's post-types, creative-writing
// characters, research playbooks, etc.
//
// All persisted state lives in the existing `extension_storage` table
// under the managed namespace `__entity:<type>:<slug>` plus an index
// at `__entity-index:<type>`. The shape below is what extension
// authors declare in `ezcorp.config.ts`; the SDK generates the CRUD
// tools, settings UI surface, and storage routing from it.

// ── Locked subset of JSON Schema we understand ───────────────────
//
// Reflects the validator built in `./validate.ts`. Anything beyond
// this subset is rejected at manifest-validation time so authors
// don't ship schemas the SDK can't enforce.

export type JsonSchemaPrimitive =
  | "object"
  | "string"
  | "number"
  | "boolean"
  | "array";

export interface JsonSchemaString {
  type: "string";
  description?: string;
  minLength?: number;
  maxLength?: number;
  /** ECMAScript regex source. Compiled per-validation. */
  pattern?: string;
  enum?: readonly string[];
}

export interface JsonSchemaNumber {
  type: "number";
  description?: string;
  minimum?: number;
  maximum?: number;
  /** When true, only integers are accepted. */
  integer?: boolean;
}

export interface JsonSchemaBoolean {
  type: "boolean";
  description?: string;
}

export interface JsonSchemaArray {
  type: "array";
  description?: string;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
}

export interface JsonSchemaObject {
  type: "object";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  /** v1 default treats this as `false` (extra keys rejected on write). */
  additionalProperties?: boolean;
}

export type JsonSchema =
  | JsonSchemaString
  | JsonSchemaNumber
  | JsonSchemaBoolean
  | JsonSchemaArray
  | JsonSchemaObject;

// ── EntityDeclaration ────────────────────────────────────────────

export type EntityScope = "user" | "project" | "conversation";

export interface EntitySeedSpec {
  /** Must match the slug regex; rejected at install time otherwise. */
  slug: string;
  /**
   * The record body. String values containing `{file:./path}` are
   * resolved against the extension's source dir at install time;
   * see `seed.ts` host-side wiring.
   */
  data: Record<string, unknown>;
}

export interface EntityDeclaration {
  /**
   * Sub-type slug within the extension's namespace. Must match
   * `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` — same rules as record
   * slugs because the type segment is part of the storage key.
   */
  type: string;
  /** Singular human label, e.g. "Post Type". */
  label: string;
  /** Plural human label, e.g. "Post Types". Drives tool naming. */
  pluralLabel: string;
  /** Storage scope. Default `"user"`. */
  scope?: EntityScope;
  /**
   * When `true`, records are deleted on uninstall. Default `false` —
   * user data is sacred and an uninstall preserves it for re-install.
   */
  cascadeOnUninstall?: boolean;
  /**
   * JSON Schema for record bodies. Limited to the subset enumerated
   * in this file; richer schemas are rejected at manifest validation.
   */
  schema: JsonSchemaObject;
  /**
   * Optional template for LLM/UI preview. Tokens of the form
   * `{name}`, `{slug}`, `{some.nested}` interpolate from the record.
   * Unknown tokens render as the literal `{token}` text (v1).
   */
  preview?: string;
  /**
   * Records to insert on first install. Re-install is a no-op for
   * any slug already present in the index.
   */
  seed?: readonly EntitySeedSpec[];
}

// ── Stored record shape ──────────────────────────────────────────

export interface EntityRecord<T = Record<string, unknown>> {
  slug: string;
  data: T;
}

export interface EntityValidationIssue {
  /** Dotted path into the record, e.g. `"defaults.titlePrefix"`. */
  path: string;
  message: string;
}

export interface EntityValidationWarning {
  code: "SCHEMA_DRIFT";
  issues: EntityValidationIssue[];
}

/**
 * Returned by `get_<entity>` / `list_<entity>` on records that fail
 * the current schema. The raw `data` is preserved so the LLM can
 * fix-and-update or the UI can delete the broken row.
 */
export interface EntityRecordWithWarning<T = Record<string, unknown>>
  extends EntityRecord<T> {
  _validationWarning?: EntityValidationWarning;
}

// ── Errors ───────────────────────────────────────────────────────

export class EntityValidationError extends Error {
  readonly issues: EntityValidationIssue[];
  constructor(message: string, issues: EntityValidationIssue[]) {
    super(message);
    this.name = "EntityValidationError";
    this.issues = issues;
  }
}

// ── Reserved-key constants (single source of truth) ──────────────
//
// All storage helpers and clamps consume these so a typo in one
// place can't drift from another.

export const ENTITY_KEY_PREFIX = "__entity:";
export const ENTITY_INDEX_PREFIX = "__entity-index:";
