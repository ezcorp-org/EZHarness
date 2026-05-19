import { z } from "zod";

// Accept clone URLs supported by installFromGit / parseSource:
//   https://host/path[.git][@ref]
//   git@host:user/repo.git[@ref]   (ssh)
// Reject:
//   file://...     — would let a caller point at a server-local path and
//                    bypass the intent of "install from a remote repo"
//   anything starting with "-" — git treats leading-hyphen args as flags,
//                    so a URL like "--upload-pack=..." is a known RCE
//                    primitive even when passed after "--"
//   empty strings
const gitUrlSchema = z
  .string()
  .min(1, { message: "url is required" })
  .refine((u) => !u.startsWith("-"), {
    message: "url must not start with '-'",
  })
  .refine(
    (u) => /^https?:\/\//.test(u) || /^git@[^:]+:.+\.git$/.test(u),
    { message: "url must be http(s) or ssh (git@host:user/repo.git)" },
  );

// ref is optional — if present, must be a plausible git ref. Keep the
// validation conservative: no whitespace, no shell metachars. `parseSource`
// itself enforces a narrower grammar via its regex, but pre-rejecting the
// obvious injection shapes here gives a clearer 400.
const gitRefSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._\-/]+$/, {
    message: "ref must contain only letters, digits, '.', '_', '-', '/'",
  });

export const installExtensionSchema = z
  .object({
    source: z.enum(["local", "github", "git"], {
      message: "source must be 'local', 'github', or 'git'",
    }),
    path: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    url: gitUrlSchema.optional(),
    ref: gitRefSchema.optional(),
    permissions: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.source === "local" && !data.path) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "path required for local install",
      });
    }
    if (data.source === "github" && !data.repo) {
      ctx.addIssue({
        code: "custom",
        path: ["repo"],
        message: "repo required for github install",
      });
    }
    if (data.source === "git" && !data.url) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "url required for git install",
      });
    }
  });

export type InstallExtensionInput = z.infer<typeof installExtensionSchema>;
