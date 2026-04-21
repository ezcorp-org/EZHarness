import { z } from "zod";

export const importManifestSchema = z.object({
  schemaVersion: z.number().int(),
  name: z.string().min(1).max(200),
  version: z.string().min(1),
  description: z.string().max(2000),
  author: z.object({
    name: z.string().min(1),
    id: z.string().optional(),
  }).optional(),
  agent: z.object({
    prompt: z.string().min(1),
    category: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().int().optional(),
    outputFormat: z.enum(["text", "json"]).optional(),
    inputSchema: z.record(z.unknown()).nullish(),
  }).optional(),
  permissions: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
}).passthrough();

export type ImportManifestInput = z.infer<typeof importManifestSchema>;
