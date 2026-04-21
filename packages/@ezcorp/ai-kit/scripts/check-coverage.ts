#!/usr/bin/env bun
/** Parses coverage/lcov.info (Bun's lcov dialect) and fails if line or function
 *  coverage on our package's src/** drops below the threshold.
 *
 *  Bun emits `DA:<line>,<hits>` per executable line and `FNF`/`FNH` summary
 *  counters; it does not emit `LF`/`LH` or branch counters. We compute line
 *  coverage from `DA` entries.
 *
 *  Scope: paths in lcov are relative to the cwd where `bun test` ran
 *  (this package's root). We gate only our own source files — excluding
 *  shebang entry (`src/cli/index.ts`) and the `import.meta.main` launcher
 *  (`src/mcp/server.ts` bottom branch) since they're covered by integration
 *  tests the lcov attributes can't reach. */

import { readFileSync } from "node:fs";

/** Threshold of 96% accommodates five defensive `catch` branches that can't
 *  be reliably triggered without fragile mocks: dynamic-import failures in
 *  `src/cli/doctor.ts` (lines 47, 95-96), the non-abort error re-throw in
 *  `src/mcp/tools/chat.ts` (line 102), and the missing-skills-dir fallback in
 *  `src/cli/install.ts` (line 99). Every happy-path + expected-error branch
 *  is covered at 100%. Override via AI_KIT_COVERAGE_THRESHOLD. */
const THRESHOLD = Number(process.env.AI_KIT_COVERAGE_THRESHOLD ?? 96);
const INCLUDE = /^(src\/|ezcorp\.config\.ts$)/;
const EXCLUDE = [/^src\/cli\/index\.ts$/, /^src\/mcp\/server\.ts$/];

const file = process.argv[2] ?? "coverage/lcov.info";
let raw: string;
try {
  raw = readFileSync(file, "utf8");
} catch {
  console.error(`check-coverage: missing ${file}. Run \`bun run test:coverage\` first.`);
  process.exit(2);
}

interface FileCov {
  path: string;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
}

const files: FileCov[] = [];
let cur: Partial<FileCov> & { linesFound: number; linesHit: number } = {
  linesFound: 0,
  linesHit: 0,
};
for (const line of raw.split("\n")) {
  if (line.startsWith("SF:")) {
    cur = { path: line.slice(3), linesFound: 0, linesHit: 0 };
  } else if (line.startsWith("DA:")) {
    const hits = Number(line.split(",")[1] ?? "0");
    cur.linesFound = (cur.linesFound ?? 0) + 1;
    if (hits > 0) cur.linesHit = (cur.linesHit ?? 0) + 1;
  } else if (line.startsWith("FNF:")) cur.functionsFound = Number(line.slice(4));
  else if (line.startsWith("FNH:")) cur.functionsHit = Number(line.slice(4));
  else if (line === "end_of_record" && cur.path) {
    files.push(cur as FileCov);
    cur = { linesFound: 0, linesHit: 0 };
  }
}

const offenders: string[] = [];
const included: FileCov[] = [];
for (const f of files) {
  if (!INCLUDE.test(f.path)) continue;
  if (EXCLUDE.some((r) => r.test(f.path))) continue;
  included.push(f);
  const lp = f.linesFound ? (100 * f.linesHit) / f.linesFound : 100;
  const fp = f.functionsFound ? (100 * f.functionsHit) / f.functionsFound : 100;
  if (lp < THRESHOLD || fp < THRESHOLD) {
    offenders.push(
      `  ${f.path} — lines ${lp.toFixed(2)}% (${f.linesHit}/${f.linesFound}) · funcs ${fp.toFixed(
        2,
      )}% (${f.functionsHit}/${f.functionsFound})`,
    );
  }
}

if (offenders.length > 0) {
  console.error(`coverage gate failed (threshold ${THRESHOLD}%):`);
  for (const o of offenders) console.error(o);
  process.exit(1);
}
console.log(`coverage gate passed (${included.length} files, threshold ${THRESHOLD}%).`);
