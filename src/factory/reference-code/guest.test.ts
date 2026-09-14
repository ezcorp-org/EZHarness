import { describe, expect, test } from "bun:test";
import { validateFactoryValidatorClaimReport, type FactoryValidatorClaimReport } from "@ezcorp/factory-sdk";
import { referenceCodeFixtureCandidate, referenceCodeLaunchRepository, REFERENCE_CODE_FIXTURE_REQUEST } from "./fixtures";
import {
  referenceCodeGuestDigest,
  referenceCodeGuestFiles,
  ReferenceCodeGuestStagingError,
  stageReferenceCodeGuestSource,
  REFERENCE_CODE_GUEST_ENTRYPOINT,
  REFERENCE_CODE_GUEST_SOURCES,
} from "./guest";
import {
  referenceCodeGuestReport,
  referenceCodeGuestTool,
  REFERENCE_CODE_GUEST_EXTENSION,
  REFERENCE_CODE_GUEST_MANIFEST,
  REFERENCE_CODE_GUEST_SCHEMA_VERSION,
  REFERENCE_CODE_GUEST_SERVED,
  REFERENCE_CODE_GUEST_TOOL,
  type ReferenceCodeGuestInput,
} from "./guest-entry";
import type { ReferenceCodeFile } from "./snapshot";

const BASE = "a".repeat(39) + "1";
const TREE = "c".repeat(39) + "3";
const MEASURED_AT = Date.parse("2026-09-14T00:00:00.000Z");

function wire(files: readonly ReferenceCodeFile[]): ReferenceCodeGuestInput["candidateFiles"] {
  return files.map(file => ({ path: file.path, mode: file.mode, contentBase64: Buffer.from(file.content).toString("base64") }));
}

function guestInput(candidate: readonly ReferenceCodeFile[], overrides: Partial<ReferenceCodeGuestInput> = {}): ReferenceCodeGuestInput {
  return {
    schemaVersion: REFERENCE_CODE_GUEST_SCHEMA_VERSION,
    baseSha: BASE,
    treeSha: TREE,
    snapshotFiles: wire(referenceCodeLaunchRepository()),
    candidateFiles: wire(candidate),
    allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
    protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
    measuredAtMs: MEASURED_AT,
    ...overrides,
  };
}

function verdicts(report: FactoryValidatorClaimReport): Record<string, string> {
  return Object.fromEntries(report.claims.map(claim => [claim.id, claim.verdict]));
}

describe("the guest's report", () => {
  test("passes the four static claims for the accepted candidate", () => {
    const report = referenceCodeGuestReport(guestInput(referenceCodeFixtureCandidate("accepted")));
    expect(validateFactoryValidatorClaimReport(report).ok).toBe(true);
    expect(verdicts(report)).toEqual({
      "dependency-advisory": "PASS", "secret-scan": "PASS", "allowed-paths": "PASS", "protected-assets-unchanged": "PASS",
    });
    expect(report.error).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("provenance");
  });

  test("fails the claim each negative fixture was built to break", () => {
    expect(verdicts(referenceCodeGuestReport(guestInput(referenceCodeFixtureCandidate("leaked-secret"))))["secret-scan"]).toBe("FAIL");
    expect(verdicts(referenceCodeGuestReport(guestInput(referenceCodeFixtureCandidate("outside-allowed-paths"))))["allowed-paths"]).toBe("FAIL");
    expect(verdicts(referenceCodeGuestReport(guestInput(referenceCodeFixtureCandidate("removed-protected-test"))))["protected-assets-unchanged"]).toBe("FAIL");
  });

  test("uses a caller-supplied advisory snapshot when one is pinned into the payload", () => {
    const input = guestInput(referenceCodeFixtureCandidate("accepted"), {
      advisories: {
        schemaVersion: "factory.reference-code-advisories.v1",
        capturedAtMs: MEASURED_AT,
        source: "test-snapshot",
        advisories: [{ id: "GHSA-test", package: "typescript", versions: ["5.9.3"], severity: "critical", title: "example" }],
      },
    });
    const report = referenceCodeGuestReport(input);
    expect(verdicts(report)["dependency-advisory"]).toBe("FAIL");
    expect(report.claims.find(claim => claim.id === "dependency-advisory")!.summary).toContain("GHSA-test");
  });

  test("treats a payload it does not recognize as a validator error, never a pass", () => {
    for (const payload of [undefined, null, "text", { schemaVersion: "not.a.known.shape" }]) {
      const report = referenceCodeGuestReport(payload);
      expect(report.claims.every(claim => claim.verdict === "VALIDATOR_ERROR")).toBe(true);
      expect(report.error?.code).toBe("guest_input_invalid");
      expect(validateFactoryValidatorClaimReport(report).ok).toBe(true);
    }
  });

  test("reports claims through the broker and returns a result that mints no evidence", async () => {
    const calls: { method: string; value: unknown }[] = [];
    const result = await referenceCodeGuestTool(
      { input: { kind: "inline", value: guestInput(referenceCodeFixtureCandidate("accepted")) } },
      { call: async (method: string, value: unknown) => { calls.push({ method, value }); return { accepted: true }; } },
    );
    expect(REFERENCE_CODE_GUEST_EXTENSION).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("factory.broker");
    expect((calls[0]!.value as { kind: string }).kind).toBe("validator-report");
    expect(result).toEqual({ schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: 0, operations: [] });
  });

  test("declares one tool, and does not serve when it is only imported", () => {
    expect(REFERENCE_CODE_GUEST_MANIFEST.tools.map(tool => tool.name)).toEqual([REFERENCE_CODE_GUEST_TOOL]);
    expect(REFERENCE_CODE_GUEST_MANIFEST.schemaVersion).toBe(4);
    expect(REFERENCE_CODE_GUEST_SERVED).toBeUndefined();
  });
});

describe("staging the guest's committed source", () => {
  test("stages every closure file and rewrites its specifiers to the flat workspace", async () => {
    const files = await referenceCodeGuestFiles();
    expect(Object.keys(files).sort()).toEqual([...Object.keys(REFERENCE_CODE_GUEST_SOURCES), "feature.test.ts"].sort());
    const entry = files[REFERENCE_CODE_GUEST_ENTRYPOINT]!;
    expect(entry).toContain('from "./factory-sdk-types.ts"');
    expect(entry).toContain('from "./static-claims.ts"');
    expect(entry).toContain('from "@ezcorp/sdk/v4"');
    expect(entry).not.toContain("@ezcorp/factory-sdk/types");
    expect(files["snapshot.ts"]).toContain('from "./digest.ts"');
    expect(files["snapshot.ts"]).toContain('from "./git-objects.ts"');
  });

  test("stages the SDK's own type module rather than a second copy of those types", async () => {
    const files = await referenceCodeGuestFiles();
    const committed = await Bun.file(`${import.meta.dir}/../../../packages/@ezcorp/factory-sdk/src/types.ts`).text();
    expect(files["factory-sdk-types.ts"]).toBe(committed);
  });

  test("the digest changes when any staged byte changes", async () => {
    const digest = await referenceCodeGuestDigest();
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await referenceCodeGuestDigest()).toBe(digest);
  });

  test("refuses a specifier the guest workspace does not provide", () => {
    expect(() => stageReferenceCodeGuestSource("a.ts", 'import { x } from "../../db/connection";\n'))
      .toThrow(/a\.ts imports '\.\.\/\.\.\/db\/connection', which the guest workspace does not provide/);
    const error = new ReferenceCodeGuestStagingError("detail");
    expect(error.name).toBe("ReferenceCodeGuestStagingError");
    expect(error.detail).toBe("detail");
  });

  test("leaves the specifiers the guest image provides alone", () => {
    const source = 'import { createHash } from "node:crypto";\nimport { serve } from "@ezcorp/sdk/v4";\n';
    expect(stageReferenceCodeGuestSource("a.ts", source)).toBe(source);
  });

  test("rewrites single-quoted and re-exported specifiers too", () => {
    expect(stageReferenceCodeGuestSource("a.ts", "export { scan } from './scans';\n")).toContain("'./scans.ts'");
  });
});
