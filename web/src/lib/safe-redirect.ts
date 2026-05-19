// Validate a returnTo value supplied via untrusted input (the login URL is
// attacker-controllable). Same-origin paths only — anything that could
// navigate the browser off-site (protocol-relative `//evil.com`,
// backslash-prefixed `/\evil.com`, absolute URLs) collapses to "/".
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
