import { describe, expect, test } from "bun:test";
import { validateFactoryValidatorClaimReport, type FactoryValidatorClaimOutcome } from "@ezcorp/factory-sdk";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { referenceCodeProtectedChecks, referenceCodeStaticClaims, REFERENCE_CODE_DETERMINISTIC_CLAIM_IDS, type ReferenceCodeChecksInput } from "./checks";
import { freezeReferenceCodeCandidate, type ReferenceCodeCandidate } from "./freeze";
import { referenceCodeFixtureCandidate, referenceCodeLaunchRepository, withReferenceCodeFile, REFERENCE_CODE_FIXTURE_REQUEST, type ReferenceCodeFixtureName } from "./fixtures";
import { REFERENCE_CODE_ADVISORY_SNAPSHOT } from "./scans";
import { sealReferenceCodeSnapshot, type ReferenceCodeFile } from "./snapshot";
import type { ReferenceCodeCommandResult, ReferenceCodeCommandRunner } from "./workspace";

const BASE = "a".repeat(39) + "1";
const PROTECTED_TESTS = ["test/slugify.protected.test.ts"];
const NOW = Date.parse("2026-09-14T00:00:00.000Z");

const snapshot = sealReferenceCodeSnapshot({
  baseSha: BASE,
  treeSha: "b".repeat(39) + "2",
  entries: referenceCodeLaunchRepository().map(file => ({ path: file.path, mode: file.mode as string, content: file.content })),
});

function freeze(files: readonly ReferenceCodeFile[]): ReferenceCodeCandidate {
  return freezeReferenceCodeCandidate({
    snapshot,
    files,
    repositoryId: 1,
    baseBranch: REFERENCE_CODE_FIXTURE_REQUEST.baseBranch,
    issue: REFERENCE_CODE_FIXTURE_REQUEST.issue,
    title: REFERENCE_CODE_FIXTURE_REQUEST.title,
    allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
    protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
    authoredAtSeconds: 1_760_000_000,
    candidateGeneration: 0,
  });
}

/** A runner that answers from a script of exit codes, so a branch can be driven without a toolchain. */
function scriptedRunner(exits: Readonly<Record<string, number>>, options: { timeout?: string; onRun?: (cwd: string, command: readonly string[]) => Promise<void> } = {}): ReferenceCodeCommandRunner & { readonly seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async run(command, runOptions): Promise<ReferenceCodeCommandResult> {
      const key = command.slice(0, 3).join(" ");
      seen.push(key);
      await options.onRun?.(runOptions.cwd, command);
      const timedOut = options.timeout === key;
      return { command: [...command], exitCode: timedOut ? -1 : exits[key] ?? 0, output: `output for ${key}\nline two`, truncated: false, durationMs: 7, timedOut };
    },
  };
}

function checksInput(name: ReferenceCodeFixtureName, overrides: Partial<ReferenceCodeChecksInput> = {}): ReferenceCodeChecksInput {
  const files = referenceCodeFixtureCandidate(name);
  return {
    candidate: freeze(files),
    snapshot,
    files,
    allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
    protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
    protectedTestPaths: PROTECTED_TESTS,
    runner: scriptedRunner({}),
    now: () => NOW,
    workspacePrefix: "ezcorp-w10-checks-",
    ...overrides,
  };
}

function claim(claims: readonly FactoryValidatorClaimOutcome[], id: string): FactoryValidatorClaimOutcome {
  const found = claims.find(entry => entry.id === id);
  if (!found) throw new Error(`no claim ${id}`);
  return found;
}

describe("the nine deterministic protected claims", () => {
  test("every claim id is reported exactly once, in a report the SDK accepts", async () => {
    const result = await referenceCodeProtectedChecks(checksInput("accepted"));
    expect(result.report.claims.map(entry => entry.id).sort()).toEqual([...REFERENCE_CODE_DETERMINISTIC_CLAIM_IDS].sort());
    expect(result.report.claims).toHaveLength(9);
    expect(validateFactoryValidatorClaimReport(result.report).ok).toBe(true);
    expect(result.report.error).toBeUndefined();
  });

  test("the accepted candidate passes all nine and verifies the copy it ran in", async () => {
    const result = await referenceCodeProtectedChecks(checksInput("accepted"));
    expect(result.report.claims.every(entry => entry.verdict === "PASS")).toBe(true);
    expect(result.report.claims.every(entry => entry.decisive)).toBe(true);
    expect(result.verifiedWorkspaceDigest).toBe(freeze(referenceCodeFixtureCandidate("accepted")).filesDigest);
    expect(result.commands.map(entry => entry.command[1])).toEqual(["install", "run", "run", "run", "test"]);
  });

  test("a candidate that writes outside the allowed paths fails exactly that claim", async () => {
    const result = await referenceCodeProtectedChecks(checksInput("outside-allowed-paths"));
    expect(claim(result.report.claims, "allowed-paths").verdict).toBe("FAIL");
    expect(claim(result.report.claims, "allowed-paths").summary).toContain("tools/release.ts");
    expect(result.disallowedPaths).toEqual(["tools/release.ts"]);
    expect(claim(result.report.claims, "secret-scan").verdict).toBe("PASS");
  });

  test("a candidate that leaks a credential fails the secret scan without quoting it", async () => {
    const result = await referenceCodeProtectedChecks(checksInput("leaked-secret"));
    const outcome = claim(result.report.claims, "secret-scan");
    expect(outcome.verdict).toBe("FAIL");
    expect(outcome.summary).toContain("anthropic-api-key at src/slugify.ts:1");
    expect(outcome.summary).not.toContain("QmFkU2VjcmV0");
    expect(result.secretFindings).toHaveLength(1);
  });

  test("a candidate that adds a critically rated dependency fails the advisory claim", async () => {
    const result = await referenceCodeProtectedChecks(checksInput("vulnerable-dependency"));
    // The manifest is protected, so the same candidate fails two claims, and both are reported.
    expect(claim(result.report.claims, "protected-assets-unchanged").verdict).toBe("FAIL");
    const lockedAdvisory = await referenceCodeProtectedChecks(checksInput("accepted", {
      files: withReferenceCodeFile(referenceCodeFixtureCandidate("accepted"), "bun.lock", '{\n  "packages": {\n    "event-stream": ["event-stream@3.3.6", "", {}, "sha512-x"],\n  }\n}\n'),
      candidate: freeze(withReferenceCodeFile(referenceCodeFixtureCandidate("accepted"), "bun.lock", '{\n  "packages": {\n    "event-stream": ["event-stream@3.3.6", "", {}, "sha512-x"],\n  }\n}\n')),
    }));
    const outcome = claim(lockedAdvisory.report.claims, "dependency-advisory");
    expect(outcome.verdict).toBe("FAIL");
    expect(outcome.summary).toContain("GHSA-mh6f-8j2x-4483 (critical) event-stream@3.3.6");
  });

  test("a candidate that changed a protected asset fails that claim and names it", async () => {
    const files = withReferenceCodeFile(referenceCodeFixtureCandidate("accepted"), "test/slugify.protected.test.ts", "// no assertions\n");
    const result = await referenceCodeProtectedChecks(checksInput("accepted", { files, candidate: freeze(files) }));
    const outcome = claim(result.report.claims, "protected-assets-unchanged");
    expect(outcome.verdict).toBe("FAIL");
    expect(outcome.summary).toContain("test/slugify.protected.test.ts");
    expect(result.changedProtectedPaths).toEqual(["test/slugify.protected.test.ts"]);
  });

  test("a nonzero exit fails its claim and carries the tail a repair can read", async () => {
    const result = await referenceCodeProtectedChecks(checksInput("accepted", { runner: scriptedRunner({ "bun run test": 1 }) }));
    const outcome = claim(result.report.claims, "declared-tests");
    expect(outcome.verdict).toBe("FAIL");
    expect(outcome.reasonCode).toBe("command_exit_nonzero");
    expect(outcome.summary).toContain("exited 1");
    expect(outcome.summary).toContain("line two");
    expect(claim(result.report.claims, "build").verdict).toBe("PASS");
  });

  test("a timed-out command is inconclusive, never a pass and never a fail", async () => {
    const result = await referenceCodeProtectedChecks(checksInput("accepted", { runner: scriptedRunner({}, { timeout: "bun run typecheck" }) }));
    const outcome = claim(result.report.claims, "typecheck");
    expect(outcome.verdict).toBe("INCONCLUSIVE");
    expect(outcome.reasonCode).toBe("command_timed_out");
    expect(outcome.decisive).toBe(false);
  });

  test("a failed frozen install leaves everything downstream unmeasured rather than guessed", async () => {
    const runner = scriptedRunner({ "bun install --frozen-lockfile": 1 });
    const result = await referenceCodeProtectedChecks(checksInput("accepted", { runner }));
    expect(claim(result.report.claims, "frozen-install").verdict).toBe("FAIL");
    for (const id of ["build", "typecheck", "declared-tests", "protected-fixtures"]) {
      const outcome = claim(result.report.claims, id);
      expect(outcome.verdict).toBe("INCONCLUSIVE");
      expect(outcome.reasonCode).toBe("prerequisite_failed");
      expect(outcome.summary).toContain("frozen dependency installation");
    }
    expect(runner.seen).toEqual(["bun install --frozen-lockfile"]);
    expect(result.commands).toHaveLength(1);
  });

  test("a check that rewrites a protected asset invalidates every measured claim in that run", async () => {
    const runner = scriptedRunner({}, {
      onRun: async (cwd, command) => {
        if (command[1] !== "run") return;
        const target = join(cwd, "test/slugify.protected.test.ts");
        await chmod(target, 0o644);
        await writeFile(target, "// rewritten by the candidate's own build script\n");
      },
    });
    const result = await referenceCodeProtectedChecks(checksInput("accepted", { runner }));
    for (const id of ["frozen-install", "build", "typecheck", "declared-tests", "protected-fixtures"]) {
      const outcome = claim(result.report.claims, id);
      expect(outcome.verdict).toBe("INCONCLUSIVE");
      expect(outcome.summary).toContain("modified a protected asset");
    }
    // The static claims still stand: they were measured from the candidate's own bytes.
    expect(claim(result.report.claims, "secret-scan").verdict).toBe("PASS");
  });

  test("a copy that cannot be prepared still reports every static claim", async () => {
    const files = referenceCodeFixtureCandidate("accepted");
    const candidate = freeze(files);
    const result = await referenceCodeProtectedChecks(checksInput("accepted", {
      files,
      candidate: { ...candidate, filesDigest: "sha256:" + "0".repeat(64) },
    }));
    expect(result.verifiedWorkspaceDigest).toBeNull();
    expect(result.commands).toEqual([]);
    expect(claim(result.report.claims, "allowed-paths").verdict).toBe("PASS");
    expect(claim(result.report.claims, "build").verdict).toBe("INCONCLUSIVE");
    expect(claim(result.report.claims, "build").summary).toContain("reference_code_workspace_digest_mismatch");
    expect(validateFactoryValidatorClaimReport(result.report).ok).toBe(true);
  });

  test("a real error inside the copy is raised rather than reported as a verdict", async () => {
    const files = referenceCodeFixtureCandidate("accepted");
    const thrower: ReferenceCodeCommandRunner = { run: async () => { throw new TypeError("runner exploded"); } };
    await expect(referenceCodeProtectedChecks(checksInput("accepted", { files, runner: thrower }))).rejects.toThrow("runner exploded");
  });
});

describe("the static claims on their own", () => {
  test("report an inconclusive advisory claim when the candidate has no lockfile", () => {
    const files = referenceCodeFixtureCandidate("accepted").filter(file => file.path !== "bun.lock");
    const statics = referenceCodeStaticClaims({
      changedPaths: freeze(referenceCodeFixtureCandidate("accepted")).changedPaths,
      snapshot,
      files,
      allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
      protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
      advisories: REFERENCE_CODE_ADVISORY_SNAPSHOT,
      measuredAtMs: NOW,
    });
    const outcome = claim(statics.claims, "dependency-advisory");
    expect(outcome.verdict).toBe("INCONCLUSIVE");
    expect(outcome.reasonCode).toBe("lock_missing");
    expect(claim(statics.claims, "protected-assets-unchanged").verdict).toBe("FAIL");
  });

  test("record a non-blocking advisory in the passing summary rather than hiding it", () => {
    const files = referenceCodeFixtureCandidate("accepted");
    const statics = referenceCodeStaticClaims({
      changedPaths: freeze(files).changedPaths,
      snapshot,
      files,
      allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
      protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
      advisories: { ...REFERENCE_CODE_ADVISORY_SNAPSHOT, advisories: [{ id: "GHSA-x", package: "typescript", versions: ["5.9.3"], severity: "moderate", title: "example" }] },
      measuredAtMs: NOW,
    });
    const outcome = claim(statics.claims, "dependency-advisory");
    expect(outcome.verdict).toBe("PASS");
    expect(outcome.summary).toContain("1 non-blocking match(es)");
    expect(statics.advisoryFindings).toHaveLength(1);
  });
});
