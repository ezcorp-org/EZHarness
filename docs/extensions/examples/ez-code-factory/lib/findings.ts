// ── Findings algorithms — ported from types/findings.go + pipeline/findings.go
//
// The Finding / Findings TYPES live in runs.ts (the M0 fail-closed contract);
// this module adds the manipulation algorithms the executor and steps consume.
// It never forks a second findings type — everything operates on the M0
// deserialized shape and re-serializes via serializeFindings.
//
// Two layers:
//   - object helpers (hasBlockingFindings, autoFixableFindings, filterFindings,
//     mergeUserOverrides, …) — pure ports of types/findings.go
//   - JSON-string wrappers (…JSON) — the shape the executor threads between
//     steps and persists, pure ports of internal/pipeline/findings.go
//
// Because runs.ts deserialization already fail-closes a missing action to
// ask-user, the object helpers see only valid actions. The sole exception is
// mergeUserOverrides, which — matching upstream — treats a USER-authored added
// finding with no action as auto-fix (a user hand-adding a finding is asking
// for a fix), and is the one place a raw empty action is interpreted.

import {
  deserializeFindings,
  serializeFindings,
  type Finding,
  type Findings,
} from "./runs";

const VALID_SEVERITIES = new Set(["error", "warning", "info"]);
const VALID_ACTIONS = new Set(["no-op", "auto-fix", "ask-user"]);

/** deserializeFindings over a JSON string; malformed/empty → empty Findings. */
function parseFindings(raw: string): Findings {
  if (raw === "") return deserializeFindings({});
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return deserializeFindings(parsed);
}

/** Shallow clone a Findings, replacing its items list. Preserves the summary +
 *  risk/testing metadata the item-filtering helpers must carry through. */
function withItems(f: Findings, items: Finding[]): Findings {
  return { ...f, items };
}

// ── Predicates (types/findings.go) ──────────────────────────────────

/** True if any finding is error or warning severity. Verbatim hasBlockingFindings. */
export function hasBlockingFindings(items: Finding[]): boolean {
  return items.some((f) => f.severity === "error" || f.severity === "warning");
}

/** True if any finding's action is ask-user (always blocks). Verbatim HasAskUserFindings. */
export function hasAskUserFindings(f: Findings): boolean {
  return f.items.some((it) => it.action === "ask-user");
}

// ── Selection + normalization (types/findings.go) ───────────────────

/** Assign deterministic `prefix-N` ids to findings lacking one. Verbatim NormalizeFindings. */
export function normalizeFindings(f: Findings, prefix: string): Findings {
  const items = f.items.map((it, i) => (it.id !== "" ? it : { ...it, id: `${prefix}-${i + 1}` }));
  return withItems(f, items);
}

/** Keep only items whose action is auto-fix. Verbatim AutoFixableFindings. */
export function autoFixableFindings(f: Findings): Findings {
  return withItems(
    f,
    f.items.filter((it) => it.action === "auto-fix"),
  );
}

/** Keep only findings whose ids are in `ids`; rewrite summary when the set
 *  shrank. Empty `ids` returns the input unchanged. Verbatim FilterFindings. */
export function filterFindings(f: Findings, ids: string[]): Findings {
  if (ids.length === 0) return f;
  const selected = new Set(ids);
  const items = f.items.filter((it) => selected.has(it.id));
  const out = withItems(f, items);
  if (items.length !== f.items.length) out.summary = summarizeSelectedFindings(items.length);
  return out;
}

/** English count phrase for a selected-findings summary. Verbatim summarizeSelectedFindings. */
export function summarizeSelectedFindings(count: number): string {
  if (count === 0) return "0 selected findings";
  if (count === 1) return "1 selected finding";
  return `${count} selected findings`;
}

/** True when `summary` is a machine-generated "N selected findings" phrase.
 *  Verbatim isSelectedFindingsSummary. */
export function isSelectedFindingsSummary(summary: string): boolean {
  if (summary === "0 selected findings" || summary === "1 selected finding") return true;
  if (!summary.endsWith(" selected findings")) return false;
  const count = summary.slice(0, -" selected findings".length);
  if (count === "") return false;
  return /^[0-9]+$/.test(count);
}

function nextUserFindingID(used: Set<string>, counter: number): [string, number] {
  let c = counter;
  let candidate = `user-${++c}`;
  while (used.has(candidate)) {
    candidate = `user-${++c}`;
  }
  used.add(candidate);
  return [candidate, c];
}

/** A user-authored added finding from the respond payload. Action may be blank
 *  (→ auto-fix); source is forced to "user". */
export interface AddedFinding {
  id?: string;
  severity?: string;
  file?: string;
  line?: number | null;
  description?: string;
  action?: string;
  category?: string;
}

/** Coerce a raw payload object into an AddedFinding, keeping a blank action
 *  blank (MergeUserOverrides defaults it to auto-fix). Unknown severity → error;
 *  unknown-but-nonblank action → ask-user (fail closed, like the M0 contract). */
function coerceAddedFinding(raw: unknown): AddedFinding {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  const rawAction = s(o.action).trim();
  const action = rawAction === "" ? "" : VALID_ACTIONS.has(rawAction) ? rawAction : "ask-user";
  const rawSeverity = s(o.severity).trim();
  const severity = VALID_SEVERITIES.has(rawSeverity) ? rawSeverity : "error";
  return {
    id: s(o.id),
    severity,
    file: s(o.file),
    line: typeof o.line === "number" && Number.isFinite(o.line) ? o.line : null,
    description: s(o.description),
    action,
    category: s(o.category),
  };
}

/**
 * Apply per-finding user instructions to existing agent findings and append
 * user-authored findings (source=user, blank action→auto-fix, deterministic
 * user-N ids). The input is not mutated. Verbatim MergeUserOverrides.
 */
export function mergeUserOverrides(
  f: Findings,
  instructions: Record<string, string>,
  added: AddedFinding[],
): Findings {
  const items: Finding[] = f.items.map((it) =>
    it.id !== "" && it.id in instructions ? { ...it, userInstructions: instructions[it.id]! } : it,
  );
  const used = new Set<string>();
  for (const it of items) if (it.id !== "") used.add(it.id);
  let counter = 0;
  let appended = false;
  for (const raw of added) {
    const finding: Finding = {
      id: raw.id ?? "",
      severity: (VALID_SEVERITIES.has(raw.severity ?? "") ? raw.severity : "error") as Finding["severity"],
      file: raw.file ?? "",
      line: raw.line ?? null,
      description: raw.description ?? "",
      action: (raw.action && raw.action !== "" ? raw.action : "auto-fix") as Finding["action"],
      source: "user",
      userInstructions: "",
      category: raw.category ?? "",
    };
    if (finding.id === "" || used.has(finding.id)) {
      const [id, next] = nextUserFindingID(used, counter);
      finding.id = id;
      counter = next;
    } else {
      used.add(finding.id);
    }
    items.push(finding);
    appended = true;
  }
  const out = withItems(f, items);
  if (appended && isSelectedFindingsSummary(out.summary)) {
    out.summary = summarizeSelectedFindings(items.length);
  }
  return out;
}

// ── JSON-string wrappers (internal/pipeline/findings.go) ────────────

/** Normalize ids on a findings JSON payload (empty → ""). Verbatim normalizeFindingsJSON. */
export function normalizeFindingsJSON(raw: string, prefix: string): string {
  if (raw === "") return "";
  return serializeFindings(normalizeFindings(parseFindings(raw), prefix));
}

/** JSON payload of only the auto-fixable findings, or "" when none. Verbatim autoFixableFindingsJSON. */
export function autoFixableFindingsJSON(raw: string): string {
  if (raw === "") return "";
  const fixable = autoFixableFindings(parseFindings(raw));
  if (fixable.items.length === 0) return "";
  return serializeFindings(fixable);
}

/** True if the payload carries any ask-user finding. Verbatim hasAskUserFindingsJSON. */
export function hasAskUserFindingsJSON(raw: string): boolean {
  if (raw === "") return false;
  return hasAskUserFindings(parseFindings(raw));
}

/**
 * Filter a findings JSON payload to the selected ids. An EMPTY id set yields the
 * "0 selected findings" empty set (the user selected nothing) — note this
 * differs from the object-level filterFindings, matching filterFindingsJSON.
 */
export function filterFindingsJSON(raw: string, ids: string[]): string {
  if (raw === "") return raw;
  const findings = parseFindings(raw);
  if (ids.length === 0) {
    return serializeFindings({
      items: [],
      summary: "0 selected findings",
      tested: findings.tested,
      testingSummary: findings.testingSummary,
      artifacts: findings.artifacts,
      riskLevel: findings.riskLevel,
      riskRationale: findings.riskRationale,
    });
  }
  return serializeFindings(filterFindings(findings, ids));
}

/** Apply user instructions + added findings to a JSON payload. No overrides →
 *  input unchanged. Verbatim mergeUserOverridesJSON. */
export function mergeUserOverridesJSON(
  raw: string,
  instructions: Record<string, string>,
  added: unknown[],
): string {
  if (Object.keys(instructions).length === 0 && added.length === 0) return raw;
  const base = parseFindings(raw);
  const merged = mergeUserOverrides(base, instructions, added.map(coerceAddedFinding));
  return serializeFindings(merged);
}

/** JSON array string of the finding ids in a payload, or "" when none. Verbatim findingIDsJSON. */
export function findingIDsJSON(raw: string): string {
  if (raw === "") return "";
  const ids = parseFindings(raw)
    .items.map((it) => it.id)
    .filter((id) => id !== "");
  return marshalFindingIDs(ids);
}

/** JSON array of ids, or "" for an empty list (so a DB column stays NULL). Verbatim marshalFindingIDs. */
export function marshalFindingIDs(ids: string[]): string {
  if (ids.length === 0) return "";
  return JSON.stringify(ids);
}

/**
 * Ordered ids dispatched to the fix agent: the user's selected agent ids plus
 * any user-authored finding ids (which only appear in the merged list). Verbatim
 * combineSelectedFindingIDs.
 */
export function combineSelectedFindingIDs(selected: string[], mergedFindings: string): string[] {
  if (mergedFindings === "") return selected;
  const merged = parseFindings(mergedFindings);
  const seen = new Set<string>();
  for (const id of selected) if (id !== "") seen.add(id);
  const result = [...selected];
  for (const item of merged.items) {
    if (item.id === "" || seen.has(item.id)) continue;
    result.push(item.id);
    seen.add(item.id);
  }
  return result;
}

/** Count of findings in a payload (0 on empty). Verbatim findingsCount. */
export function findingsCount(raw: string): number {
  if (raw === "") return 0;
  return parseFindings(raw).items.length;
}

/** Number of findings selected for a round: the id count when non-empty, else
 *  the total finding count. Verbatim selectedFindingCount. */
export function selectedFindingCount(raw: string, ids: string[]): number {
  if (ids.length > 0) return ids.length;
  return findingsCount(raw);
}
