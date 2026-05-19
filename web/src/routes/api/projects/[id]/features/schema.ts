import { z } from "zod";

/**
 * Boundary validation for the Feature Index REST endpoints.
 *
 * Slug rules: lowercase alphanumeric with hyphens (matches the scanner
 * output — directory basenames typically already match this shape).
 * Underscores are allowed because actual scanner-derived slugs include
 * dirs like `__tests__` (collision-prefixed e.g. `web-__tests__`).
 *
 * relpath rules: project-relative POSIX path. Reject absolute paths
 * (validatePath already enforces this server-side; we duplicate at the
 * boundary to fail fast on obvious mistakes).
 */

const SLUG_RE = /^[a-z0-9_-]+$/i;
const SLUG_MESSAGE =
  "Feature name can only contain letters, numbers, hyphens, and underscores — no spaces or other punctuation.";
// relpath: project-relative POSIX path. Reject leading `/` (absolute) and
// reject `..` ONLY when it appears as a path segment — bounded by `/` or
// the string boundaries. The previous `(?!.*\.\.)` rejected any two
// consecutive dots, which mis-rejected legitimate filenames like
// `package..config.json` (audit defect C7). The fix splits the
// traversal-segment check (`(?:^|\/)\.\.(?:$|\/)`) from the in-name
// double-dot, so files containing `..` in the basename pass while
// `../foo`, `foo/../bar`, `foo/..`, and bare `..` are still rejected.
// `validatePath` enforces the same boundary server-side; this is the
// boundary fail-fast for obvious mistakes.
const RELPATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:$|\/)).+$/;

export const createFeatureSchema = z.object({
  name: z
    .string()
    .min(1, "Feature name is required.")
    .max(120, "Feature name must be 120 characters or fewer.")
    .regex(SLUG_RE, SLUG_MESSAGE),
  description: z
    .string()
    .max(2000, "Description must be 2000 characters or fewer.")
    .optional(),
});

/**
 * PATCH body — every field optional, but at least one must be present.
 * `addFiles` and `removeFiles` operate on the user-pinned slice of
 * feature_files (source='user' on insert; remove targets any source).
 *
 * The endpoint also flips features.source from 'agent' → 'user' on any
 * non-empty PATCH so subsequent rescans don't clobber the rename or
 * description edit. That's a server-side policy (not visible in the
 * schema).
 */
export const updateFeatureSchema = z
  .object({
    name: z
      .string()
      .min(1, "Feature name is required.")
      .max(120, "Feature name must be 120 characters or fewer.")
      .regex(SLUG_RE, SLUG_MESSAGE)
      .optional(),
    description: z
      .string()
      .max(2000, "Description must be 2000 characters or fewer.")
      .optional(),
    addFiles: z
      .array(
        z
          .string()
          .min(1, "File path cannot be empty.")
          .max(2000, "File path must be 2000 characters or fewer.")
          .regex(
            RELPATH_RE,
            "File path must be project-relative (no leading slash) and contain no `..` segments.",
          ),
      )
      .max(500, "Cannot add more than 500 files in one request.")
      .optional(),
    removeFiles: z
      .array(z.string().min(1, "File path cannot be empty.").max(2000))
      .max(500, "Cannot remove more than 500 files in one request.")
      .optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.description !== undefined ||
      (data.addFiles && data.addFiles.length > 0) ||
      (data.removeFiles && data.removeFiles.length > 0),
    { message: "Provide at least one field to change: name, description, addFiles, or removeFiles." },
  );
