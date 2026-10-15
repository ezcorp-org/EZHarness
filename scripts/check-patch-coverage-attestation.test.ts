/**
 * W03g: the patch gate accepts an attested line only while its line number,
 * exact text, the file's SHA-256 and `.bun-version` all match the recorded
 * entry; a stale entry and a no-longer-needed entry each fail the gate by name.
 * Unit cases pin every branch of the schema and the verdict; the end-to-end
 * cases drive the real gate's main() over a real diff in a sandbox.
 */
import { describe, expect, test } from "bun:test";
import { gateAfterWriting, makePatchGateSandbox } from "../src/__tests__/helpers/patch-coverage-sandbox";
import {
  ATTESTATIONS_PATH,
  type AttestationContext,
  type CoverageAttestation,
  evaluateAttestations,
  parseAttestations,
  sha256Hex,
} from "./check-patch-coverage.ts";

const FILE = "src/factory/stops.ts";
const SOURCE = "export async function settle(read: () => Promise<number>): Promise<number> {\n  return 2 * (await read());\n}\n";
const LINE = 2;
const TEXT = "  return 2 * (await read());";

function entry(overrides: Partial<CoverageAttestation> = {}): CoverageAttestation {
  return {
    file: FILE,
    line: LINE,
    text: TEXT,
    fileSha256: sha256Hex(SOURCE),
    bunVersion: "1.3.14",
    reason: "Bun 1.3.14 credits the statement after an await to the line before it.",
    proof: ["/tmp/probe/throw-mutant.log"],
    ...overrides,
  };
}

function context(overrides: Partial<AttestationContext> = {}): AttestationContext {
  return {
    bunVersion: "1.3.14",
    addedLines: new Map([[FILE, new Set([1, 2, 3])]]),
    source: (file) => (file === FILE ? SOURCE : undefined),
    hitLines: () => new Set([1]),
    missedLines: () => new Set([2]),
    ...overrides,
  };
}

describe("parseAttestations: the schema fails closed by name", () => {
  test("a well-formed entry parses unchanged, indentation of the text included", () => {
    expect(parseAttestations(JSON.stringify([entry()]))).toEqual([entry()]);
    expect(parseAttestations("[]")).toEqual([]);
  });

  test.each([
    ["not an array", "{}", "must be a JSON array"],
    ["an entry that is not an object", "[1]", "[0]: must be an object"],
    ["an unknown field", JSON.stringify([{ ...entry(), exclude: true }]), "unknown field(s) exclude"],
    ["a line that is not a positive integer", JSON.stringify([entry({ line: 0 })]), '"line" must be a positive integer'],
    ["a fractional line", JSON.stringify([entry({ line: 2.5 })]), '"line" must be a positive integer'],
    ["an empty text", JSON.stringify([entry({ text: "   " })]), '"text" must be a non-empty string'],
    ["a missing reason", JSON.stringify([{ ...entry(), reason: undefined }]), '"reason" must be a non-empty string'],
    ["a hash that is not SHA-256 hex", JSON.stringify([entry({ fileSha256: "abc" })]), '"fileSha256" must be 64 lowercase hex characters'],
    ["an empty proof list", JSON.stringify([entry({ proof: [] })]), '"proof" must be a non-empty array of paths'],
    ["a blank proof path", JSON.stringify([entry({ proof: [" "] })]), '"proof" must be a non-empty array of paths'],
    ["two entries for one line", JSON.stringify([entry(), entry()]), `[1]: duplicate attestation for ${FILE}:${LINE}`],
  ])("%s is refused", (_label, json, message) => {
    expect(() => parseAttestations(json)).toThrow(message);
  });
});

describe("evaluateAttestations: every branch", () => {
  test("all four facts match and the line is uncovered: the line is attested and reported with the Bun version", () => {
    const verdict = evaluateAttestations([entry()], context());
    expect(verdict.findings).toEqual([]);
    expect(verdict.attested.get(FILE)).toEqual(new Set([LINE]));
    expect(verdict.attestedReport).toEqual([
      `${FILE}:${LINE} attested (Bun 1.3.14 coverage defect): ${entry().reason} Proof: /tmp/probe/throw-mutant.log`,
    ]);
  });

  test("a changed Bun pin stales the entry even when the file is not in the diff", () => {
    const verdict = evaluateAttestations([entry()], context({ bunVersion: "1.4.2", addedLines: new Map() }));
    expect(verdict.attested.size).toBe(0);
    expect(verdict.findings).toEqual([
      `stale attestation ${FILE}:${LINE}: proved on Bun 1.3.14, but .bun-version is 1.4.2 — ` +
        `re-prove the line on 1.4.2 or remove the entry from ${ATTESTATIONS_PATH}`,
    ]);
  });

  test("a file this diff does not change leaves the entry inactive, not attested and not failing", () => {
    const verdict = evaluateAttestations([entry()], context({ addedLines: new Map([["src/other.ts", new Set([1])]]) }));
    expect(verdict).toEqual({ attested: new Map(), attestedReport: [], findings: [], inactive: [`${FILE}:${LINE} (file not changed in this diff)`] });
  });

  test("a deleted file stales the entry", () => {
    const verdict = evaluateAttestations([entry()], context({ source: () => undefined }));
    expect(verdict.findings).toEqual([`stale attestation ${FILE}:${LINE}: the file no longer exists — remove the entry from ${ATTESTATIONS_PATH}`]);
  });

  test("any edit elsewhere in the file stales the entry by its hash", () => {
    const verdict = evaluateAttestations([entry()], context({ source: () => `${SOURCE}// one more line\n` }));
    expect(verdict.attested.size).toBe(0);
    expect(verdict.findings[0]).toStartWith(`stale attestation ${FILE}:${LINE}: the file changed since it was proved (SHA-256 differs)`);
  });

  test("a recorded text that does not match the line stales the entry, and so does a moved line number", () => {
    const wrongText = evaluateAttestations([entry({ text: "  return 3 * (await read());" })], context());
    const movedLine = evaluateAttestations([entry({ line: 1 })], context());
    for (const verdict of [wrongText, movedLine]) {
      expect(verdict.attested.size).toBe(0);
      expect(verdict.findings[0]).toContain("the line's text differs from the recorded text");
    }
  });

  test("a line this diff does not change leaves the entry inactive", () => {
    const verdict = evaluateAttestations([entry()], context({ addedLines: new Map([[FILE, new Set([1])]]) }));
    expect(verdict.findings).toEqual([]);
    expect(verdict.inactive).toEqual([`${FILE}:${LINE} (line not changed in this diff)`]);
  });

  test("a line coverage now credits fails as no longer needed", () => {
    const verdict = evaluateAttestations([entry()], context({ hitLines: () => new Set([1, 2]), missedLines: () => new Set() }));
    expect(verdict.attested.size).toBe(0);
    expect(verdict.findings[0]).toStartWith(`attestation ${FILE}:${LINE} is no longer needed`);
  });

  test("a line with no uncovered DA record fails as no longer needed too", () => {
    const verdict = evaluateAttestations([entry()], context({ missedLines: () => new Set() }));
    expect(verdict.findings[0]).toStartWith(`attestation ${FILE}:${LINE} is no longer needed`);
  });
});

describe("patch coverage: attestations end to end", () => {
  const lcov = (root: string, missed: boolean) =>
    `TN:\nSF:${root}/${FILE}\nDA:1,4\nDA:${LINE},${missed ? 0 : 4}\nend_of_record\n`;
  const files = (attestations: CoverageAttestation[], bun = "1.3.14") => ({
    [FILE]: SOURCE,
    ".bun-version": `${bun}\n`,
    [ATTESTATIONS_PATH]: `${JSON.stringify(attestations, null, 2)}\n`,
  });

  test("without an attestation the uncredited line fails the gate (the control)", async () => {
    const sandbox = await makePatchGateSandbox();
    try {
      const result = await gateAfterWriting(sandbox, files([]), lcov(sandbox.root, true));
      expect(result.exitCode, result.output).toBe(1);
      expect(result.output).toContain(`${FILE}: 1 changed line(s) uncovered: ${LINE}`);
    } finally {
      sandbox.cleanup();
    }
  });

  test("a matching attestation passes the gate and prints the line as attested", async () => {
    const sandbox = await makePatchGateSandbox();
    try {
      const result = await gateAfterWriting(sandbox, files([entry()]), lcov(sandbox.root, true));
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain(`${FILE}:${LINE} attested (Bun 1.3.14 coverage defect)`);
      expect(result.output).toContain("1 attested line(s), listed above");
    } finally {
      sandbox.cleanup();
    }
  });

  test("a Bun pin change fails the gate on the stale entry by name", async () => {
    const sandbox = await makePatchGateSandbox();
    try {
      const result = await gateAfterWriting(sandbox, files([entry()], "1.4.2"), lcov(sandbox.root, true));
      expect(result.exitCode, result.output).toBe(1);
      expect(result.output).toContain(`stale attestation ${FILE}:${LINE}: proved on Bun 1.3.14, but .bun-version is 1.4.2`);
    } finally {
      sandbox.cleanup();
    }
  });

  test("a credited line fails the gate on the entry as no longer needed", async () => {
    const sandbox = await makePatchGateSandbox();
    try {
      const result = await gateAfterWriting(sandbox, files([entry()]), lcov(sandbox.root, false));
      expect(result.exitCode, result.output).toBe(1);
      expect(result.output).toContain(`attestation ${FILE}:${LINE} is no longer needed`);
    } finally {
      sandbox.cleanup();
    }
  });

  test("a malformed attestation file fails the gate closed", async () => {
    const sandbox = await makePatchGateSandbox();
    try {
      const result = await gateAfterWriting(
        sandbox,
        { ...files([]), [ATTESTATIONS_PATH]: JSON.stringify([{ ...entry(), exclude: true }]) },
        lcov(sandbox.root, true),
      );
      expect(result.exitCode, result.output).toBe(1);
      expect(result.output).toContain("Patch coverage gate ERROR (fail-closed)");
      expect(result.output).toContain("unknown field(s) exclude");
    } finally {
      sandbox.cleanup();
    }
  });
});
