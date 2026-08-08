import { z, type ZodError } from "zod";

/** Shared password complexity schema: min 8 chars, upper, lower, digit. */
export const passwordSchema = z.string()
  .min(8, "Password must be at least 8 characters")
  .max(256, "Password must be at most 256 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one digit");

/**
 * A project's working directory, as stored in `projects.path`.
 *
 * This is an ABSOLUTE CONTAINER path that the runtime hands straight to
 * `resolve()` and to the `shell` tool's `cwd`. Until now the routes took
 * `z.string()` and checked only emptiness, and both real-world corruptions
 * got in through that gap:
 *
 *   - `~/projects/<name>` — nothing in the server expands a tilde, so
 *     `resolve()` rooted it at the process cwd and created a directory
 *     literally named `~`. It had no bind behind it, so it lived on the
 *     container's throwaway overlay: invisible on the host and deleted by
 *     the next recreate. That cost 270 MB of build output and two unpushed
 *     commits, and NOTHING failed at the time — the folder was created, the
 *     project opened, chats worked.
 *   - `app/<name>` (no leading slash) — resolved against cwd to
 *     `/app/web/app/<name>`, which never existed, so the project pointed at
 *     nothing from the moment it was saved.
 *
 * Rejecting is deliberate rather than normalising: a path the user did not
 * type is a path they cannot find later, and both failures above were
 * silent precisely because something quietly resolved to a wrong-but-valid
 * location. This does NOT require the path to sit under the projects bind —
 * the seeded `global` (`/`), `self` (`/repo`) and test-fixture projects
 * legitimately live elsewhere.
 */
export const projectPathSchema = z.string()
  .min(1, "Project path is required")
  .refine((p) => p.startsWith("/"), {
    message: "Project path must be absolute (start with /)",
  })
  .refine((p) => !p.split("/").includes("~"), {
    message: "Project path cannot contain ~ — tildes are not expanded, type the full path",
  })
  .refine((p) => !p.split("/").includes(".."), {
    message: "Project path cannot contain ..",
  });

/** First message from a failed parse, for routes that answer a bare string. */
export function firstIssueMessage(error: ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}

export function validationError(error: ZodError): Response {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".");
    fields[path] = issue.message;
  }
  return Response.json({ error: "Validation failed", fields }, { status: 400 });
}
