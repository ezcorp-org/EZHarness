import { z, type ZodError } from "zod";

/** Shared password complexity schema: min 8 chars, upper, lower, digit. */
export const passwordSchema = z.string()
  .min(8, "Password must be at least 8 characters")
  .max(256, "Password must be at most 256 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one digit");

export function validationError(error: ZodError): Response {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".");
    fields[path] = issue.message;
  }
  return Response.json({ error: "Validation failed", fields }, { status: 400 });
}
