// ── Contract-in-code — the two behaviors upstream shipped BROKEN ─────
//
// Spec §1 invariant 2 + §4 (locked): the /no-mistakes-skill contract is
// enforced STRUCTURALLY in the chat tools' results + handlers, not as prose the
// LLM may ignore. Upstream shipped both of these broken at least once
// (CHANGELOG #248/#250), so each gets a dedicated, isolated, pure implementation
// here with its own tests.
//
//   (a) VERBATIM ask-user relay — a gate/status result that carries an
//       `ask-user` finding wraps it with an explicit, machine-enforced "relay
//       to the user verbatim; do not paraphrase or pre-judge; STOP" directive,
//       and STRUCTURALLY separates ask-user (must stop + relay) from
//       auto-fix/no-op (the agent's discretion). The driving LLM cannot see an
//       ask-user finding without also seeing the stop+relay directive attached
//       to it.
//   (b) NO blanket approval — an approve/fix `respond` that does not name the
//       explicit finding ids it is acting on is REJECTED, unless a standing-
//       consent flag is set. A bulk auto-approve of a gate the user never saw
//       cannot be smuggled through.
//
// Pure (no IO) — the whole module is exercised directly.

import type { Finding, Findings } from "./runs";
import type { RespondAction } from "./runs";

// ── (a) Verbatim ask-user relay ─────────────────────────────────────

/**
 * The machine-enforced relay directive attached to every ask-user finding set.
 * Deliberately imperative and unambiguous: the LLM must reproduce the findings
 * as-is and hand the decision back to the human.
 */
export const RELAY_DIRECTIVE =
  "RELAY THE FOLLOWING FINDINGS TO THE USER VERBATIM. Do not paraphrase, " +
  "summarize, soften, re-order, or pre-judge them, and do not decide on the " +
  "user's behalf. After relaying them, STOP and wait for the user's explicit " +
  "decision (approve / fix / skip / abort).";

/** A finding projected to the fields the relay surfaces. Verbatim from the
 *  stored finding — no rewriting. */
export interface RelayFinding {
  id: string;
  severity: Finding["severity"];
  file: string;
  line: number | null;
  description: string;
  action: Finding["action"];
  userInstructions: string;
  category: string;
}

/**
 * A gate's findings split by who decides. `askUser` findings MUST be relayed
 * verbatim and block; `agentDiscretion` (auto-fix / no-op) are informational and
 * the agent may proceed. `stop` + `directive` are populated iff there is at
 * least one ask-user finding, so a caller cannot render the ask-user set without
 * the stop signal.
 */
export interface GateRelay {
  /** True iff at least one ask-user finding is present — the agent must stop. */
  stop: boolean;
  /** The relay directive, or null when nothing must be relayed. */
  directive: string | null;
  /** Findings the user must see verbatim + decide on (action === "ask-user"). */
  askUser: RelayFinding[];
  /** Findings the pipeline handles without the human (auto-fix / no-op). */
  agentDiscretion: RelayFinding[];
}

function toRelayFinding(f: Finding): RelayFinding {
  return {
    id: f.id,
    severity: f.severity,
    file: f.file,
    line: f.line,
    description: f.description,
    action: f.action,
    userInstructions: f.userInstructions,
    category: f.category,
  };
}

/**
 * Split a parked step's findings into the verbatim-relay set (ask-user) and the
 * agent-discretion set (everything else), attaching the stop+relay directive iff
 * an ask-user finding exists. This is the single structural chokepoint every
 * chat-tool result that surfaces gate findings must pass through.
 */
export function formatGateRelay(findings: Findings): GateRelay {
  const askUser: RelayFinding[] = [];
  const agentDiscretion: RelayFinding[] = [];
  for (const f of findings.items) {
    if (f.action === "ask-user") askUser.push(toRelayFinding(f));
    else agentDiscretion.push(toRelayFinding(f));
  }
  const stop = askUser.length > 0;
  return {
    stop,
    directive: stop ? RELAY_DIRECTIVE : null,
    askUser,
    agentDiscretion,
  };
}

// ── (b) No blanket approval ─────────────────────────────────────────

/** The result of the no-blanket-approval check. */
export interface ApprovalGuard {
  ok: boolean;
  /** Present + describes the violation when `ok` is false. */
  error?: string;
  /** True when the guard passed ONLY because standing consent (`consentAll`)
   *  was set — an ids-free approve/fix over a gate that would OTHERWISE require
   *  named findingIds. The caller surfaces this for the audit trail (log line +
   *  `consentAllUsed` result marker) so a blanket clear is never silent. */
  consentAllUsed?: boolean;
}

/**
 * Reject an approve/fix that does not explicitly name the finding ids it acts
 * on, UNLESS either (a) the parked gate is CLEAN — it carries no `ask-user`
 * findings, so there is nothing the user needed to see and an ids-free
 * `approve` is the frictionless happy path — or (b) the caller sets the
 * standing-consent flag. skip/abort approve nothing, so they are always
 * allowed. `fix` always needs ids (or consent) to know WHAT to fix; `approve`
 * needs ids as proof the caller actually saw the ask-user findings it is
 * clearing (the executor's approve completes the whole step, so without this
 * gate an LLM could bulk-clear ask-user findings it never surfaced).
 *
 * `askUserCount` is the number of `action === "ask-user"` findings on the
 * parked step. Threading it in is what DE-NORMALIZES `consentAll`: the common
 * clean-gate approve no longer has to set the blanket flag, so a `consentAll`
 * in the wild is a real (auditable) signal rather than happy-path noise.
 */
export function enforceNamedApproval(
  action: RespondAction,
  findingIds: string[] | undefined,
  consentAll: boolean | undefined,
  askUserCount: number,
): ApprovalGuard {
  if (action !== "approve" && action !== "fix") return { ok: true };
  // Naming the explicit ids is the proof-of-surface — always allowed.
  if (findingIds && findingIds.length > 0) return { ok: true };
  // Ids-free from here. A CLEAN gate (no ask-user findings to clear) may be
  // APPROVED without ids or consent — nothing was withheld from the user.
  if (action === "approve" && askUserCount === 0) return { ok: true };
  // The only remaining path is explicit standing consent — flagged for audit
  // because a bulk clear then happened WITHOUT named finding ids.
  if (consentAll === true) return { ok: true, consentAllUsed: true };
  return {
    ok: false,
    error:
      `code_factory_respond: '${action}' must name the explicit findingIds it is ` +
      `acting on (a bulk auto-approve is refused; this gate has ${askUserCount} ` +
      `ask-user finding(s) awaiting a decision). Call code_factory_status first, ` +
      `relay the ask-user findings to the user verbatim, and pass the finding ids ` +
      `the user approved — or set consentAll:true only with the user's explicit ` +
      `standing consent to clear every finding of this gate.`,
  };
}

/**
 * Reject any named findingId that does not exist in the parked step's REAL
 * finding set. Strengthens the proof-of-surface heuristic: an approve/fix must
 * reference findings the pipeline actually produced, so junk ids (e.g. `["a1"]`
 * on a gate that never had it) can no longer be smuggled through the length>0
 * check. skip/abort name nothing → always allowed; an ids-free approve/fix is
 * governed by `enforceNamedApproval`, not here (empty list → nothing to check).
 * `knownIds` is every finding id on the parked step.
 */
export function crossCheckFindingIds(
  action: RespondAction,
  findingIds: string[] | undefined,
  knownIds: Iterable<string>,
): ApprovalGuard {
  if (action !== "approve" && action !== "fix") return { ok: true };
  if (!findingIds || findingIds.length === 0) return { ok: true };
  const known = new Set(knownIds);
  const unknown = findingIds.filter((id) => !known.has(id));
  if (unknown.length === 0) return { ok: true };
  return {
    ok: false,
    error:
      `code_factory_respond: finding id(s) [${unknown.join(", ")}] are not in the parked ` +
      `gate's findings — call code_factory_status to load the real finding ids before ` +
      `approving or fixing (do not invent ids).`,
  };
}
