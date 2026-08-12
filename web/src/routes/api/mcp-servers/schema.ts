import { z } from "zod";

const stdioSchema = z.object({
  transport: z.literal("stdio"),
  name: z.string().min(1),
  description: z.string().optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const httpSchema = z.object({
  transport: z.literal("http"),
  name: z.string().min(1),
  description: z.string().optional(),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const sseSchema = z.object({
  transport: z.literal("sse"),
  name: z.string().min(1),
  description: z.string().optional(),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const mcpServerSpecSchema = z.discriminatedUnion("transport", [stdioSchema, httpSchema, sseSchema]);

/**
 * The EXTENSION name an MCP install creates a row under.
 *
 * `installMcpExtension` synthesises its manifest and calls `createExtension`
 * directly, so this is the ONE row writer that never passes through
 * `manifest.ts`'s validation — and its name reaches the filesystem: it is
 * what `extensionDataDir()` uses for the sandbox's rw work dir and what an
 * uninstall's `purgeData` deletes. A `z.string().min(1)` here accepted
 * `../extension-data/<other-extension>`, i.e. a row whose data directory is
 * somebody else's.
 *
 * Byte-identical to `NAME_REGEX` in `src/extensions/manifest.ts:31`, so
 * every writer now agrees on what an extension may be called.
 * `isRemovableDataDir` enforces the same shape independently — this is the
 * outer of two gates, not the only one.
 */
const EXTENSION_NAME_REGEX = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

export const installMcpServerSchema = z.object({
  name: z
    .string()
    .regex(
      EXTENSION_NAME_REGEX,
      "name must be lowercase alphanumeric, may contain - _ . after the first character, and be at most 64 characters — no path separators or traversal",
    ),
  description: z.string().optional(),
  server: mcpServerSpecSchema,
});

export type InstallMcpServerInput = z.infer<typeof installMcpServerSchema>;

// Edit-after-install (Phase 3/B). The name is immutable (it's the extension's
// identity); only the connection config + optional description change. Reuses
// the same discriminated `server` union as install.
export const updateMcpServerSchema = z.object({
  description: z.string().optional(),
  server: mcpServerSpecSchema,
});

export type UpdateMcpServerInput = z.infer<typeof updateMcpServerSchema>;
