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
      ref: ref || undefined,
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
      ref: ref || undefined,
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
      ref: ref || undefined,
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
      ref: ref || undefined,
      original: source,
    };
  }

  // https://host/path.git[@ref]
  const httpsMatch = source.match(/^(https?:\/\/.+?)(?:@([^/]+))?$/);
  if (httpsMatch) {
    const [, cloneUrl, ref] = httpsMatch;
    // Strip protocol and .git suffix for display
    const displayName = cloneUrl!
      .replace(/^https?:\/\//, "")
      .replace(/\.git$/, "");
    return {
      type: "https",
      cloneUrl: cloneUrl!,
      displayName,
      ref: ref || undefined,
      original: source,
    };
  }

  throw new Error(
    `Unrecognized source format: "${source}". Expected github:user/repo, gitlab:org/project, https://host/repo.git, or git@host:user/repo.git`,
  );
}
