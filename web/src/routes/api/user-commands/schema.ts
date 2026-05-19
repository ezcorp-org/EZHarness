import { z } from "zod";

/**
 * Validation schemas for /api/user-commands.
 *
 * `name` mirrors the slash-command slug rule used in
 * src/runtime/commands/discovery.ts (filename stem) — lowercase
 * alphanumeric + hyphen/underscore, 1–64 chars, first char alphanumeric.
 *
 * `body` is capped at COMMAND_BODY_MAX_BYTES (64 KB) so the API matches
 * the filesystem scanner's cap. Anything over surfaces as a 413 from
 * the +server handler before it ever reaches the DB layer.
 *
 * `frontmatter` is `Record<string, string>` with unknown keys filtered
 * server-side to the well-known set {description, argument-hint, agent,
 * model}. Unknown keys are silently dropped so a typo doesn't 400 the
 * whole save, but only the documented fields are persisted.
 */

export const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

export const FRONTMATTER_KEYS = [
  "description",
  "argument-hint",
  "agent",
  "model",
] as const;

export type FrontmatterKey = (typeof FRONTMATTER_KEYS)[number];

const frontmatterSchema = z.record(z.string(), z.string()).optional();

export const createUserCommandSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .max(64, "Name must be at most 64 characters")
    .regex(
      COMMAND_NAME_PATTERN,
      "Name must be lowercase alphanumeric with optional - or _",
    ),
  description: z.string().max(500).optional(),
  body: z.string(),
  frontmatter: frontmatterSchema,
});

export const updateUserCommandSchema = z.object({
  description: z.string().max(500).optional(),
  body: z.string().optional(),
  frontmatter: frontmatterSchema,
});

/**
 * Filter a frontmatter object to only the well-known keys. Unknown
 * keys are dropped (silently) so the persisted shape matches the
 * filesystem-parsed shape exactly. Non-string values are skipped —
 * the JSON parser may produce booleans/numbers in YAML-ish inputs;
 * the registry's `Record<string, string>` contract is the source of
 * truth here.
 */
export function filterFrontmatter(
  fm: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!fm) return {};
  const out: Record<string, string> = {};
  for (const key of FRONTMATTER_KEYS) {
    const v = fm[key];
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return out;
}
