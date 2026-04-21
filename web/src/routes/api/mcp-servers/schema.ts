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

export const installMcpServerSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  server: mcpServerSpecSchema,
});

export type InstallMcpServerInput = z.infer<typeof installMcpServerSchema>;
