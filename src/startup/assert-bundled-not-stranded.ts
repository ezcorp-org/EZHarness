/**
 * Startup health signal — report every bundled extension left DISABLED
 * after `ensureBundledExtensions()`.
 *
 * The gap this closes: a non-critical bundled extension caught by the S9
 * re-approval gate (or the manifest-tamper gate) is disabled and stays
 * disabled on every subsequent boot — the disable exit `continue`s before
 * both the manifest refresh and the re-enable branch, so the stored
 * manifest can never converge on disk. The only exit is an admin calling
 * `POST /api/extensions/[id]/reapprove-drift`.
 *
 * Until now that state announced itself as ONE `info` line per extension
 * per boot ("still drifted — already disabled pending re-approval"),
 * buried in a very noisy startup log. `web-search` sat like that for days
 * on the live host: its `search-web` / `read-url` tools registered
 * nowhere, so web search silently did not work for ANY agent, and nothing
 * in the logs, the UI, or CI said so at a glance.
 *
 * `assertCriticalExtensions` already covers the three `critical` entries
 * (ERROR + one-time within-ceiling remediation). This is the same idea
 * widened to the rest of the catalog, with one deliberate difference:
 *
 *   **It reports, it does not remediate.** A non-critical S9 disable is a
 *   fail-closed security decision awaiting human consent — auto-enabling
 *   would defeat the gate. The loud line is the product; the operator
 *   decides.
 *
 * The check is STATELESS: it needs no bookkeeping from the boot loop
 * because "bundled + still disabled" is already an exact signal. The
 * normal (no-gate) path unconditionally re-enables a disabled bundled
 * row, and `resolveBundledExtensions()` filters out entries an operator
 * opted out of via env — so anything still `enabled=false` here was left
 * that way by a gate, never by choice.
 *
 * Never throws: a lookup failure is logged and folded into the result so
 * startup stays non-fatal.
 */

import { resolveBundledExtensions } from "../extensions/bundled";
import { getExtensionByName } from "../db/queries/extensions";
import { logger } from "../logger";

const log = logger.child("startup/assert-bundled-not-stranded");

export interface StrandedBundledResult {
  /** Bundled names checked (post env opt-out filtering). */
  checked: string[];
  /** Installed but `enabled=false` — pending admin re-approval. */
  stranded: string[];
  /** No row at all — install failed earlier (that path logged already). */
  missing: string[];
  /** Lookup threw; state unknown. */
  unknown: string[];
}

/**
 * Report bundled extensions stranded in the disabled-pending-re-approval
 * state. Call AFTER `ensureBundledExtensions()` (and after
 * `assertCriticalExtensions()`, so a remediated critical is already
 * enabled and isn't double-reported).
 */
export async function assertBundledNotStranded(): Promise<StrandedBundledResult> {
  const entries = resolveBundledExtensions();
  const result: StrandedBundledResult = {
    checked: entries.map((e) => e.name),
    stranded: [],
    missing: [],
    unknown: [],
  };

  for (const entry of entries) {
    let row;
    try {
      row = await getExtensionByName(entry.name);
    } catch (e) {
      log.warn("bundled extension lookup failed — cannot check stranded state", {
        name: entry.name,
        error: String(e),
      });
      result.unknown.push(entry.name);
      continue;
    }
    if (!row) {
      result.missing.push(entry.name);
      continue;
    }
    if (row.enabled === false) result.stranded.push(entry.name);
  }

  // ONE aggregate line, not one per extension — the per-extension `info`
  // lines already exist and were exactly the thing nobody read.
  if (result.stranded.length > 0) {
    log.warn(
      `${result.stranded.length} bundled extension(s) DISABLED pending admin re-approval — ` +
        `their tools are registered nowhere, so no agent can call them. ` +
        `Re-approve from Settings → Extensions, or POST /api/extensions/<id>/reapprove-drift. ` +
        `If this list is unexpected, suspect a PHANTOM drift (see NON_SEMANTIC_TOOL_FIELDS ` +
        `in src/extensions/bundled-lock.ts).`,
      { stranded: result.stranded },
    );
  }

  return result;
}
