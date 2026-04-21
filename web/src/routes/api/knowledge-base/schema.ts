import { z } from "zod";

// Knowledge base POST uses formData, not JSON.
// This schema documents the expected fields for reference.
export const uploadKBFileSchema = z.object({
  projectId: z.string().uuid("Invalid projectId"),
  // file is handled via formData, not JSON body
});

export type UploadKBFileInput = z.infer<typeof uploadKBFileSchema>;
