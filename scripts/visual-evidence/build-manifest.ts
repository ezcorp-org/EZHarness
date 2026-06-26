#!/usr/bin/env bun
/**
 * Visual-evidence MANIFEST BUILDER — runs in WF1 (`ci.yml`'s "Visual evidence"
 * job), the TRUSTED tier (it executes on the base-repo runner against the PR's
 * checked-out code, but it only ever reads Playwright's own output bytes — never
 * the PR source — and it sanitizes every string it emits).
 *
 * It parses the Playwright `blob` report produced by the soft-capture lane
 * (`bunx playwright test --grep @evidence` with `EZCORP_E2E_EVIDENCE=1`) and:
 *   1. decodes every `image/png` attachment that was inlined as base64 via
 *      `testInfo.attach(label, { body, contentType: "image/png" })`,
 *   2. writes each PNG to a flat `extracted/` dir under the blob-report root,
 *   3. emits `manifest.json` shaped
 *        { pr:<int>, headSha:<string>, runId:<int>,
 *          shots:[{ spec:<string>, label:<string>, file:<string> }] }
 *      with every `spec`/`label` sanitized to the safe charset
 *      `[A-Za-z0-9._\-/ ]`.
 *
 * The downstream privileged publisher (`publish.ts`, WF2) treats BOTH the
 * manifest and the extracted PNG bytes as untrusted and re-validates them, so
 * this builder is purely a convenience extractor — it is never the trust
 * boundary. Keeping the parse/sanitize logic here pure + exported lets the unit
 * tests exercise it without a real Playwright run.
 *
 * Playwright blob protocol (source-verified, 1.5x–1.6x TeleReporter family):
 *   - `report.jsonl` is newline-delimited `{ method, params }` messages.
 *   - `onProject.params.suites[]` is a recursive suite tree; leaf `entries[]`
 *     are tests `{ testId, title, location:{ file } }` (file rootDir-relative).
 *   - Attachments ride on `onAttach.params.attachments[]` (joined to the test
 *     via `onAttach.params.testId`); old emitters also nest them under
 *     `onTestEnd.params.result.attachments` — we read BOTH defensively.
 *   - An in-memory `attach({body})` lands as `{ name, contentType, base64 }`
 *     (no `path`); we only consume the `base64` form.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** A single extracted screenshot, referenced by a repo-relative `file`. */
export interface Shot {
  spec: string;
  label: string;
  file: string;
}

/** The trusted manifest uploaded alongside the extracted PNGs. */
export interface Manifest {
  pr: number;
  headSha: string;
  runId: number;
  shots: Shot[];
}

/** Raw (pre-write) shot: the decoded bytes plus its sanitized identity. */
export interface DecodedShot {
  spec: string;
  label: string;
  bytes: Uint8Array;
}

/**
 * Reduce an arbitrary string to the public-safe charset `[A-Za-z0-9._\-/ ]`.
 * Every other code unit (including `[]()<>` backticks, newlines, path
 * separators other than `/`, and shell metacharacters) is dropped. Collapses
 * runs of whitespace and trims. Empty input → "evidence".
 *
 * `/` is permitted because `spec` is a path-like value (`web/e2e/x.spec.ts`);
 * `isSafeRelPath` (publish.ts) still independently rejects `..`/absolute paths.
 */
export function sanitize(s: string): string {
  const cleaned = String(s ?? "")
    .replace(/[^A-Za-z0-9._\-/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : "evidence";
}

/** PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A — we check the first four. */
export function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

interface JsonlAttachment {
  name?: unknown;
  contentType?: unknown;
  base64?: unknown;
  path?: unknown;
}

/**
 * Walk a Playwright `onProject` suite tree and collect every test's
 * `testId -> spec file path` mapping. File suites are titled by their
 * rootDir-relative path; we prefer the leaf test's `location.file`.
 */
function collectTestSpecs(suites: unknown, into: Map<string, string>): void {
  if (!Array.isArray(suites)) return;
  for (const suite of suites) {
    if (!suite || typeof suite !== "object") continue;
    const s = suite as Record<string, unknown>;
    const entries = s.entries;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        // A leaf TEST entry has a testId + (usually) a location.file.
        if (typeof e.testId === "string") {
          const loc = e.location as Record<string, unknown> | undefined;
          const file =
            (loc && typeof loc.file === "string" && loc.file) ||
            (typeof s.title === "string" ? s.title : "") ||
            "";
          into.set(e.testId, file);
        } else {
          // Nested sub-suite — recurse through this same `entries` shape.
          collectTestSpecs([entry], into);
        }
      }
    }
    if (Array.isArray(s.suites)) collectTestSpecs(s.suites, into);
  }
}

/**
 * Parse a Playwright blob `report.jsonl` into decoded PNG shots.
 *
 * PURE: no filesystem, no subprocess. Returns one `DecodedShot` per inline
 * `image/png` attachment (base64 form only), with `spec`/`label` sanitized and
 * non-PNG / malformed entries dropped. Lines that don't parse as JSON are
 * skipped (a partial/truncated blob never throws).
 */
export function parseReportJsonl(jsonl: string): DecodedShot[] {
  const testSpec = new Map<string, string>();
  // attachments seen before their onProject mapping arrives are buffered with
  // a best-effort spec ("") and reconciled after the full pass.
  const pending: { testId: string; label: string; bytes: Uint8Array }[] = [];

  const consumeAttachments = (testId: string, atts: unknown): void => {
    if (!Array.isArray(atts)) return;
    for (const att of atts as JsonlAttachment[]) {
      if (!att || typeof att !== "object") continue;
      if (att.contentType !== "image/png") continue;
      if (typeof att.base64 !== "string" || att.base64.length === 0) continue;
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(Buffer.from(att.base64, "base64"));
      } catch {
        continue;
      }
      if (!isPng(bytes)) continue;
      const label = typeof att.name === "string" ? att.name : "evidence";
      pending.push({ testId, label, bytes });
    }
  };

  for (const rawLine of jsonl.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let msg: { method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const params = (msg.params ?? {}) as Record<string, unknown>;
    switch (msg.method) {
      case "onProject": {
        // Playwright 1.5x emits the suite tree under `params.project.suites`;
        // older TeleReporter variants put it at `params.suites`. Read both so
        // the testId -> spec-file join works across emitter versions (without
        // it, every shot's `spec` falls back to the generic "evidence").
        const proj = params.project as Record<string, unknown> | undefined;
        collectTestSpecs(proj?.suites ?? params.suites, testSpec);
        break;
      }
      case "onAttach":
        if (typeof params.testId === "string") {
          consumeAttachments(params.testId, params.attachments);
        }
        break;
      case "onTestEnd": {
        // Old emitters nest attachments under params.result.attachments.
        const test = params.test as Record<string, unknown> | undefined;
        const result = params.result as Record<string, unknown> | undefined;
        const testId =
          (test && typeof test.testId === "string" && test.testId) ||
          (result && typeof result.id === "string" && result.id) ||
          "";
        if (testId && result) consumeAttachments(testId, result.attachments);
        break;
      }
      default:
        break;
    }
  }

  return pending.map(({ testId, label, bytes }) => ({
    spec: sanitize(testSpec.get(testId) ?? "evidence"),
    label: sanitize(label),
    bytes,
  }));
}

/**
 * Find every `report.jsonl` reachable from a blob-report root: a directly
 * unpacked `report.jsonl`, and the contents of any `report-*.zip` shards
 * (Playwright writes one zip per shard). Returns the decoded jsonl strings.
 *
 * Uses the host `unzip` (present on GitHub runners) to read zip entries without
 * adding a zip dependency. A missing/empty dir yields `[]` (fail-soft).
 */
async function readBlobReports(blobDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(blobDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = join(blobDir, name);
    if (name === "report.jsonl") {
      out.push(await Bun.file(full).text().catch(() => ""));
    } else if (name.endsWith(".zip")) {
      // `unzip -p` streams the inner report.jsonl to stdout.
      const proc = Bun.spawn(["unzip", "-p", full, "report.jsonl"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (text) out.push(text);
    }
  }
  return out.filter(Boolean);
}

/** Parse an env var as a non-negative integer, defaulting to 0 on garbage. */
function intEnv(name: string): number {
  const raw = process.env[name];
  if (typeof raw === "string" && /^[0-9]+$/.test(raw.trim())) return Number(raw.trim());
  return 0;
}

async function main(): Promise<void> {
  const blobDir = process.env.EVIDENCE_BLOB_DIR
    ? resolve(process.env.EVIDENCE_BLOB_DIR)
    : resolve(REPO_ROOT, "web", "blob-report");
  const outManifest = process.env.EVIDENCE_MANIFEST
    ? resolve(process.env.EVIDENCE_MANIFEST)
    : resolve(REPO_ROOT, "manifest.json");
  const extractedDir = join(blobDir, "extracted");

  const pr = intEnv("PR_NUMBER");
  const headSha = sanitize(process.env.HEAD_SHA ?? "");
  const runId = intEnv("RUN_ID");

  const reports = await readBlobReports(blobDir);
  const decoded = reports.flatMap(parseReportJsonl);

  const shots: Shot[] = [];
  if (decoded.length > 0) {
    await rm(extractedDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(extractedDir, { recursive: true });
  }
  // De-dupe identical spec/label pairs by suffixing a counter so two shots in
  // one test don't collide on disk.
  const seen = new Map<string, number>();
  for (const shot of decoded) {
    const key = `${shot.spec}/${shot.label}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const labelOnDisk = n === 1 ? shot.label : `${shot.label}-${n}`;
    // Flat, sanitized on-disk name; `/` in spec → `__` so it stays one segment.
    const fileName = `${shot.spec}__${labelOnDisk}.png`.replace(/\//g, "__");
    const rel = join("extracted", fileName);
    const abs = join(blobDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await Bun.write(abs, shot.bytes);
    shots.push({ spec: shot.spec, label: labelOnDisk, file: rel });
  }

  const manifest: Manifest = { pr, headSha, runId, shots };
  await Bun.write(outManifest, JSON.stringify(manifest, null, 2));
  console.log(
    `Visual-evidence manifest: ${shots.length} shot(s) from ${reports.length} report(s) → ${outManifest}`,
  );
}

if (import.meta.main) {
  await main();
}
