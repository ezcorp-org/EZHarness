/**
 * The pure logic behind the delegation consent dialog and the
 * "jobs running as me" page (C3 phase 8b).
 *
 * Same split as `workflow-approvals-logic.ts`: everything that can be
 * decided without a DOM lives here so it is testable under plain `bun`,
 * and the `.svelte` files stay thin enough to read.
 *
 * ## The one rule this module exists to enforce
 *
 * **Render what the server derived. Never re-derive it.** Two facts in
 * this dialog are load-bearing and both already have a single upstream
 * home:
 *
 *  - the service-account REACH warning — `serviceAccountReach()`
 *    (`src/db/queries/service-accounts.ts`) runs the real read/run ladder
 *    against the real service-account caller and reports what came back;
 *  - the CAPABILITY set and graph — `ConsentHashMaterial`
 *    (`src/runtime/workflow-capability-hash.ts`) is the exact tuple the
 *    consent hash was taken over.
 *
 * A second copy of either would agree today and drift silently. So this
 * module formats them and computes differences between them; it never
 * decides what a principal may reach or what a workflow may do.
 */

// ── wire types ────────────────────────────────────────────────────────

/** Mirrors `ConsentStepMaterial` (`workflow-capability-hash.ts:158-167`). */
export interface ConsentStepMaterial {
	name: string;
	kind: string;
	/** Canonical `when` guard as JSON; the string `"null"` when absent. */
	when: string;
	skipDependents: boolean;
	/** Canonical per-step model binding as JSON; `"null"` when absent. */
	model: string;
}

/** Mirrors `ConsentGraphMaterial` (`workflow-capability-hash.ts:170-179`). */
export interface ConsentGraphMaterial {
	name: string;
	identity: string;
	defaultModel: string;
	steps: ConsentStepMaterial[];
	/** Sorted, de-duplicated `kind::value`. */
	capabilities: string[];
}

/** Mirrors `ConsentHashMaterial` (`workflow-capability-hash.ts:184-199`). */
export interface ConsentHashMaterial {
	v: number;
	extensionName: string;
	workflowName: string;
	projectId: string | null;
	runAs: { kind: string; id: string | null };
	trigger: { kind: string; spec: unknown };
	graph: ConsentGraphMaterial[];
	unresolved: string[];
	cycles: string[];
	tooDeep: string[];
}

/** Mirrors `ServiceAccountReach` (`src/db/queries/service-accounts.ts:152-158`). */
export interface ServiceAccountReach {
	code: string;
	runnableVisibilities: string[];
	message: string;
}

/**
 * A service account as the OWNER PICKER sees it.
 *
 * `id` and `name` are required because they are what the narrow read
 * (`GET /api/service-accounts` for a non-admin) returns and all the picker
 * needs: an id to send as `ownerServiceAccountId`, a name to render.
 *
 * `enabled` is OPTIONAL and its absence is meaningful rather than sloppy.
 * The narrow read withholds it AND filters the list to live accounts, so a
 * row without the flag is live by construction; the admin read carries the
 * full view, including disabled accounts, so an admin's picker can mark them
 * unselectable. Consumers must therefore test `enabled === false`, never
 * `!enabled` — the latter reads an absent field as "disabled" and would grey
 * out every option for exactly the non-admins this widening was for.
 */
export interface ServiceAccountOption {
	id: string;
	name: string;
	enabled?: boolean;
}

export type DelegationOwnerKind = "user" | "service";

export interface Delegation {
	id: string;
	extensionId: string;
	jobRef: string;
	ownerKind: DelegationOwnerKind;
	ownerId: string | null;
	workflowName: string;
	definitionVersionId: string | null;
	projectId: string | null;
	triggerKind: string;
	triggerSpec: Record<string, unknown> | null;
	capabilitySet: Array<{ kind: string; value: string | null }>;
	maxTokensPerRun: number;
	maxRunsPerDay: number;
	enabled: boolean;
	disabledReason: string | null;
	consentedAt: string;
	consentedByUserId: string;
}

/** One row of "jobs running as me". */
export interface DelegatedRun {
	id: string;
	workflowName: string;
	status: string;
	runAsKind: DelegationOwnerKind | null;
	runAs: string | null;
	delegationId: string | null;
	startedAt: string;
	finishedAt: string | null;
	error: string | null;
	suspendedReason: string | null;
}

/**
 * A step whose declared reasoning `effort` the provider will silently
 * drop. Derived SERVER-side from the resolved model's `reasoning` flag —
 * see the preview route.
 */
export interface EffortNoop {
	workflowName: string;
	stepName: string;
	provider: string;
	model: string;
	effort: string;
}

/** What `POST /api/workflows/delegations/preview` answers with. */
export interface ConsentPreview {
	material: ConsentHashMaterial;
	capabilitySet: Array<{ kind: string; value: string | null }>;
	consentHash: string;
	definitionVersionId: string | null;
	/** Steps whose `effort` is a no-op on the model actually bound. */
	effortNoops: EffortNoop[];
	/** The run-scoped tool-call ceiling, read from the host's own constant. */
	maxToolCallsPerRun: number;
	/** `MAX_WORKFLOW_NESTING_DEPTH`, read from the host's own constant. */
	maxNestingDepth: number;
	/**
	 * Phase 2's server-derived reach object.
	 *
	 * Carried here because `GET /api/service-accounts` is admin-only, so a
	 * non-admin consenting to a delegation could otherwise never read it —
	 * and the alternative, re-stating what a service account can reach in
	 * the browser, is the one thing this module refuses to do.
	 */
	reach: ServiceAccountReach;
}

// ── the owner-kind picker (Ruling 1) ──────────────────────────────────

export interface OwnerKindChoice {
	kind: DelegationOwnerKind;
	label: string;
	detail: string;
}

/**
 * Both kinds, always offered, always in this order.
 *
 * "Run as me" leads because it is the answer that works for every
 * workflow; a service account is the narrower, more deliberate choice and
 * reads better as the second option a person considers.
 */
export const OWNER_KIND_CHOICES: readonly OwnerKindChoice[] = [
	{
		kind: "user",
		label: "Run as me",
		detail: "Jobs run with your identity and reach exactly the workflows you can reach.",
	},
	{
		kind: "service",
		label: "Run as a service account",
		detail:
			"Jobs run as a named non-human principal with its own scopes. It has no user identity, so it reaches less than you do.",
	},
];

/**
 * The reach warning for a chosen owner kind — or `null` when there is
 * nothing to warn about.
 *
 * `reach` is Phase 2's server-derived object and its `message` is
 * rendered VERBATIM. This function decides only *whether* to show it,
 * never *what* it says: the moment this file starts composing its own
 * sentence about what a service account can reach, there are two answers
 * to that question and one of them is not connected to the ladder.
 */
export function reachWarningFor(
	ownerKind: DelegationOwnerKind,
	reach: ServiceAccountReach | null,
): string | null {
	if (ownerKind !== "service") return null;
	return reach?.message ?? null;
}

// ── the three TOKEN-BOUND EXCLUSIONS ──────────────────────────────────

/**
 * What `max_tokens_per_run` does NOT cover.
 *
 * This is the honesty requirement of the feature and it is binding. The
 * cap is a real bound on language-model spend and a person will read it
 * as a bound on the WHOLE job unless told otherwise, three times over:
 *
 *  1. **`tool` steps are outside it.** Tokens reach a step row from
 *     exactly one place — `workflow-executor.ts` inside `runAgentAttempt`
 *     — and `tool` / `transform` / `gate` / `approval` steps never reach
 *     it (`workflow-runs.ts` maps absent to SQL NULL, "deliberately NOT
 *     ?? 0"). They are NOT unbounded: a run carries a hard tool-call
 *     ceiling (`src/extensions/tool-executor/limits.ts`), which is why
 *     this sentence names a number instead of trailing off.
 *  2. **Nested child runs are outside it too.** A `workflow` step starts
 *     a run with its own id, so its tokens count against neither this cap
 *     nor the child's. Only nesting DEPTH bounds it. This one is not in
 *     the original spec — it was found by inspection — and it is the
 *     exclusion most likely to surprise someone.
 *  3. **A per-step reasoning `effort` is a no-op on a local or custom
 *     model.** Those models are synthesized with `reasoning: false`
 *     (`src/providers/registry.ts`), so the effort is never emitted.
 *     Shown ONLY when such a step is actually present, because a warning
 *     that fires on every dialog is a warning nobody reads.
 *
 * Each returns a `{ id, text }` so a test can name the one it asserts and
 * the dialog can key an `{#each}` without an index.
 */
export interface TokenBoundExclusion {
	id: "tool-steps" | "nested-runs" | "effort-noop";
	text: string;
}

export function tokenBoundExclusions(opts: {
	maxToolCallsPerRun: number;
	maxNestingDepth: number;
	effortNoops: readonly EffortNoop[];
}): TokenBoundExclusion[] {
	const out: TokenBoundExclusion[] = [
		{
			id: "tool-steps",
			text:
				"This limit counts language-model tokens. Steps that call tools are not counted against it — " +
				`they are separately limited to ${opts.maxToolCallsPerRun} tool calls per run.`,
		},
		{
			id: "nested-runs",
			text:
				"A step that starts another workflow is not counted against it either. The child run has its own " +
				`limit and spends it separately, so nesting is bounded by depth — at most ${opts.maxNestingDepth} ` +
				"levels — and not by this number.",
		},
	];

	if (opts.effortNoops.length > 0) {
		// Worded to exactly what the server DERIVED — the resolved model's
		// `reasoning` flag — with the local/custom case named because it is
		// the one that surprises people. Claiming "this is a local model"
		// outright would be a guess; a locally-served or custom model is the
		// reason the flag is false, not the thing the flag reports.
		out.push({
			id: "effort-noop",
			text:
				`${describeEffortNoopSteps(opts.effortNoops)} ask for a reasoning effort that will be ignored: ` +
				"the model bound to them does not accept a reasoning setting. Local and custom models never do.",
		});
	}
	return out;
}

/** "Step `a`" / "Steps `a` and `b`" / "Steps `a`, `b` and 2 more". */
export function describeEffortNoopSteps(noops: readonly EffortNoop[]): string {
	const names = noops.map((n) => `${n.workflowName}.${n.stepName}`);
	if (names.length === 1) return `Step ${names[0]}`;
	if (names.length === 2) return `Steps ${names[0]} and ${names[1]}`;
	return `Steps ${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

// ── the capability diff ───────────────────────────────────────────────

export interface CapabilityRow {
	kind: string;
	value: string;
	/** Which definitions in the closure contribute this capability. */
	fromWorkflows: string[];
	/** `true` for the kinds a reviewer must look hardest at. */
	sensitive: boolean;
}

/**
 * Capability kinds that get visual weight in the diff.
 *
 * A deliberate, small, LOCAL list rather than an import of the host's
 * `SENSITIVE_KINDS`: this drives emphasis in a dialog, not an
 * authorization decision, and importing the PDP's list into the browser
 * would put a security-relevant constant somewhere it can be read but
 * not enforced. If the two ever disagree the consequence is a row that
 * is bold when it need not be.
 */
const EMPHASISED_KINDS = new Set(["shell", "fs", "net", "install", "tool:unreachable", "agent:unreachable"]);

/** `"kind::value"` → `{kind, value}`; `value` may itself contain `::`. */
export function parseCapabilityKey(key: string): { kind: string; value: string } {
	const at = key.indexOf("::");
	if (at === -1) return { kind: key, value: "" };
	return { kind: key.slice(0, at), value: key.slice(at + 2) };
}

/**
 * Every capability the closure reaches, with the definitions that
 * contribute it.
 *
 * Attribution matters more than the list: "this workflow can run shell"
 * and "a workflow three levels down that you have never opened can run
 * shell" are the same capability and very different consent decisions.
 */
export function summarizeCapabilities(material: ConsentHashMaterial): CapabilityRow[] {
	const byKey = new Map<string, CapabilityRow>();
	for (const def of material.graph) {
		for (const key of def.capabilities) {
			const { kind, value } = parseCapabilityKey(key);
			const existing = byKey.get(key);
			if (existing === undefined) {
				byKey.set(key, {
					kind,
					value,
					fromWorkflows: [def.name],
					sensitive: EMPHASISED_KINDS.has(kind),
				});
			} else if (!existing.fromWorkflows.includes(def.name)) {
				existing.fromWorkflows.push(def.name);
			}
		}
	}
	return [...byKey.values()].sort(
		(a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value),
	);
}

export interface ConditionalStep {
	workflowName: string;
	stepName: string;
	kind: string;
	/** The `when` guard, already unwrapped from its JSON encoding. */
	when: string;
	/** `false` means a skip here does NOT skip what depends on it. */
	skipDependents: boolean;
}

/**
 * Steps that run only when a guard passes.
 *
 * These belong in the dialog and for a while it was believed they could
 * not be shown. They can: a `when` guard is a hash input in its own
 * right, so it is already in the material. A reviewer needs them because
 * a conditional `shell` step contributes its capability to the set
 * unconditionally — the set says the job MAY run shell, and only the
 * guard says when. Showing the guard is what makes the capability list
 * honest rather than alarming.
 *
 * `skipDependents: false` is called out because it is the sharp edge:
 * with it, a skipped step does not skip its dependents, so a guard
 * failing does not necessarily stop the branch below it.
 */
export function conditionalSteps(material: ConsentHashMaterial): ConditionalStep[] {
	const out: ConditionalStep[] = [];
	for (const def of material.graph) {
		for (const step of def.steps) {
			const when = decodeCanonical(step.when);
			if (when === null) continue;
			out.push({
				workflowName: def.name,
				stepName: step.name,
				kind: step.kind,
				when,
				skipDependents: step.skipDependents,
			});
		}
	}
	return out;
}

/**
 * Unwrap one of the material's `stableStringify`-encoded fields.
 *
 * The encoding is JSON, and `"null"` is how "the step declared none" is
 * spelled. A value that will not parse is shown verbatim rather than
 * dropped — a guard nobody can read is still a guard, and hiding it
 * would understate what was consented to.
 */
export function decodeCanonical(encoded: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(encoded);
	} catch {
		return encoded;
	}
	if (parsed === null) return null;
	return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
}

export interface CapabilityDiff {
	added: CapabilityRow[];
	removed: CapabilityRow[];
	unchanged: CapabilityRow[];
}

/**
 * What changed since the consent being replaced.
 *
 * Ruling 2 makes ANY edit re-ask, including one that changes no
 * capability at all — so an empty `added`/`removed` is a normal and
 * important outcome, and the dialog says so explicitly rather than
 * rendering nothing. "Nothing about what this job can do has changed" is
 * the single most useful sentence a re-consent can show, because it is
 * what lets someone approve quickly without training themselves to
 * approve everything quickly.
 */
export function diffCapabilities(
	before: readonly CapabilityRow[] | null,
	after: readonly CapabilityRow[],
): CapabilityDiff {
	if (before === null) return { added: [...after], removed: [], unchanged: [] };
	const key = (r: CapabilityRow) => `${r.kind}::${r.value}`;
	const beforeKeys = new Set(before.map(key));
	const afterKeys = new Set(after.map(key));
	return {
		added: after.filter((r) => !beforeKeys.has(key(r))),
		unchanged: after.filter((r) => beforeKeys.has(key(r))),
		removed: before.filter((r) => !afterKeys.has(key(r))),
	};
}

/** Closure problems the material reports. Each is a real reason to
 *  hesitate, so none of them is allowed to be silent. */
export interface ClosureWarning {
	id: "unresolved" | "cycles" | "too-deep";
	text: string;
}

export function closureWarnings(material: ConsentHashMaterial): ClosureWarning[] {
	const out: ClosureWarning[] = [];
	if (material.unresolved.length > 0) {
		out.push({
			id: "unresolved",
			text:
				`This job reaches ${material.unresolved.length} workflow(s) that could not be resolved as its owner: ` +
				`${material.unresolved.join(", ")}. What they do cannot be shown here.`,
		});
	}
	if (material.cycles.length > 0) {
		out.push({
			id: "cycles",
			text: `This job's workflows call each other in a loop: ${material.cycles.join("; ")}.`,
		});
	}
	if (material.tooDeep.length > 0) {
		out.push({
			id: "too-deep",
			text:
				`Nested deeper than the walk goes, so their contents are not shown: ${material.tooDeep.join(", ")}.`,
		});
	}
	return out;
}

// ── submit-time validation ────────────────────────────────────────────

export interface ConsentDraft {
	extensionId: string;
	jobRef: string;
	workflowName: string;
	ownerKind: DelegationOwnerKind;
	ownerServiceAccountId: string | null;
	projectId: string | null;
	triggerKind: string;
	maxTokensPerRun: number | null;
	maxRunsPerDay: number | null;
}

/**
 * Why the approve button is disabled, or `null` when it is not.
 *
 * Returns the REASON rather than a boolean so the dialog can show it. A
 * disabled primary action with no explanation is the single most common
 * way a consent dialog becomes a dead end.
 *
 * Neither bound has a default and neither has an "unlimited" value —
 * matching the route's schema, which requires both. A default would be a
 * number nobody chose; an unlimited option would be the number everybody
 * chooses.
 */
export function consentBlockedReason(draft: ConsentDraft): string | null {
	if (draft.workflowName === "") return "Choose a workflow.";
	if (draft.ownerKind === "service" && !draft.ownerServiceAccountId) {
		return "Choose a service account, or switch to “Run as me”.";
	}
	if (!isPositiveInt(draft.maxTokensPerRun)) {
		return "Set a token limit per run (a whole number above zero).";
	}
	if (!isPositiveInt(draft.maxRunsPerDay)) {
		return "Set a maximum number of runs per day (a whole number above zero).";
	}
	return null;
}

function isPositiveInt(n: number | null): n is number {
	return n !== null && Number.isInteger(n) && n > 0;
}

/** The POST body for `/api/workflows/delegations`, built from a draft
 *  the caller has already run past {@link consentBlockedReason}. */
export function buildConsentBody(draft: ConsentDraft): Record<string, unknown> {
	return {
		extensionId: draft.extensionId,
		jobRef: draft.jobRef,
		workflowName: draft.workflowName,
		ownerKind: draft.ownerKind,
		// Sent ONLY for the service arm: the route refuses a body that
		// names both, rather than ignoring half of it.
		...(draft.ownerKind === "service" && draft.ownerServiceAccountId
			? { ownerServiceAccountId: draft.ownerServiceAccountId }
			: {}),
		projectId: draft.projectId,
		triggerKind: draft.triggerKind,
		maxTokensPerRun: draft.maxTokensPerRun,
		maxRunsPerDay: draft.maxRunsPerDay,
	};
}

// ── presentation helpers ──────────────────────────────────────────────

/**
 * How a delegated run reads in the list.
 *
 * `awaiting_approval` gets its own tone because it is terminal for the
 * process but is neither success nor failure — a delegated run parked on
 * a decision is waiting for the consenting human specifically, so it is
 * the row they most need to notice.
 */
export function describeRunStatus(status: string): { tone: "ok" | "warn" | "error" | "muted"; text: string } {
	switch (status) {
		case "success":
			return { tone: "ok", text: "Succeeded" };
		case "error":
			return { tone: "error", text: "Failed" };
		case "cancelled":
			return { tone: "muted", text: "Cancelled" };
		case "awaiting_approval":
			return { tone: "warn", text: "Waiting on you" };
		case "running":
			return { tone: "ok", text: "Running" };
		case "suspended":
			return { tone: "warn", text: "Paused" };
		default:
			return { tone: "muted", text: status };
	}
}

/**
 * Why a paused delegated run is paused, in a sentence with a remedy.
 *
 * ## It keys on `suspended_reason`, and the reason that is a CORRECTION
 *
 * This function used to key on `run.error` and match `DELEGATION_*` deny
 * codes as substrings. **Every one of those branches was unreachable on
 * production data**, and the whole classifier was dead:
 *
 *  - `run.error` is fed from `run.result?.error`
 *    (`web/src/routes/api/workflows/delegated-runs/+server.ts:76`);
 *  - the rungs that emit `DELEGATION_OWNER_LOST_WORKFLOW_ACCESS` (D7),
 *    `DELEGATION_QUOTA_EXCEEDED` (D8), `DELEGATION_SPEND_EXCEEDED` (D9)
 *    and `DELEGATION_DAILY_TOKENS_EXCEEDED` (D10) are dispatch-time
 *    `denyAs(...)` RETURNS — they create no `workflow_runs` row at all
 *    (`src/extensions/workflows-handler.ts:1525`, `:1545`, `:1613`,
 *    `:1688`), so there is nothing here to classify;
 *  - the only two paths that DO leave a row write a SUSPEND REASON and
 *    never an error: `parkConsentStaleRun` writes `"consent-stale"`
 *    (`workflows-handler.ts:1765`) and the step-boundary ceiling throws
 *    `WorkflowSuspendedError(…, "budget-exceeded")`
 *    (`src/runtime/workflow-executor.ts:664`).
 *
 * So the vocabulary that actually ARRIVES on this field is the six-value
 * `WorkflowSuspendReason` union in `src/runtime/workflow-resume-reasons.ts:98-104`,
 * and that is what this now reads. The route already carried it
 * (`delegated-runs/+server.ts:79`).
 *
 * ## The distinction the old version existed to draw, kept
 *
 * A per-run ceiling and a re-consent look identical to a person whose
 * cron job "just stopped", and they have opposite remedies — one is a
 * number this page can raise, the other needs the consent dialog. Those
 * two are named apart below, which was the original point.
 *
 * The DAILY account cap is deliberately absent: it denies at dispatch and
 * leaves no run, so it can never be the reason a row on this page is
 * paused. It is explained where it actually happens — see the
 * non-firing-denial note on the page itself.
 *
 * Returns `null` for anything it does not recognise (a reason written by a
 * newer instance mid-rolling-deploy), and the caller falls back to showing
 * the raw value. Guessing at an unrecognised reason would be worse than
 * showing what the server actually said.
 */
export function describeRunStopReason(suspendedReason: string | null): string | null {
	switch (suspendedReason) {
		case "budget-exceeded":
			return "Paused: this run spent the whole per-run token limit on its delegation. You can raise that limit above, and the run continues from where it stopped.";
		case "consent-stale":
			return "Paused: the workflow changed since you approved it, so nothing ran. Approve it again to release it — raising a limit will not clear this.";
		case "approval":
			return "Paused: it is waiting for someone to answer an approval step.";
		case "approval-timeout":
			return "Stopped: nobody answered its approval in time, so the run was cancelled. It cannot be resumed — the job has to fire again.";
		case "nested-suspended":
			return "Paused: it is waiting on another workflow it started.";
		case "orphaned-resumable":
			return "Paused at a step boundary, most likely by a restart. Nothing is wrong with it and it is safe to continue.";
		default:
			return null;
	}
}

/**
 * When a run started, as a person reads it.
 *
 * A raw ISO string is precise and unreadable, and this list is scanned
 * rather than audited — "2 hours ago" answers "is this job still doing
 * what I expect?" at a glance, which is the question the page exists for.
 * Past a week the relative form stops helping, so it becomes a date.
 *
 * `now` is a parameter rather than a `Date.now()` call so the behaviour is
 * testable without freezing the clock.
 */
export function describeRunTime(startedAt: string, now: Date): string {
	const started = new Date(startedAt);
	if (Number.isNaN(started.getTime())) return startedAt;
	const seconds = Math.floor((now.getTime() - started.getTime()) / 1000);
	if (seconds < 0) return started.toLocaleDateString();
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	return started.toLocaleDateString();
}

/** "as you" / "as <account>" — never a bare id. */
export function describeRunPrincipal(
	run: DelegatedRun,
	accountsById: Readonly<Record<string, string>>,
): string {
	if (run.runAsKind === "user") return "as you";
	if (run.runAsKind === "service") {
		return `as ${accountsById[run.runAs ?? ""] ?? "a service account"}`;
	}
	return "not delegated";
}

/**
 * Why a delegation is not currently firing, or `null` when it is live.
 *
 * `enabled` stays in the liveness predicate (Ruling 4), so a disabled
 * delegation is shown as stopped even when nothing revoked it — and
 * `disabledReason` is the only thing a person ever sees explaining why
 * their unattended job went quiet.
 */
export function describeDelegationState(d: Delegation): { live: boolean; text: string } {
	if (!d.enabled) {
		return {
			live: false,
			text: d.disabledReason ?? "Stopped. No reason was recorded.",
		};
	}
	return { live: true, text: "Live" };
}

// ── HTTP ──────────────────────────────────────────────────────────────

export type Result<T> = { ok: true; value: T } | { ok: false; message: string };

async function send<T>(url: string, init?: RequestInit): Promise<Result<T>> {
	let res: Response;
	try {
		res = await fetch(url, init);
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
	const body = (await res.json().catch(() => ({}))) as { error?: string };
	if (!res.ok) {
		// The route's own sentence, not a generic status line. Phase 4's
		// consent refusal names the reason AND the remedy ("choose run as
		// me, or ask an admin to make the workflow system-visible"), and
		// replacing that with "403 Forbidden" is how a user ends up filing
		// a bug against a message that was already written for them.
		return { ok: false, message: body.error ?? `Request failed (${res.status})` };
	}
	return { ok: true, value: body as T };
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export function previewConsent(draft: ConsentDraft): Promise<Result<ConsentPreview>> {
	return send<ConsentPreview>("/api/workflows/delegations/preview", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({
			extensionId: draft.extensionId,
			workflowName: draft.workflowName,
			ownerKind: draft.ownerKind,
			...(draft.ownerKind === "service" && draft.ownerServiceAccountId
				? { ownerServiceAccountId: draft.ownerServiceAccountId }
				: {}),
			projectId: draft.projectId,
			triggerKind: draft.triggerKind,
		}),
	});
}

export function submitConsent(
	draft: ConsentDraft,
): Promise<Result<{ delegation: Delegation; supersededId: string | null }>> {
	return send("/api/workflows/delegations", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify(buildConsentBody(draft)),
	});
}

export function revokeDelegation(id: string): Promise<Result<{ revoked: boolean }>> {
	return send(`/api/workflows/delegations/${id}`, { method: "DELETE" });
}

/**
 * Adjust a live delegation's spend bounds in place.
 *
 * Bound to the `PATCH /api/workflows/delegations/:id` contract owned by
 * phase 8a — session-only, authorized to the consenting human, adjusts
 * `max_tokens_per_run` and `max_runs_per_day` and NOTHING else.
 * Deliberately NOT re-consent: the consent hash covers what the job may
 * DO, and moving a spend bound changes no capability, so re-asking for
 * the whole grant to change one number would train people to click
 * through consent dialogs.
 *
 * The body is built by OMISSION, not by sending `undefined`: the route's
 * schema is `.strict()` and refuses a body naming a field it does not
 * own, so an unset bound must not appear as a key at all. `JSON.stringify`
 * drops `undefined` values, but relying on that puts the request shape at
 * the mercy of a serializer detail, and this is the one place a wrong
 * shape turns every save into a 400 in production only.
 */
export function patchDelegationBounds(
	id: string,
	bounds: { maxTokensPerRun?: number; maxRunsPerDay?: number },
): Promise<Result<{ delegation: Delegation }>> {
	const body: Record<string, number> = {};
	if (bounds.maxTokensPerRun !== undefined) body.maxTokensPerRun = bounds.maxTokensPerRun;
	if (bounds.maxRunsPerDay !== undefined) body.maxRunsPerDay = bounds.maxRunsPerDay;
	return send(`/api/workflows/delegations/${id}`, {
		method: "PATCH",
		headers: JSON_HEADERS,
		body: JSON.stringify(body),
	});
}

export function loadDelegations(): Promise<Result<{ delegations: Delegation[] }>> {
	return send("/api/workflows/delegations");
}

export function loadDelegatedRuns(): Promise<Result<{ runs: DelegatedRun[] }>> {
	return send("/api/workflows/delegated-runs");
}

/**
 * The service accounts this caller may name as a delegation owner.
 *
 * Reachable by ANY authenticated session since the read was widened: an
 * admin gets the full row, everybody else gets `{id, name}` per live
 * account plus the same server-derived `reach`. That is what makes Ruling
 * 1's "both owner kinds, selectable per delegation" true for the people
 * who are not admins, which is most of them.
 *
 * A failure is still tolerated by every caller — a 500 or an offline
 * browser must not take the revoke button down with it — so this returns
 * a `Result` and the page falls back to an empty list.
 */
export function loadServiceAccounts(): Promise<
	Result<{ accounts: ServiceAccountOption[]; reach: ServiceAccountReach }>
> {
	return send("/api/service-accounts");
}
