/**
 * Parse extension source strings into structured clone metadata.
 *
 * Supported formats:
 *   github:user/repo[@ref]
 *   gitlab:org/project[@ref]
 *   https://host/path.git[@ref]
 *   git@host:user/repo.git[@ref]
 *   file:///path/to/repo.git[@ref]   (for testing)
 */

export interface ParsedSource {
  type: "github" | "gitlab" | "https" | "ssh" | "file";
  cloneUrl: string;
  displayName: string;
  ref?: string;
  original: string;
}

// Git refs (branches/tags/commits) legitimately only contain these chars.
// Anything else — and anything starting with "-" — is rejected so an
// attacker-influenced ref can never reach `git clone --branch <ref>` as
// an option-shaped argument (e.g. `--upload-pack=...`).
const SAFE_REF_REGEX = /^[A-Za-z0-9._/-]+$/;

function validateRef(ref: string | undefined, source: string): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith("-") || !SAFE_REF_REGEX.test(ref)) {
    throw new Error(
      `Invalid git ref "${ref}" in source "${source}": refs may only contain letters, digits, ".", "_", "/", "-" and must not start with "-"`,
    );
  }
  return ref;
}

export function parseSource(source: string): ParsedSource {
  if (!source) {
    throw new Error("Source string is required");
  }

  // github:user/repo[@ref]
  const ghMatch = source.match(/^github:([^@]+?)(?:@(.+))?$/);
  if (ghMatch) {
    const [, userRepo, ref] = ghMatch;
    return {
      type: "github",
      cloneUrl: `https://github.com/${userRepo}.git`,
      displayName: userRepo!,
      ref: validateRef(ref, source),
      original: source,
    };
  }

  // gitlab:org/project[@ref]
  const glMatch = source.match(/^gitlab:([^@]+?)(?:@(.+))?$/);
  if (glMatch) {
    const [, orgProject, ref] = glMatch;
    return {
      type: "gitlab",
      cloneUrl: `https://gitlab.com/${orgProject}.git`,
      displayName: orgProject!,
      ref: validateRef(ref, source),
      original: source,
    };
  }

  // git@host:user/repo.git[@ref]  (SSH)
  // Must check before HTTPS to avoid git@ being confused
  const sshMatch = source.match(/^(git@[^:]+:[^@]+\.git)(?:@(.+))?$/);
  if (sshMatch) {
    const [, cloneUrl, ref] = sshMatch;
    // Extract user/repo from git@host:user/repo.git
    const pathMatch = cloneUrl!.match(/^git@[^:]+:(.+)\.git$/);
    const displayName = pathMatch ? pathMatch[1]! : cloneUrl!;
    return {
      type: "ssh",
      cloneUrl: cloneUrl!,
      displayName,
      ref: validateRef(ref, source),
      original: source,
    };
  }

  // file:///path[@ref]  (for testing)
  const fileMatch = source.match(/^(file:\/\/\/.+?)(?:@([^/]+))?$/);
  if (fileMatch) {
    const [, cloneUrl, ref] = fileMatch;
    const pathPart = cloneUrl!.replace("file:///", "/");
    return {
      type: "file",
      cloneUrl: cloneUrl!,
      displayName: pathPart,
      ref: validateRef(ref, source),
      original: source,
    };
  }

  // https://host/path.git[@ref]
  const httpsMatch = source.match(/^(https?:\/\/.+?)(?:@([^/]+))?$/);
  if (httpsMatch) {
    const [, cloneUrl, ref] = httpsMatch;
    // Strip protocol and .git suffix for display
    const displayName = cloneUrl!.replace(/^https?:\/\//, "").replace(/\.git$/, "");
    return {
      type: "https",
      cloneUrl: cloneUrl!,
      displayName,
      ref: validateRef(ref, source),
      original: source,
    };
  }

  throw new Error(
    `Unrecognized source format: "${source}". Expected github:user/repo, gitlab:org/project, https://host/repo.git, or git@host:user/repo.git`,
  );
}
