// ── @ezcorp/sdk/entities — public barrel ─────────────────────────
//
// Phase 1: foundation only (types, slug, validate, storage).
// Phase 2 will add tools.ts. Phase 6 will add seed/migrate helpers.

export {
  ENTITY_INDEX_PREFIX,
  ENTITY_KEY_PREFIX,
  EntityValidationError,
  type EntityDeclaration,
  type EntityRecord,
  type EntityRecordWithWarning,
  type EntityScope,
  type EntitySeedSpec,
  type EntityValidationIssue,
  type EntityValidationWarning,
  type JsonSchema,
  type JsonSchemaArray,
  type JsonSchemaBoolean,
  type JsonSchemaNumber,
  type JsonSchemaObject,
  type JsonSchemaPrimitive,
  type JsonSchemaString,
} from "./types";

export {
  SLUG_MAX_LENGTH,
  SLUG_REGEX,
  assertValidSlug,
  isValidSlug,
} from "./slug";

export {
  assertRecord,
  validateRecord,
} from "./validate";

export {
  assertNotReserved,
  assertValidEntityType,
  deleteEntityRecord,
  entityIndexKey,
  entityRecordKey,
  isReservedEntityKey,
  isValidEntityType,
  listEntityRecords,
  readEntityIndex,
  readEntityRecord,
  writeEntityIndex,
  writeEntityRecord,
  type EntityStoreGetResult,
  type EntityStoreLike,
} from "./storage";

export {
  assertValidToolName,
  buildEntityToolDefinitions,
  buildEntityToolHandlers,
  buildEntityToolMap,
  entityToolNames,
  snakeCaseToolSegment,
  type EntityToolHandlers,
  type EntityToolNames,
} from "./tools";
