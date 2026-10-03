import { z } from "zod";
import { concreteProjectIdSchema } from "$lib/server/security/validation";

// Knowledge base POST uses formData, not JSON.
// This schema documents the expected fields for reference.
export const uploadKBFileSchema = z.object({
  // uuid or 'self' — the seeded dev-workspace project (a real project row,
  // unlike the 'global' sentinel, which stays excluded here).
  projectId: z.union([z.literal("self"), concreteProjectIdSchema]),
  // file is handled via formData, not JSON body
});

export type UploadKBFileInput = z.infer<typeof uploadKBFileSchema>;
