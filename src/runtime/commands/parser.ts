/**
 * Minimal YAML-lite frontmatter parser for slash-command markdown files.
 *
 * Parses files in the Claude Code / Codex convention:
 *
 *   ---
 *   description: …
 *   model: …
 *   agent: …
 *   argument-hint: …
 *   ---
 *   body (may contain $ARGUMENTS, $1, $2, …)
 *
 * Why hand-rolled and not `gray-matter`? We avoid new dependencies; command
 * frontmatter is a tiny subset of YAML (flat string key/value pairs) and
 * the full YAML spec is more surface area than we want to expose to an
 * untrusted filesystem (see the injection-surface notes in the plan).
 *
 * Malformed input never throws — returning the whole file as `body` with
 * empty frontmatter lets a single bad file co-exist with valid ones during
 * discovery instead of poisoning the whole scan.
 */

export interface ParsedCommandFile {
  frontmatter: Record<string, string>;
  body: string;
}

const DELIM = "---";

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0]!;
  const last = value[value.length - 1]!;
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseCommandFile(raw: string): ParsedCommandFile {
  // Normalise CRLF → LF and strip BOM up-front so downstream logic can
  // operate on a simple single-char delimiter.
  const src = stripBom(raw).replace(/\r\n/g, "\n");

  if (!src.startsWith(DELIM)) {
    return { frontmatter: {}, body: src };
  }

  // First line is exactly `---` (optionally followed by extra whitespace or
  // a newline). Everything from the next line up to the next `---` line is
  // frontmatter; everything after is body.
  const lines = src.split("\n");
  // Confirm the opening delimiter line really is just `---`.
  if (lines[0]?.trim() !== DELIM) {
    return { frontmatter: {}, body: src };
  }

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === DELIM) {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx === -1) {
    // Unclosed frontmatter — treat the whole file as body so a malformed
    // file doesn't poison the surrounding scan.
    return { frontmatter: {}, body: src };
  }

  const frontmatter: Record<string, string> = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue; // skip lines without a colon
    const key = line.slice(0, colonIdx).trim();
    if (key.length === 0) continue;
    const value = unquote(line.slice(colonIdx + 1).trim());
    // Duplicate keys: last wins (matches gray-matter's default behavior).
    frontmatter[key] = value;
  }

  const body = lines.slice(closeIdx + 1).join("\n");
  // Trim a single leading newline (frontmatter/body separation) while
  // preserving intentional blank lines deeper in the body.
  const trimmedBody = body.startsWith("\n") ? body.slice(1) : body;

  return { frontmatter, body: trimmedBody };
}
