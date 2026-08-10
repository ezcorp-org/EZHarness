import { z } from "zod";

// Phase 65 Wave 2: query-param schema for GET /api/search/messages.
// Only `mode` is zod-validated here — an unknown mode must 400 loudly via
// the enum. limit/offset are NOT in the schema: per the locked decision they
// are clamped numerically in the handler (limit→[1,50] default 20, offset→
// [0,∞) default 0) rather than rejected, so out-of-range values are honored.
// `scope` (Phase 67 Plan 03 — PAL-01): "project" (single projectId, default)
// or "all" (every project of the requesting user — the cross-project palette
// path). Defaults to "project" so the Phase 65 contract is unchanged.
export const searchMessagesQuerySchema = z.object({
  mode: z.enum(["hybrid", "keyword", "semantic"]).default("hybrid"),
  scope: z.enum(["project", "all"]).default("project"),
});

export type SearchMessagesQuery = z.infer<typeof searchMessagesQuerySchema>;
