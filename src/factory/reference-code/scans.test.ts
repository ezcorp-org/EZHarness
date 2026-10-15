import { describe, expect, test } from "bun:test";
import { referenceCodeFixtureCandidate, referenceCodeLaunchRepository, REFERENCE_CODE_LAUNCH_FILES } from "./fixtures";
import {
  referenceCodeAdvisoryFindings,
  referenceCodeBlockingAdvisories,
  referenceCodeLockedPackages,
  referenceCodePathAllowed,
  referenceCodeSecretFindings,
  REFERENCE_CODE_ADVISORY_SNAPSHOT,
  REFERENCE_CODE_BLOCKING_SEVERITIES,
  REFERENCE_CODE_SECRET_RULES,
  type ReferenceCodeAdvisorySnapshot,
} from "./scans";
import type { ReferenceCodeFile } from "./snapshot";

const encoder = new TextEncoder();
const file = (path: string, text: string): ReferenceCodeFile => ({ path, mode: "100644", content: encoder.encode(text) });
const lock = (text: string): Uint8Array => encoder.encode(text);

describe("the pinned advisory snapshot", () => {
  test("resolves every package a Bun lockfile locks, including transitive ones", () => {
    const packages = referenceCodeLockedPackages(encoder.encode(REFERENCE_CODE_LAUNCH_FILES["bun.lock"]!));
    expect(packages.get("typescript")).toBe("5.9.3");
    expect(packages.get("@types/bun")).toBe("1.3.5");
    // `undici-types` is nobody's declared dependency; it is locked because `@types/node` needs it.
    expect(packages.get("undici-types")).toBe("8.9.0");
  });

  test("ignores a lockfile line whose key and resolved name disagree", () => {
    const packages = referenceCodeLockedPackages(lock('"left": ["right@1.0.0", "", {}, "sha512-x"],'));
    expect(packages.size).toBe(0);
  });

  test("tolerates bytes that are not valid UTF-8 rather than throwing", () => {
    expect(referenceCodeLockedPackages(new Uint8Array([0xff, 0xfe, 0x00, 0x41])).size).toBe(0);
  });

  test("finds the critical advisory the vulnerable fixture adds and rates it blocking", () => {
    const findings = referenceCodeAdvisoryFindings(lock('"event-stream": ["event-stream@3.3.6", "", {}, "sha512-x"],'));
    expect(findings).toEqual([{
      advisoryId: "GHSA-mh6f-8j2x-4483",
      package: "event-stream",
      version: "3.3.6",
      severity: "critical",
      title: "event-stream 3.3.6 depends on the malicious flatmap-stream package",
    }]);
    expect(referenceCodeBlockingAdvisories(findings)).toHaveLength(1);
  });

  test("passes the launch repository's own resolved dependency set", () => {
    const findings = referenceCodeAdvisoryFindings(encoder.encode(REFERENCE_CODE_LAUNCH_FILES["bun.lock"]!));
    expect(findings).toEqual([]);
  });

  test("ignores a version of a listed package the advisory does not cover", () => {
    expect(referenceCodeAdvisoryFindings(lock('"event-stream": ["event-stream@4.0.1", "", {}, "sha512-x"],'))).toEqual([]);
  });

  test("records a non-blocking severity without blocking on it", () => {
    const snapshot: ReferenceCodeAdvisorySnapshot = {
      ...REFERENCE_CODE_ADVISORY_SNAPSHOT,
      advisories: [{ id: "GHSA-low-0001", package: "typescript", versions: ["5.9.3"], severity: "moderate", title: "example" }],
    };
    const findings = referenceCodeAdvisoryFindings(encoder.encode(REFERENCE_CODE_LAUNCH_FILES["bun.lock"]!), snapshot);
    expect(findings).toHaveLength(1);
    expect(referenceCodeBlockingAdvisories(findings)).toEqual([]);
  });

  test("sorts several findings by advisory id so a receipt is stable", () => {
    const findings = referenceCodeAdvisoryFindings(lock([
      '"event-stream": ["event-stream@3.3.6", "", {}, "sha512-x"],',
      '"json5": ["json5@2.2.1", "", {}, "sha512-y"],',
    ].join("\n")));
    expect(findings.map(finding => finding.advisoryId)).toEqual(["GHSA-9c47-m6qq-7p4h", "GHSA-mh6f-8j2x-4483"]);
  });

  test("treats exactly high and critical as blocking", () => {
    expect([...REFERENCE_CODE_BLOCKING_SEVERITIES].sort()).toEqual(["critical", "high"]);
  });
});

describe("the pinned secret scanner", () => {
  test("finds the credential the leaked-secret fixture embeds, without quoting it", () => {
    const findings = referenceCodeSecretFindings(referenceCodeFixtureCandidate("leaked-secret"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe("anthropic-api-key");
    expect(findings[0]!.path).toBe("src/slugify.ts");
    expect(findings[0]!.line).toBe(1);
    expect(JSON.stringify(findings)).not.toContain("QmFkU2VjcmV0");
  });

  test("does not fire on the launch repository, whose lockfile is full of sha512 hashes", () => {
    expect(referenceCodeSecretFindings(referenceCodeLaunchRepository())).toEqual([]);
  });

  test("reports a match on every line rather than stopping at the first", () => {
    const key = `${["sk", "ant", "api03"].join("-")}-AAAABBBBCCCCDDDDEEEEFFFF-GGGG`;
    const findings = referenceCodeSecretFindings([file("a.ts", `const one = "${key}";\nconst two = "${key}";\n`)]);
    expect(findings.map(finding => finding.line)).toEqual([1, 2]);
  });

  test("recognizes each issuer shape the rule set pins", () => {
    const samples: ReadonlyArray<readonly [string, string]> = [
      ["openai-api-key", "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
      ["github-token", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab"],
      ["aws-access-key-id", "AKIAIOSFODNN7EXAMPLE"],
      ["google-api-key", "AIza" + "SyA".padEnd(35, "0")],
      ["slack-token", "xoxb-123456789012-abcdefghij"],
      ["private-key-block", "-----BEGIN RSA PRIVATE KEY-----"],
    ];
    for (const [ruleId, sample] of samples) {
      const findings = referenceCodeSecretFindings([file("s.txt", sample)]);
      expect(findings.map(finding => finding.ruleId)).toContain(ruleId);
    }
  });

  test("produces no finding for bytes that are not text", () => {
    expect(referenceCodeSecretFindings([{ path: "a.bin", mode: "100644", content: new Uint8Array([0, 1, 2, 255, 254]) }])).toEqual([]);
  });

  test("sorts findings by path then line", () => {
    const key = `${["sk", "ant", "api03"].join("-")}-AAAABBBBCCCCDDDDEEEEFFFF-GGGG`;
    const findings = referenceCodeSecretFindings([file("b.ts", `x\nconst k = "${key}";`), file("a.ts", `const k = "${key}";`)]);
    expect(findings.map(finding => `${finding.path}:${finding.line}`)).toEqual(["a.ts:1", "b.ts:2"]);
  });

  test("accepts a caller-supplied rule set", () => {
    const findings = referenceCodeSecretFindings([file("a.ts", "TOPSECRET")], [{ id: "custom", description: "custom", pattern: /TOPSECRET/g }]);
    expect(findings).toHaveLength(1);
    expect(REFERENCE_CODE_SECRET_RULES.some(rule => rule.id === "custom")).toBe(false);
  });
});

describe("allowed path prefixes", () => {
  test("a trailing slash means a directory prefix and a bare name means exactly that file", () => {
    expect(referenceCodePathAllowed("src/slugify.ts", ["src/"])).toBe(true);
    expect(referenceCodePathAllowed("srcx/slugify.ts", ["src/"])).toBe(false);
    expect(referenceCodePathAllowed("README.md", ["README.md"])).toBe(true);
    expect(referenceCodePathAllowed("README.md.bak", ["README.md"])).toBe(false);
    expect(referenceCodePathAllowed("src/slugify.ts", [])).toBe(false);
  });
});
