// ── Manifest-time entity validation ──────────────────────────────
//
// Phase 3: called from `validateManifestV2` (`../manifest.ts`) when the
// manifest declares an `entities[]` block. Rejects any manifest that
// would produce a half-working entity at install time:
//
//   - entity.type doesn't match the slug regex
//   - label/pluralLabel produces an invalid tool name (e.g. empty)
//   - schema isn't an object schema in the SDK's locked subset
//   - extension's own settings keys or hand-rolled tools[].name collide
//     with auto-generated names (replacement, not coexistence —
//     substack-pilot's `list_post_types` etc. will collide on purpose
//     in Phase 7, and those manifest entries are DELETED before the
//     entity declaration replaces them)
//   - manifest writes (settings, storage handlers, etc.) collide with
//     the reserved namespace `__entity:*` / `__entity-index:*`
//   - two entity declarations within the same manifest share a `type`
//
// The single entry point is `validateEntitiesArray(...)` which appends
// to the `errors[]` accumulator the host validator already uses. No
// throw — every other component validator in `../manifest.ts` follows
// the same accumulator pattern.

import {
  ENTITY_INDEX_PREFIX,
  ENTITY_KEY_PREFIX,
  entityToolNames,
  isValidEntityType,
  type EntityDeclaration,
} from "@ezcorp/sdk/entities";

// ── Locked JSON-Schema subset gate ──────────────────────────────
//
// The SDK validator (`packages/@ezcorp/sdk/src/entities/validate.ts`)
// understands a fixed subset of JSON Schema. Manifests declaring a
// schema outside that subset would pass the SDK at manifest-validation
// time but fail at runtime — that's a worse error UX than failing the
// install. We re-walk the schema here at install time and reject
// anything we can't validate at write time.

const SUPPORTED_TYPES = new Set([
  "object",
  "string",
  "number",
  "boolean",
  "array",
]);

function checkSchemaShape(
  schema: unknown,
  path: string,
  errors: string[],
  depth = 0,
): void {
  if (depth > 8) {
    errors.push(`${path}: schema nests too deeply (max 8 levels)`);
    return;
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    errors.push(`${path}: must be a JSON Schema object`);
    return;
  }
  const s = schema as Record<string, unknown>;
  if (typeof s.type !== "string" || !SUPPORTED_TYPES.has(s.type)) {
    errors.push(
      `${path}.type must be one of "object"|"string"|"number"|"boolean"|"array"`,
    );
    return;
  }
  if (s.type === "object") {
    if (s.properties !== undefined) {
      if (
        !s.properties ||
        typeof s.properties !== "object" ||
        Array.isArray(s.properties)
      ) {
        errors.push(`${path}.properties must be an object map`);
      } else {
        for (const [k, sub] of Object.entries(
          s.properties as Record<string, unknown>,
        )) {
          checkSchemaShape(sub, `${path}.properties.${k}`, errors, depth + 1);
        }
      }
    }
    if (s.required !== undefined) {
      if (!Array.isArray(s.required)) {
        errors.push(`${path}.required must be an array of strings`);
      } else {
        for (let i = 0; i < s.required.length; i++) {
          if (typeof s.required[i] !== "string") {
            errors.push(`${path}.required[${i}] must be a string`);
          }
        }
      }
    }
    if (
      s.additionalProperties !== undefined &&
      typeof s.additionalProperties !== "boolean"
    ) {
      errors.push(`${path}.additionalProperties must be a boolean`);
    }
  } else if (s.type === "array") {
    if (s.items !== undefined) {
      checkSchemaShape(s.items, `${path}.items`, errors, depth + 1);
    }
  } else if (s.type === "string") {
    if (s.enum !== undefined) {
      if (!Array.isArray(s.enum) || s.enum.length === 0) {
        errors.push(`${path}.enum must be a non-empty array`);
      } else {
        for (let i = 0; i < s.enum.length; i++) {
          if (typeof s.enum[i] !== "string") {
            errors.push(`${path}.enum[${i}] must be a string`);
          }
        }
      }
    }
    if (s.pattern !== undefined) {
      if (typeof s.pattern !== "string") {
        errors.push(`${path}.pattern must be a string`);
      } else {
        try {
          new RegExp(s.pattern);
        } catch (err) {
          errors.push(
            `${path}.pattern is not a valid regex: ${(err as Error).message}`,
          );
        }
      }
    }
  }
}

// ── Reserved-key sweep ──────────────────────────────────────────
//
// Reject any extension-author-declared key that starts with the
// reserved entity namespace. The same check happens at runtime via
// `isReservedEntityKey` in the storage handler, but failing at
// install time is far better DX than a confusing tool-call error.

function isReservedKeyName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  return (
    name.startsWith(ENTITY_KEY_PREFIX) || name.startsWith(ENTITY_INDEX_PREFIX)
  );
}

function checkReservedKeys(
  manifest: Record<string, unknown>,
  errors: string[],
): void {
  // settings keys
  const settings = manifest.settings;
  if (settings && typeof settings === "object" && !Array.isArray(settings)) {
    for (const k of Object.keys(settings as Record<string, unknown>)) {
      if (isReservedKeyName(k)) {
        errors.push(
          `settings key "${k}" uses reserved entity namespace (__entity:* / __entity-index:*)`,
        );
      }
    }
  }
  // tool names — settings field names share the same namespace check
  // for completeness; entity-auto tool names ("list_*", "create_*",
  // etc.) DON'T overlap the reserved-key namespace by construction
  // (the namespace prefix has underscores).
  const tools = manifest.tools;
  if (Array.isArray(tools)) {
    for (let i = 0; i < tools.length; i++) {
      const t = tools[i] as Record<string, unknown> | null;
      if (t && typeof t.name === "string" && isReservedKeyName(t.name)) {
        errors.push(
          `tools[${i}].name "${t.name}" uses reserved entity namespace`,
        );
      }
    }
  }
}

// ── Main validator ──────────────────────────────────────────────

/**
 * Validate an `entities[]` array from a manifest. Pushes one or more
 * messages to `errors` for each declaration that fails any rule.
 *
 * `manifest` is the surrounding (parsed) manifest object so we can
 * cross-check declared tool names + settings keys against the
 * auto-generated names this entity declaration would produce.
 */
export function validateEntitiesArray(
  manifest: Record<string, unknown>,
  entities: unknown,
  errors: string[],
): void {
  if (!Array.isArray(entities)) {
    errors.push("entities must be an array");
    return;
  }

  // First pass: reserved-key checks (don't depend on entities[] shape).
  checkReservedKeys(manifest, errors);

  // Build sets we'll cross-check against per declaration.
  const declaredToolNames = new Set<string>();
  if (Array.isArray(manifest.tools)) {
    for (const t of manifest.tools as Array<Record<string, unknown>>) {
      if (t && typeof t.name === "string") declaredToolNames.add(t.name);
    }
  }
  const declaredSettingsKeys = new Set<string>();
  if (
    manifest.settings &&
    typeof manifest.settings === "object" &&
    !Array.isArray(manifest.settings)
  ) {
    for (const k of Object.keys(
      manifest.settings as Record<string, unknown>,
    )) {
      declaredSettingsKeys.add(k);
    }
  }

  const seenTypes = new Set<string>();

  for (let i = 0; i < entities.length; i++) {
    const raw = entities[i];
    const path = `entities[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    const decl = raw as Record<string, unknown>;

    // ── type ──
    if (!isValidEntityType(decl.type)) {
      errors.push(
        `${path}.type ${JSON.stringify(decl.type)} must match ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`,
      );
      // Skip remaining checks for this entity — they depend on a valid type.
      continue;
    }
    if (seenTypes.has(decl.type)) {
      errors.push(
        `${path}.type ${JSON.stringify(decl.type)} is declared more than once`,
      );
      // Continue checking the other rules anyway; duplicate type isn't
      // a blocker for label/schema validation.
    }
    seenTypes.add(decl.type);

    // ── labels ──
    if (typeof decl.label !== "string" || decl.label.trim().length === 0) {
      errors.push(`${path}.label is required and must be a non-empty string`);
    }
    if (
      typeof decl.pluralLabel !== "string" ||
      decl.pluralLabel.trim().length === 0
    ) {
      errors.push(
        `${path}.pluralLabel is required and must be a non-empty string`,
      );
    }

    // ── scope ──
    if (
      decl.scope !== undefined &&
      decl.scope !== "user" &&
      decl.scope !== "project" &&
      decl.scope !== "conversation"
    ) {
      errors.push(
        `${path}.scope must be one of "user"|"project"|"conversation"`,
      );
    }

    // ── cascadeOnUninstall ──
    if (
      decl.cascadeOnUninstall !== undefined &&
      typeof decl.cascadeOnUninstall !== "boolean"
    ) {
      errors.push(`${path}.cascadeOnUninstall must be a boolean`);
    }

    // ── preview ──
    if (decl.preview !== undefined && typeof decl.preview !== "string") {
      errors.push(`${path}.preview must be a string when provided`);
    }

    // ── schema (must be an object schema; recursively in the subset) ──
    if (
      !decl.schema ||
      typeof decl.schema !== "object" ||
      Array.isArray(decl.schema)
    ) {
      errors.push(`${path}.schema is required and must be a JSON Schema object`);
    } else {
      const s = decl.schema as Record<string, unknown>;
      if (s.type !== "object") {
        errors.push(`${path}.schema.type must be "object"`);
      } else {
        checkSchemaShape(s, `${path}.schema`, errors);
      }
    }

    // ── seed[] shape ──
    if (decl.seed !== undefined) {
      if (!Array.isArray(decl.seed)) {
        errors.push(`${path}.seed must be an array`);
      } else {
        for (let j = 0; j < decl.seed.length; j++) {
          const sd = decl.seed[j] as Record<string, unknown> | null;
          if (!sd || typeof sd !== "object" || Array.isArray(sd)) {
            errors.push(`${path}.seed[${j}] must be an object`);
            continue;
          }
          if (typeof sd.slug !== "string" || sd.slug.length === 0) {
            errors.push(`${path}.seed[${j}].slug is required and must be a string`);
          }
          if (
            !sd.data ||
            typeof sd.data !== "object" ||
            Array.isArray(sd.data)
          ) {
            errors.push(`${path}.seed[${j}].data must be an object`);
          }
        }
      }
    }

    // ── derived tool-name collisions ──
    //
    // The SDK's `entityToolNames` derives the 5 tool names from
    // label + pluralLabel. If derivation throws (e.g. labels strip to
    // empty), surface a friendly error rather than letting the throw
    // propagate to the host validator.
    if (
      typeof decl.label === "string" &&
      typeof decl.pluralLabel === "string"
    ) {
      let names;
      try {
        // The SDK's entityToolNames only reads label, pluralLabel,
        // and computes pure strings — pass a minimal cast.
        names = entityToolNames(decl as unknown as EntityDeclaration);
      } catch (err) {
        errors.push(
          `${path}: cannot derive tool names from label/pluralLabel — ${(err as Error).message}`,
        );
        continue;
      }
      // Collide-with-tools and collide-with-settings checks.
      const autoNames = [
        names.list,
        names.get,
        names.create,
        names.update,
        names.delete,
      ];
      for (const n of autoNames) {
        if (declaredToolNames.has(n)) {
          errors.push(
            `${path}: auto-generated tool name "${n}" collides with a manifest tools[] entry — remove the hand-rolled tool (entity tools REPLACE, not coexist)`,
          );
        }
        if (declaredSettingsKeys.has(n)) {
          errors.push(
            `${path}: auto-generated tool name "${n}" collides with a settings.<key> — rename the setting`,
          );
        }
      }
    }
  }
}
