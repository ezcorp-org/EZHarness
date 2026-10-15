import type { ReferenceCodeFile } from "./snapshot";

/**
 * The two pinned scans a reference-code candidate must survive: secrets and dependency advisories.
 *
 * Both are deliberately snapshot-based rather than live. A live advisory feed would make the same
 * candidate acceptable on Monday and unacceptable on Tuesday for reasons no evidence records, and a
 * live secret service would put a candidate's contents on someone else's network. Here the rule set
 * is data, it is pinned by digest with the rest of the release lock, and a finding can be
 * reproduced from the recorded snapshot years later.
 */

export const REFERENCE_CODE_ADVISORY_SNAPSHOT_SCHEMA_VERSION = "factory.reference-code-advisories.v1" as const;

export type ReferenceCodeAdvisorySeverity = "low" | "moderate" | "high" | "critical";

export interface ReferenceCodeAdvisory {
  readonly id: string;
  readonly package: string;
  /** Exact versions the advisory applies to. Ranges are expanded when the snapshot is captured. */
  readonly versions: readonly string[];
  readonly severity: ReferenceCodeAdvisorySeverity;
  readonly title: string;
}

export interface ReferenceCodeAdvisorySnapshot {
  readonly schemaVersion: typeof REFERENCE_CODE_ADVISORY_SNAPSHOT_SCHEMA_VERSION;
  /** When the feed was captured. Recorded so a claim states what it actually knew. */
  readonly capturedAtMs: number;
  readonly source: string;
  readonly advisories: readonly ReferenceCodeAdvisory[];
}

/** Severities C10 treats as blocking. Moderate and low are recorded, never blocking. */
export const REFERENCE_CODE_BLOCKING_SEVERITIES: ReadonlySet<string> = new Set(["high", "critical"]);

/**
 * The pinned advisory snapshot the reference pack ships.
 *
 * It is small because the supported launch repository is small. The one entry is real: the
 * `event-stream` 3.3.6 release carried a malicious `flatmap-stream` dependency, which is why it is
 * the fixture a candidate must be refused for adding.
 */
export const REFERENCE_CODE_ADVISORY_SNAPSHOT: ReferenceCodeAdvisorySnapshot = Object.freeze({
  schemaVersion: REFERENCE_CODE_ADVISORY_SNAPSHOT_SCHEMA_VERSION,
  capturedAtMs: Date.parse("2026-09-01T00:00:00.000Z"),
  source: "github-advisory-database",
  advisories: Object.freeze([
    Object.freeze({
      id: "GHSA-mh6f-8j2x-4483",
      package: "event-stream",
      versions: Object.freeze(["3.3.6"]),
      severity: "critical" as const,
      title: "event-stream 3.3.6 depends on the malicious flatmap-stream package",
    }),
    Object.freeze({
      id: "GHSA-9c47-m6qq-7p4h",
      package: "json5",
      versions: Object.freeze(["0.5.1", "1.0.1", "2.2.0", "2.2.1"]),
      severity: "high" as const,
      title: "json5 prototype pollution in parse",
    }),
  ]),
});

export interface ReferenceCodeAdvisoryFinding {
  readonly advisoryId: string;
  readonly package: string;
  readonly version: string;
  readonly severity: ReferenceCodeAdvisorySeverity;
  readonly title: string;
}

/** Every `name@version` a Bun lockfile resolves, including transitive entries. */
export function referenceCodeLockedPackages(lockContent: Uint8Array): ReadonlyMap<string, string> {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(lockContent);
  const resolved = new Map<string, string>();
  // Bun writes `"name": ["name@version", ...]` for every resolved package, including transitives.
  const entry = /"((?:@[^"@/]+\/)?[^"@]+)":\s*\[\s*"((?:@[^"@/]+\/)?[^"@]+)@([^"]+)"/g;
  for (const match of text.matchAll(entry)) {
    const [, key, name, version] = match;
    if (key !== name || !name || !version) continue;
    resolved.set(name, version);
  }
  return resolved;
}

/**
 * Advisory findings for one resolved dependency set.
 *
 * Only the resolved lockfile is consulted. A manifest range says which versions are permitted; the
 * lockfile says which one would actually be installed, and that is the one a run executes.
 */
export function referenceCodeAdvisoryFindings(
  lockContent: Uint8Array,
  snapshot: ReferenceCodeAdvisorySnapshot = REFERENCE_CODE_ADVISORY_SNAPSHOT,
): readonly ReferenceCodeAdvisoryFinding[] {
  const resolved = referenceCodeLockedPackages(lockContent);
  const findings: ReferenceCodeAdvisoryFinding[] = [];
  for (const advisory of snapshot.advisories) {
    const version = resolved.get(advisory.package);
    if (version === undefined || !advisory.versions.includes(version)) continue;
    findings.push({ advisoryId: advisory.id, package: advisory.package, version, severity: advisory.severity, title: advisory.title });
  }
  return findings.sort((left, right) => (left.advisoryId < right.advisoryId ? -1 : 1));
}

/** Findings whose severity C10 treats as blocking. */
export function referenceCodeBlockingAdvisories(findings: readonly ReferenceCodeAdvisoryFinding[]): readonly ReferenceCodeAdvisoryFinding[] {
  return findings.filter(finding => REFERENCE_CODE_BLOCKING_SEVERITIES.has(finding.severity));
}

export interface ReferenceCodeSecretRule {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
}

/**
 * The pinned secret rules.
 *
 * Each pattern matches a credential's own published shape rather than "a long random-looking
 * string", because the second kind of rule fires on lockfile integrity hashes and base64 test
 * vectors and then gets switched off. The rules are anchored on their issuer prefixes, so a
 * finding always names which kind of credential was found.
 */
export const REFERENCE_CODE_SECRET_RULES: readonly ReferenceCodeSecretRule[] = Object.freeze([
  Object.freeze({ id: "anthropic-api-key", description: "Anthropic API key", pattern: /sk-ant-[A-Za-z0-9]{4,}-[A-Za-z0-9_-]{16,}/g }),
  Object.freeze({ id: "openai-api-key", description: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g }),
  Object.freeze({ id: "github-token", description: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g }),
  Object.freeze({ id: "aws-access-key-id", description: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g }),
  Object.freeze({ id: "google-api-key", description: "Google API key", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g }),
  Object.freeze({ id: "slack-token", description: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g }),
  Object.freeze({ id: "private-key-block", description: "PEM private key block", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g }),
]);

export interface ReferenceCodeSecretFinding {
  readonly ruleId: string;
  readonly description: string;
  readonly path: string;
  /** One-based, so it reads like an editor's gutter. */
  readonly line: number;
}

/** Text as lines, tolerating any encoding: a binary file simply produces no match. */
function lines(content: Uint8Array): readonly string[] {
  return new TextDecoder("utf-8", { fatal: false }).decode(content).split("\n");
}

/**
 * Secret findings across a complete tree.
 *
 * Only the path and the line are reported. The matched text is never carried into a finding,
 * because a validator report is durable evidence that operators read: a scanner that quotes the
 * credential it found republishes it into every place that evidence travels.
 */
export function referenceCodeSecretFindings(
  files: readonly ReferenceCodeFile[],
  rules: readonly ReferenceCodeSecretRule[] = REFERENCE_CODE_SECRET_RULES,
): readonly ReferenceCodeSecretFinding[] {
  const findings: ReferenceCodeSecretFinding[] = [];
  for (const file of files) {
    const text = lines(file.content);
    for (let index = 0; index < text.length; index += 1) {
      for (const rule of rules) {
        // A global regular expression carries `lastIndex` between calls; testing a fresh one per
        // line keeps a match on one line from hiding a match on the next.
        if (new RegExp(rule.pattern.source).test(text[index]!)) {
          findings.push({ ruleId: rule.id, description: rule.description, path: file.path, line: index + 1 });
        }
      }
    }
  }
  return findings.sort((left, right) => (left.path === right.path ? left.line - right.line : left.path < right.path ? -1 : 1));
}

/** True when `path` sits under one of the prefixes the request was approved for. */
export function referenceCodePathAllowed(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix));
}
