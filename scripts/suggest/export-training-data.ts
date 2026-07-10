#!/usr/bin/env bun
/**
 * Export composer-suggestion training data (prompt → tool-call pairs) as
 * chat-format JSONL for LoRA fine-tuning.
 *
 *   bun scripts/suggest/export-training-data.ts [--days 365] [--out path]
 *
 * Reads the same database as the app (DATABASE_URL or the embedded PGlite —
 * stop the dev server first on PGlite deploys). Output defaults to
 * .ezcorp/suggest-training/dataset.jsonl (gitignored). Next steps — LoRA
 * fine-tune runbook: docs/features/composer/suggestions.md.
 */
import { initDb, closeDb } from "../../src/db/connection";
import { buildTrainingExamples, collectPromptToolRows, toJsonl } from "../../src/suggest/training-export";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const days = Number(argValue("--days") ?? "365");
const out = argValue("--out") ?? ".ezcorp/suggest-training/dataset.jsonl";

await initDb();
try {
  const rows = await collectPromptToolRows(Number.isFinite(days) && days > 0 ? days : 365);
  const examples = buildTrainingExamples(rows);
  await Bun.write(out, toJsonl(examples));
  console.log(`Exported ${examples.length} training example(s) from ${rows.length} prompt→tool pair(s) → ${out}`);
  if (examples.length < 100) {
    console.log(
      "Note: LoRA fine-tunes on this task start paying off around a few hundred clean examples — keep using tools and re-export later.",
    );
  }
  console.log("Fine-tune runbook: docs/features/composer/suggestions.md");
} finally {
  await closeDb();
}
