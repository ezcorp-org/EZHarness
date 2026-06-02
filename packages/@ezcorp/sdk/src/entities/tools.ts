// ── @ezcorp/sdk entities — auto-generated CRUD tools ────────────
//
// Phase 2 of 8. Given an EntityDeclaration + an EntityStoreLike, this
// module returns:
//   - 5 ToolHandlers (list_<plural>, get_<sing>, create_<sing>,
//     update_<sing>, delete_<sing>) ready to drop into
//     `createToolDispatcher`
//   - 5 ToolDefinitions describing the same tools to the LLM
//
// Dispatch contract (locked decision, plan line 393):
//   These handlers are SDK-served, NOT extension-subprocess-served.
//   The host's registry merges them into the extension's tool surface
//   BEFORE the JSON-RPC dispatcher sees the request and short-circuits
//   the subprocess for any tool name in the auto-generated set.
//
// Validation contract (locked decision #7):
//   - hard on write: create/update throw EntityValidationError on schema fail
//   - soft on read: get/list attach _validationWarning to drifted records
//     so the LLM can fix-and-update and the UI can show a banner
//
// Slug immutability (mirrors substack-pilot pre-port):
//   - create: slug is required, validated, dup-guarded via index lookup
//   - update: slug in args identifies the row; patch.slug is rejected
//   - delete: missing slug returns {deleted: false} (no-op, not an error)

import {
  EntityValidationError,
  type EntityDeclaration,
  type EntityRecordWithWarning,
  type EntityValidationIssue,
} from "./types";
import { isValidSlug } from "./slug";
import { assertRecord, validateRecord } from "./validate";
import {
  deleteEntityRecord,
  listEntityRecords,
  readEntityIndex,
  readEntityRecord,
  writeEntityRecord,
  type EntityStoreLike,
} from "./storage";
import { toolError, toolResult, type ToolHandler } from "../runtime/rpc";
import type { ToolCallResult, ToolDefinition } from "../types";

// ── Tool-name derivation ────────────────────────────────────────
//
// Plural label → snake_case (e.g. "Post Types" → "post_types").
// Singular label → same (e.g. "Post Type" → "post_type"). Whitespace
// collapses to single underscores; any non-alphanumeric character is
// stripped to keep tool names matching the host's tool-name regex.

const TOOL_NAME_REGEX = /^[a-z][a-z0-9_]*$/;

export function snakeCaseToolSegment(label: string): string {
  const trimmed = label.trim().toLowerCase();
  const snake = trimmed
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (snake.length === 0) {
    throw new Error(
      `Cannot derive tool name from label ${JSON.stringify(label)}`,
    );
  }
  return snake;
}

/**
 * Sanity-check a derived tool name against the host registry's
 * `TOOL_NAME_REGEX`. Throws on mismatch so a bad manifest is caught at
 * tools-generation time rather than at dispatch. Extracted so the guard
 * is directly exercisable — in practice `snakeCaseToolSegment` +
 * `list_`/`get_`/… prefixing always yields a valid name, making this a
 * defense-in-depth check the normal generation path never trips.
 */
export function assertValidToolName(kind: string, name: string): void {
  if (!TOOL_NAME_REGEX.test(name)) {
    throw new Error(
      `Derived tool name ${JSON.stringify(name)} for "${kind}" is not a valid tool name`,
    );
  }
}

export interface EntityToolNames {
  list: string;
  get: string;
  create: string;
  update: string;
  delete: string;
}

export function entityToolNames(decl: EntityDeclaration): EntityToolNames {
  const plural = snakeCaseToolSegment(decl.pluralLabel);
  const singular = snakeCaseToolSegment(decl.label);
  const names: EntityToolNames = {
    list: `list_${plural}`,
    get: `get_${singular}`,
    create: `create_${singular}`,
    update: `update_${singular}`,
    delete: `delete_${singular}`,
  };
  // Sanity — derived names must match the tool-name regex used by the
  // host's registry. Throw early so a bad manifest is caught at
  // tools-generation time rather than at dispatch.
  for (const [k, v] of Object.entries(names)) {
    assertValidToolName(k, v);
  }
  return names;
}

// ── ToolDefinition shapes (LLM-facing) ──────────────────────────

function summarizeSchemaForDescription(decl: EntityDeclaration): string {
  const props = decl.schema.properties ?? {};
  const required = new Set(decl.schema.required ?? []);
  const lines: string[] = [];
  for (const [key, sub] of Object.entries(props)) {
    const req = required.has(key) ? " (required)" : "";
    lines.push(`  - ${key}: ${sub.type}${req}`);
  }
  return lines.length === 0 ? "" : `\nFields:\n${lines.join("\n")}`;
}

export function buildEntityToolDefinitions(
  decl: EntityDeclaration,
): ToolDefinition[] {
  const names = entityToolNames(decl);
  const fields = summarizeSchemaForDescription(decl);
  // Cast to the LLM-facing JSON-Schema shape — ToolDefinition.inputSchema
  // is structurally `Record<string, unknown>` (it's whatever JSON Schema
  // the host serializes). Our JsonSchemaObject is a strict subset.
  const baseRecordSchema = decl.schema as unknown as Record<string, unknown>;

  return [
    {
      name: names.list,
      description:
        `List all ${decl.pluralLabel}. ` +
        `Returns {items: [{slug, data, _validationWarning?}]} where each ` +
        `_validationWarning (optional) carries {code: "SCHEMA_DRIFT", issues: ` +
        `[{path, message}]} when the stored record fails the current schema ` +
        `(soft-read; record is still returned so the LLM can repair in place).` +
        `${fields}`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: names.get,
      description: `Get a single ${decl.label} by slug.${fields}`,
      inputSchema: {
        type: "object",
        properties: { slug: { type: "string" } },
        required: ["slug"],
        additionalProperties: false,
      },
    },
    {
      name: names.create,
      description: `Create a new ${decl.label}. Slug is required and must be unique.${fields}`,
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string" },
          data: baseRecordSchema,
        },
        required: ["slug", "data"],
        additionalProperties: false,
      },
    },
    {
      name: names.update,
      description: `Update an existing ${decl.label}. Slug is immutable; pass it to identify the row. The patch is shallow-merged onto the current record and the result is re-validated.${fields}`,
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string" },
          patch: { type: "object" },
        },
        required: ["slug", "patch"],
        additionalProperties: false,
      },
    },
    {
      name: names.delete,
      description: `Delete a ${decl.label} by slug. Missing slug is a no-op (deleted: false).`,
      inputSchema: {
        type: "object",
        properties: { slug: { type: "string" } },
        required: ["slug"],
        additionalProperties: false,
      },
    },
  ];
}

// ── Soft-read helper ────────────────────────────────────────────

function attachWarning<T>(
  slug: string,
  data: T,
  issues: EntityValidationIssue[],
): EntityRecordWithWarning<T> {
  if (issues.length === 0) return { slug, data };
  return {
    slug,
    data,
    _validationWarning: { code: "SCHEMA_DRIFT", issues },
  };
}

// ── Handlers ────────────────────────────────────────────────────
//
// Each handler is a `ToolHandler` (rpc.ts): `(args, ctx?) → ToolCallResult`.
// We don't accept the `ctx` second arg here since CRUD on owned data
// doesn't need invocation metadata; the signature matches anyway via
// optional parameter.

interface BuildOpts {
  /** Soft-read: when true, attach _validationWarning to drifted records
   *  on get/list. Default `true` (locked decision #7). */
  softRead?: boolean;
}

export interface EntityToolHandlers {
  list: ToolHandler;
  get: ToolHandler;
  create: ToolHandler;
  update: ToolHandler;
  delete: ToolHandler;
}

export function buildEntityToolHandlers(
  decl: EntityDeclaration,
  store: EntityStoreLike,
  opts: BuildOpts = {},
): EntityToolHandlers {
  const softRead = opts.softRead !== false;
  const type = decl.type;

  // ── list_<plural> ─────────────────────────────────────────────
  const list: ToolHandler = async (): Promise<ToolCallResult> => {
    try {
      const items = await listEntityRecords(store, type);
      const enriched = items.map((rec) => {
        if (!softRead) return rec;
        const issues = validateRecord(decl.schema, rec.data);
        return attachWarning(rec.slug, rec.data, issues);
      });
      return toolResult(JSON.stringify({ items: enriched }, null, 2));
    } catch (err) {
      return toolError(
        `${entityToolNames(decl).list} failed: ${(err as Error).message}`,
      );
    }
  };

  // ── get_<singular> ────────────────────────────────────────────
  const get: ToolHandler = async (args): Promise<ToolCallResult> => {
    const slug = (args as { slug?: unknown }).slug;
    if (typeof slug !== "string") {
      return toolError(
        `${entityToolNames(decl).get} requires a string 'slug'`,
      );
    }
    if (!isValidSlug(slug)) {
      return toolError(
        `${entityToolNames(decl).get}: invalid slug ${JSON.stringify(slug)}`,
      );
    }
    try {
      const rec = await readEntityRecord(store, type, slug);
      if (rec === null) {
        return toolError(
          `${decl.label} ${JSON.stringify(slug)} not found`,
          "NOT_FOUND",
        );
      }
      const out = softRead
        ? attachWarning(rec.slug, rec.data, validateRecord(decl.schema, rec.data))
        : rec;
      return toolResult(JSON.stringify(out, null, 2));
    } catch (err) {
      return toolError(
        `${entityToolNames(decl).get} failed: ${(err as Error).message}`,
      );
    }
  };

  // ── create_<singular> ─────────────────────────────────────────
  const create: ToolHandler = async (args): Promise<ToolCallResult> => {
    const slug = (args as { slug?: unknown }).slug;
    const data = (args as { data?: unknown }).data;
    const toolName = entityToolNames(decl).create;

    if (typeof slug !== "string") {
      return toolError(`${toolName} requires a string 'slug'`);
    }
    if (!isValidSlug(slug)) {
      return toolError(
        `${toolName}: invalid slug ${JSON.stringify(slug)} — must match ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`,
      );
    }
    if (
      data === null ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      return toolError(`${toolName} requires an object 'data'`);
    }

    try {
      // Dup guard — read the index first so we don't clobber an existing
      // row. Two separate calls (index then record) cover the case where
      // a record exists without an index entry (post-migration repair).
      const indexSlugs = await readEntityIndex(store, type);
      if (indexSlugs.includes(slug)) {
        return toolError(
          `${decl.label} ${JSON.stringify(slug)} already exists`,
          "ALREADY_EXISTS",
        );
      }
      const existing = await readEntityRecord(store, type, slug);
      if (existing !== null) {
        return toolError(
          `${decl.label} ${JSON.stringify(slug)} already exists`,
          "ALREADY_EXISTS",
        );
      }

      // Hard-fail validation
      try {
        assertRecord(decl.schema, data, toolName);
      } catch (err) {
        if (err instanceof EntityValidationError) {
          return toolError(err.message, "VALIDATION_FAILED");
        }
        throw err;
      }

      await writeEntityRecord(store, type, slug, data);
      return toolResult(
        JSON.stringify({ slug, data }, null, 2),
      );
    } catch (err) {
      return toolError(`${toolName} failed: ${(err as Error).message}`);
    }
  };

  // ── update_<singular> ─────────────────────────────────────────
  const update: ToolHandler = async (args): Promise<ToolCallResult> => {
    const slug = (args as { slug?: unknown }).slug;
    const patch = (args as { patch?: unknown }).patch;
    const toolName = entityToolNames(decl).update;

    if (typeof slug !== "string") {
      return toolError(`${toolName} requires a string 'slug'`);
    }
    if (!isValidSlug(slug)) {
      return toolError(
        `${toolName}: invalid slug ${JSON.stringify(slug)}`,
      );
    }
    if (
      patch === null ||
      typeof patch !== "object" ||
      Array.isArray(patch)
    ) {
      return toolError(`${toolName} requires an object 'patch'`);
    }
    if ((patch as { slug?: unknown }).slug !== undefined) {
      return toolError(
        `${toolName}: 'slug' is immutable; create a new ${decl.label} instead`,
        "SLUG_IMMUTABLE",
      );
    }

    try {
      const current = await readEntityRecord(store, type, slug);
      if (current === null) {
        return toolError(
          `${decl.label} ${JSON.stringify(slug)} not found`,
          "NOT_FOUND",
        );
      }

      // Shallow merge — matches substack-pilot pre-port semantics.
      // Authors who want deep merges write their own tool; v1 keeps
      // the contract simple and predictable.
      const next: Record<string, unknown> = {
        ...(current.data as Record<string, unknown>),
        ...(patch as Record<string, unknown>),
      };

      try {
        assertRecord(decl.schema, next, toolName);
      } catch (err) {
        if (err instanceof EntityValidationError) {
          return toolError(err.message, "VALIDATION_FAILED");
        }
        throw err;
      }

      await writeEntityRecord(store, type, slug, next);
      return toolResult(JSON.stringify({ slug, data: next }, null, 2));
    } catch (err) {
      return toolError(`${toolName} failed: ${(err as Error).message}`);
    }
  };

  // ── delete_<singular> ─────────────────────────────────────────
  const del: ToolHandler = async (args): Promise<ToolCallResult> => {
    const slug = (args as { slug?: unknown }).slug;
    const toolName = entityToolNames(decl).delete;

    if (typeof slug !== "string") {
      return toolError(`${toolName} requires a string 'slug'`);
    }
    if (!isValidSlug(slug)) {
      return toolError(
        `${toolName}: invalid slug ${JSON.stringify(slug)}`,
      );
    }

    try {
      const deleted = await deleteEntityRecord(store, type, slug);
      return toolResult(JSON.stringify({ deleted }, null, 2));
    } catch (err) {
      return toolError(`${toolName} failed: ${(err as Error).message}`);
    }
  };

  return { list, get, create, update, delete: del };
}

/**
 * Convenience: returns a `{ [name]: handler }` map ready to spread into
 * `createToolDispatcher` or to merge with hand-rolled tools. Phase 3's
 * registry uses this shape when merging auto-tools into the extension's
 * tool surface.
 */
export function buildEntityToolMap(
  decl: EntityDeclaration,
  store: EntityStoreLike,
  opts?: BuildOpts,
): Record<string, ToolHandler> {
  const names = entityToolNames(decl);
  const handlers = buildEntityToolHandlers(decl, store, opts);
  return {
    [names.list]: handlers.list,
    [names.get]: handlers.get,
    [names.create]: handlers.create,
    [names.update]: handlers.update,
    [names.delete]: handlers.delete,
  };
}
