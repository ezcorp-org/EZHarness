#!/usr/bin/env bun
/**
 * Patch / diff coverage gate (Bun-native; no Python `diff-cover` dependency).
 *
 * Asserts that every NEW or CHANGED *executable* line in the PR (vs
 * origin/main) is covered. This is the pragmatic complement to the whole-repo
 * per-file gate: it catches an undertested change to an EXISTING file, which
 * the added-files-only new-file gate doesn't see.
 *
 * "Executable" = the line has a DA record in coverage/lcov.info. Added lines
 * with no DA record (comments, blanks, type-only, declarations) are ignored —
 * only executable added lines must be hit. A changed .ts SOURCE file that is
 * absent from lcov entirely FAILS (wave 3 — it used to be silently skipped);
 * .svelte files stay skip-on-absence (only explicitly vitest-included
 * components are line-measurable) and EXCLUDES entries are the reviewed
 * allowlist for everything else.
 *
 * Reuses the dependency-free unified-diff parser and the lcov parser from
 * coverage-config.ts (DRY). Pure helper exported for unit testing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeclarationOnlyTypeScript, isExcluded, isSourceFile, parseHitLines, parseLcov, REPO_ROOT } from "./coverage-config.ts";
import { gitOutput } from "./git-output.ts";
import { parseUnifiedDiff } from "./unified-diff.ts";

/**
 * Of the added lines, return those that are executable-but-uncovered: present
 * in `missedLines` (executable, 0 hits). Added lines in `hitLines` pass; added
 * lines in neither set are non-executable and ignored.
 */
export function uncoveredAddedLines(
  addedLines: Set<number>,
  hitLines: Set<number>,
  missedLines: Set<number>,
): number[] {
  const out: number[] = [];
  for (const ln of addedLines) {
    if (missedLines.has(ln) && !hitLines.has(ln)) out.push(ln);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Wave 3: should a changed source file with NO lcov data fail the gate?
 * True for .ts sources with at least one added line (a never-imported
 * module was edited — zero coverage on the change). False for .svelte
 * (only explicitly vitest-included components are line-measurable; the
 * Visual-evidence gate owns component rendering) and for pure-deletion
 * hunks. EXCLUDES is the reviewed allowlist and is applied by the caller
 * before this predicate.
 */
export function shouldFailOnLcovAbsence(file: string, addedLineCount: number, source?: string): boolean {
  return addedLineCount > 0 && !file.endsWith(".svelte") && !(file.endsWith(".ts") && source !== undefined && isDeclarationOnlyTypeScript(source));
}

/**
 * Source files git classified as BINARY in the diff.
 *
 * A binary diff emits `Binary files … differ` and NO `@@` hunks, so
 * `parseUnifiedDiff` never records the file and every per-file check below —
 * including {@link shouldFailOnLcovAbsence}, the net for "changed source with
 * no lcov data" — is silently skipped while the gate still reports PASSED.
 *
 * A single stray control character is enough to trigger it: one raw NUL in a
 * `.ts` source makes git call the whole file binary, hiding every added line
 * from this gate. That is indistinguishable from "no changes" here, which is
 * why it is checked explicitly rather than left to the hunk parser.
 *
 * Only the `b/` (new) side is matched, so a DELETED binary file — whose new
 * side is `/dev/null` — is correctly ignored; there are no added lines to
 * cover. Caller applies `isSourceFile`/`isExcluded`, same as the hunk path.
 */
export function binaryDiffFiles(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    const m = line.match(/^Binary files .* and b\/(.+) differ$/);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

// ── Coverage attestations (W03g) ───────────────────────────────────────────
//
// An attestation is NOT an exclusion. It names ONE executable line that runs
// under test but that the pinned Bun's coverage does not credit (a runtime
// defect, proved by probes), and it holds only while four recorded facts still
// match: the line number, the line's exact text, the SHA-256 of the whole file,
// and `.bun-version`. Any change to the line, anywhere else in the file, or to
// the Bun pin makes the entry stale, and a stale entry FAILS the gate by name.
// An entry whose line is credited again FAILS as no longer needed, so none can
// linger. Every accepted line is printed as attested; nothing is skipped
// silently. The file (scripts/coverage-attestations.json), this schema and this
// gate are guarded by gate-integrity rule 11 (the gate-change-approved label).

/** The file beside coverage-thresholds.json that holds the attestations. */
export const ATTESTATIONS_PATH = "scripts/coverage-attestations.json";

export interface CoverageAttestation {
  /** Repository-relative source path. */
  file: string;
  /** 1-based line number of the attested statement. */
  line: number;
  /** The line's exact text, indentation included. */
  text: string;
  /** SHA-256 (hex) of the whole file the entry was proved against. */
  fileSha256: string;
  /** The `.bun-version` the defect was proved on. */
  bunVersion: string;
  /** Why the line is uncredited although it runs. */
  reason: string;
  /** Where the proof lives: throw mutants, DA readings, probe receipts. */
  proof: string[];
}

const ATTESTATION_KEYS = ["file", "line", "text", "fileSha256", "bunVersion", "reason", "proof"] as const;

/** Parse and validate the attestation file. Any schema breach throws by name, so the gate fails closed. */
export function parseAttestations(json: string): CoverageAttestation[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error(`${ATTESTATIONS_PATH}: must be a JSON array of attestations`);
  const seen = new Set<string>();
  return data.map((raw, index) => {
    const where = `${ATTESTATIONS_PATH}[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${where}: must be an object`);
    const entry = raw as Record<string, unknown>;
    const unknownKeys = Object.keys(entry).filter((key) => !(ATTESTATION_KEYS as readonly string[]).includes(key));
    if (unknownKeys.length > 0) throw new Error(`${where}: unknown field(s) ${unknownKeys.join(", ")}`);
    const text = (key: string): string => {
      const value = entry[key];
      if (typeof value !== "string" || value.trim() === "") throw new Error(`${where}: "${key}" must be a non-empty string`);
      return value;
    };
    const line = entry.line;
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) throw new Error(`${where}: "line" must be a positive integer`);
    const fileSha256 = text("fileSha256");
    if (!/^[0-9a-f]{64}$/.test(fileSha256)) throw new Error(`${where}: "fileSha256" must be 64 lowercase hex characters`);
    const proof = entry.proof;
    if (!Array.isArray(proof) || proof.length === 0 || proof.some((p) => typeof p !== "string" || p.trim() === "")) {
      throw new Error(`${where}: "proof" must be a non-empty array of paths`);
    }
    const attestation: CoverageAttestation = {
      file: text("file"),
      line,
      text: text("text"),
      fileSha256,
      bunVersion: text("bunVersion"),
      reason: text("reason"),
      proof: proof as string[],
    };
    const key = `${attestation.file}:${attestation.line}`;
    if (seen.has(key)) throw new Error(`${where}: duplicate attestation for ${key}`);
    seen.add(key);
    return attestation;
  });
}

export function sha256Hex(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

export interface AttestationContext {
  /** The pinned Bun version (`.bun-version`, trimmed). */
  bunVersion: string;
  /** Added lines per changed file in this diff. */
  addedLines: ReadonlyMap<string, Set<number>>;
  /** The current content of a file, or undefined when it does not exist. */
  source: (file: string) => string | undefined;
  /** lcov lines with hits > 0 / with hits == 0, per file. */
  hitLines: (file: string) => Set<number>;
  missedLines: (file: string) => Set<number>;
}

export interface AttestationVerdict {
  /** Lines accepted as attested, per file. */
  attested: Map<string, Set<number>>;
  /** One line per accepted attestation, for the gate output. */
  attestedReport: string[];
  /** Stale or no-longer-needed entries; each fails the gate. */
  findings: string[];
  /** Entries this diff does not reach (file or line not changed here). */
  inactive: string[];
}

/**
 * Decide every attestation against this run. The Bun pin is checked on EVERY
 * run, so a pin change stales every entry at once; the file facts are checked
 * whenever the file is in the diff, because only then can its lines reach this gate.
 */
export function evaluateAttestations(entries: readonly CoverageAttestation[], ctx: AttestationContext): AttestationVerdict {
  const verdict: AttestationVerdict = { attested: new Map(), attestedReport: [], findings: [], inactive: [] };
  for (const entry of entries) {
    const at = `${entry.file}:${entry.line}`;
    if (entry.bunVersion !== ctx.bunVersion) {
      verdict.findings.push(
        `stale attestation ${at}: proved on Bun ${entry.bunVersion}, but .bun-version is ${ctx.bunVersion} — ` +
          `re-prove the line on ${ctx.bunVersion} or remove the entry from ${ATTESTATIONS_PATH}`,
      );
      continue;
    }
    const added = ctx.addedLines.get(entry.file);
    if (!added) {
      verdict.inactive.push(`${at} (file not changed in this diff)`);
      continue;
    }
    const source = ctx.source(entry.file);
    if (source === undefined) {
      verdict.findings.push(`stale attestation ${at}: the file no longer exists — remove the entry from ${ATTESTATIONS_PATH}`);
      continue;
    }
    if (sha256Hex(source) !== entry.fileSha256) {
      verdict.findings.push(
        `stale attestation ${at}: the file changed since it was proved (SHA-256 differs) — ` +
          `re-prove the line and record the new hash, or remove the entry`,
      );
      continue;
    }
    if (source.split("\n")[entry.line - 1] !== entry.text) {
      verdict.findings.push(`stale attestation ${at}: the line's text differs from the recorded text — re-prove the line or remove the entry`);
      continue;
    }
    if (!added.has(entry.line)) {
      verdict.inactive.push(`${at} (line not changed in this diff)`);
      continue;
    }
    if (!ctx.missedLines(entry.file).has(entry.line) || ctx.hitLines(entry.file).has(entry.line)) {
      verdict.findings.push(
        `attestation ${at} is no longer needed: coverage now credits the line (or records no uncovered hit for it) — ` +
          `remove the entry from ${ATTESTATIONS_PATH}`,
      );
      continue;
    }
    const lines = verdict.attested.get(entry.file) ?? new Set<number>();
    lines.add(entry.line);
    verdict.attested.set(entry.file, lines);
    verdict.attestedReport.push(`${at} attested (Bun ${entry.bunVersion} coverage defect): ${entry.reason} Proof: ${entry.proof.join(", ")}`);
  }
  return verdict;
}

/** Read the attestation file and the pin. No file means no attestations; the pin is read only when there are entries. */
async function loadAttestations(): Promise<{ entries: CoverageAttestation[]; bunVersion: string }> {
  const json = await Bun.file(resolve(REPO_ROOT, ATTESTATIONS_PATH))
    .text()
    .catch(() => "[]");
  const entries = parseAttestations(json);
  if (entries.length === 0) return { entries, bunVersion: "" };
  const bunVersion = (await Bun.file(resolve(REPO_ROOT, ".bun-version")).text()).trim();
  return { entries, bunVersion };
}

async function main(): Promise<void> {
  const base = process.env.BASE_REF || "origin/main";
  const diff = await gitOutput(REPO_ROOT, ["diff", "--unified=0", `${base}...HEAD`, "--", "*.ts", "*.svelte"]);
  const perFileDiff = parseUnifiedDiff(diff);

  const lcovText = await Bun.file(resolve(REPO_ROOT, "coverage/lcov.info"))
    .text()
    .catch(() => "");
  const cov = parseLcov(lcovText);
  const hits = parseHitLines(lcovText);

  const { entries, bunVersion } = await loadAttestations();
  const attestations = evaluateAttestations(entries, {
    bunVersion,
    addedLines: new Map([...perFileDiff].map(([file, info]) => [file, info.addedLines])),
    source: (file) => {
      try {
        return readFileSync(resolve(REPO_ROOT, file), "utf8");
      } catch {
        return undefined;
      }
    },
    hitLines: (file) => hits.get(file) ?? new Set<number>(),
    missedLines: (file) => new Set(cov.get(file)?.missed ?? []),
  });

  const violations: string[] = [...attestations.findings];
  let checkedFiles = 0;

  // Binary-classified sources contribute no hunks, so they would slip past the
  // whole loop below unmeasured. Fail loudly instead — see binaryDiffFiles.
  for (const file of binaryDiffFiles(diff)) {
    if (!isSourceFile(file) || isExcluded(file)) continue;
    violations.push(
      `${file}: git classified this SOURCE file as BINARY, so it contributes no diff ` +
        `hunks and every patch-coverage check on it is skipped. Usually one stray ` +
        `control character (e.g. a raw NUL) — replace it with its source escape ` +
        `("\\0"), then re-run.`,
    );
  }

  for (const [file, info] of perFileDiff) {
    if (!isSourceFile(file) || isExcluded(file)) continue;
    const fileCov = cov.get(file);
    if (!fileCov) {
      // Wave 3: absence from lcov FAILS for changed .ts sources — see
      // shouldFailOnLcovAbsence. (EXCLUDES already `continue`d above.)
      const source = file.endsWith(".ts") ? await Bun.file(resolve(REPO_ROOT, file)).text().catch(() => undefined) : undefined;
      if (shouldFailOnLcovAbsence(file, info.addedLines.size, source)) {
        violations.push(
          `${file}: changed source file has NO lcov data — no test loads it under coverage. ` +
            `Add/extend a test that exercises it (or, if it genuinely can't be measured, ` +
            `add an EXCLUDES entry in scripts/coverage-config.ts with justification).`,
        );
      }
      continue;
    }
    checkedFiles++;
    const missedSet = new Set(fileCov.missed);
    const hitSet = hits.get(file) ?? new Set<number>();
    const attested = attestations.attested.get(file);
    const uncovered = uncoveredAddedLines(info.addedLines, hitSet, missedSet).filter((line) => !attested?.has(line));
    if (uncovered.length > 0) {
      const shown = uncovered.slice(0, 40).join(",") + (uncovered.length > 40 ? ",..." : "");
      violations.push(`${file}: ${uncovered.length} changed line(s) uncovered: ${shown}`);
    }
  }

  for (const line of attestations.attestedReport) console.log(`  ${line}`);
  for (const line of attestations.inactive) console.log(`  attestation inactive: ${line}`);
  if (violations.length === 0) {
    const attestedCount = attestations.attestedReport.length;
    const attestedNote = attestedCount === 0 ? "" : `; ${attestedCount} attested line(s), listed above`;
    console.log(`Patch coverage gate PASSED: all changed executable lines covered (${checkedFiles} file(s))${attestedNote}.`);
    return;
  }
  console.error(`Patch coverage gate FAILED (${violations.length} file(s) with uncovered changes):`);
  for (const v of violations) console.error(`  ${v}`);
  console.error("\nAdd tests covering the changed lines above, then re-run the coverage pipeline.");
  process.exit(1);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error(
      `Patch coverage gate ERROR (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
