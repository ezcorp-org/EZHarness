#!/usr/bin/env bun
/**
 * Capability-expiry sweep — manual CLI invocation.
 *
 * Phase 2 of the capability-expiry milestone (see
 * `tasks/capability-expiry-milestone.md` § Phase 2). Phase 3 will hook
 * the same {@link runSweep} call into a host-maintenance daemon that
 * runs hourly; for now an admin can drive it on demand.
 *
 * Usage:
 *   bun run scripts/sweep-perm-expiry.ts            # plan + apply
 *   bun run scripts/sweep-perm-expiry.ts --dry-run  # plan only, print summary
 *   bun run scripts/sweep-perm-expiry.ts --verbose  # log each revocation
 *
 * The script honors the same `DATABASE_URL` / PGlite fallback as the
 * server (`src/db/connection.ts` selects between them), so it operates
 * against whichever DB the server is currently using.
 *
 * Exit codes:
 *   0 — sweep ran (apply OR dry-run) without per-extension errors
 *   1 — at least one extension's apply step errored
 *   2 — invocation error (unknown flag, etc.)
 *
 * Output:
 *   - Summary JSON on stdout: `{swept: N, errors: [...]}`.
 *   - One JSON line per emitted event under `--verbose`: future
 *     tooling can pipe these into a notification channel.
 */

import { initDb, getDb } from "../src/db/connection";
import {
  runSweep,
  applySweepResult,
  type ExpiryEvent,
} from "../src/extensions/perm-expiry-sweep";

interface ParsedArgs {
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = { dryRun: false, verbose: false };
  for (const arg of argv) {
    if (arg === "--dry-run" || arg === "-n") out.dryRun = true;
    else if (arg === "--verbose" || arg === "-v") out.verbose = true;
    else if (arg === "--help" || arg === "-h") return { error: "help" };
    else return { error: `unknown flag: ${arg}` };
  }
  return out;
}

function printHelp(): void {
  console.log(
    [
      "Usage: bun run scripts/sweep-perm-expiry.ts [--dry-run] [--verbose]",
      "",
      "Run the capability-expiry sweep against the configured DB.",
      "",
      "Flags:",
      "  --dry-run, -n   Compute the plan and print it; do NOT apply.",
      "  --verbose, -v   Log each revocation as a JSON line on stderr.",
      "  --help, -h      Show this help.",
    ].join("\n"),
  );
}

function logEvent(event: ExpiryEvent): void {
  // JSON lines on stderr so stdout stays parseable as a single summary
  // doc. Future tooling can pipe stderr through `jq` or `grep -F`.
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    if (parsed.error === "help") {
      printHelp();
      return 0;
    }
    process.stderr.write(`error: ${parsed.error}\n\n`);
    printHelp();
    return 2;
  }
  const { dryRun, verbose } = parsed;

  await initDb();
  const db = getDb();
  const now = Date.now();

  const result = await runSweep({ db, now });

  if (verbose) {
    for (const event of result.events) logEvent(event);
  }

  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: true,
          swept: 0,
          plannedRevocations: result.revocations.length,
          plannedAudits: result.audits.length,
          plannedEvents: result.events.length,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const outcome = await applySweepResult(db, result, now);

  process.stdout.write(
    `${JSON.stringify(
      {
        swept: outcome.applied,
        audits: outcome.audits,
        skippedConcurrent: outcome.skippedConcurrent,
        errors: outcome.errors,
      },
      null,
      2,
    )}\n`,
  );

  return outcome.errors.length === 0 ? 0 : 1;
}

const code = await main();
process.exit(code);
