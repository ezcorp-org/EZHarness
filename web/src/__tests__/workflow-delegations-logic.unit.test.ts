/**
 * The pure logic behind the delegation consent dialog.
 *
 * The dialog is where standing, unattended authority over someone's
 * workflows is minted, so the assertions here are about what a person is
 * TOLD, not only about what the code computes:
 *
 *   - all three token-bound exclusions are present and say the true thing;
 *   - the reach warning is Phase 2's sentence, never a paraphrase;
 *   - the capability diff attributes each capability to the definition
 *     that contributes it, including ones nested out of sight;
 *   - the approve button's blocked reason is a sentence, never a boolean.
 */
import { test, expect, describe, afterEach } from "vitest";
// The CANONICAL suspend-reason vocabulary, imported rather than retyped: a
// copy here would drift exactly the way the classifier drifted from the wire.
import { WORKFLOW_SUSPEND_REASONS } from "$server/runtime/workflow-resume-reasons";
import {
	GRANT_PARAMS,
	MAX_JOB_REF_CHARS,
	OWNER_KIND_CHOICES,
	TRIGGER_KIND_CHOICES,
	buildConsentBody,
	closureWarnings,
	conditionalSteps,
	consentBlockedReason,
	decodeCanonical,
	describeDelegationState,
	describeEffortNoopSteps,
	describeGrantPrefill,
	describeTriggerKind,
	grantParams,
	resolveGrantPrefill,
	describeRunPrincipal,
	describeRunStatus,
	describeRunStopReason,
	describeRunTime,
	diffCapabilities,
	loadDelegatedRuns,
	loadDelegations,
	loadServiceAccounts,
	patchDelegationBounds,
	previewConsent,
	revokeDelegation,
	submitConsent,
	parseCapabilityKey,
	reachWarningFor,
	summarizeCapabilities,
	tokenBoundExclusions,
	type ConsentDraft,
	type ConsentHashMaterial,
	type Delegation,
	type DelegatedRun,
	type EffortNoop,
	type GrantPrefill,
} from "../lib/workflow-delegations-logic";

function material(over: Partial<ConsentHashMaterial> = {}): ConsentHashMaterial {
	return {
		v: 1,
		extensionName: "ext",
		workflowName: "ship-it",
		projectId: null,
		runAs: { kind: "user", id: "u1" },
		trigger: { kind: "cron", spec: null },
		graph: [],
		unresolved: [],
		cycles: [],
		tooDeep: [],
		...over,
	};
}

const NOOP: EffortNoop = {
	workflowName: "ship-it",
	stepName: "write",
	provider: "ollama",
	model: "llama3",
	effort: "high",
};

// ── the three exclusions ──────────────────────────────────────────────

describe("tokenBoundExclusions — the honesty requirement", () => {
	const base = { maxToolCallsPerRun: 100, maxNestingDepth: 3, effortNoops: [] };

	test("ALWAYS discloses that tool steps are outside the cap, and names their own bound", () => {
		const tool = tokenBoundExclusions(base).find((e) => e.id === "tool-steps");
		expect(tool).toBeDefined();
		// The claim itself: the cap counts LLM tokens, tool steps are not
		// counted, and they are separately bounded. All three clauses.
		expect(tool?.text).toContain("counts language-model tokens");
		expect(tool?.text).toContain("Steps that call tools are not counted against it");
		expect(tool?.text).toContain("100 tool calls per run");
	});

	test("the tool-call number comes from the HOST, not from copy", () => {
		// `EZCORP_MAX_TOOL_CALLS_PER_TURN` can retune the ceiling, so a
		// dialog that hardcoded 100 would be confidently wrong.
		const tuned = tokenBoundExclusions({ ...base, maxToolCallsPerRun: 25 });
		expect(tuned.find((e) => e.id === "tool-steps")?.text).toContain("25 tool calls per run");
	});

	test("ALWAYS discloses that a nested child run is outside the cap too", () => {
		const nested = tokenBoundExclusions(base).find((e) => e.id === "nested-runs");
		expect(nested).toBeDefined();
		expect(nested?.text).toContain("starts another workflow is not counted");
		// The child's tokens count against NEITHER cap; only depth bounds it.
		expect(nested?.text).toContain("own");
		expect(nested?.text).toContain("3");
	});

	test("both unconditional exclusions are present even with nothing else to say", () => {
		expect(tokenBoundExclusions(base).map((e) => e.id)).toEqual(["tool-steps", "nested-runs"]);
	});

	test("the effort no-op is disclosed ONLY when such a step exists", () => {
		expect(tokenBoundExclusions(base).some((e) => e.id === "effort-noop")).toBe(false);

		const withNoop = tokenBoundExclusions({ ...base, effortNoops: [NOOP] });
		const effort = withNoop.find((e) => e.id === "effort-noop");
		expect(effort).toBeDefined();
		expect(effort?.text).toContain("ship-it.write");
		expect(effort?.text).toContain("will be ignored");
		expect(effort?.text).toContain("Local and custom models never do");
	});

	test("the effort sentence names the steps, and stops naming them past two", () => {
		expect(describeEffortNoopSteps([NOOP])).toBe("Step ship-it.write");
		expect(describeEffortNoopSteps([NOOP, { ...NOOP, stepName: "b" }])).toBe(
			"Steps ship-it.write and ship-it.b",
		);
		expect(
			describeEffortNoopSteps([
				NOOP,
				{ ...NOOP, stepName: "b" },
				{ ...NOOP, stepName: "c" },
				{ ...NOOP, stepName: "d" },
			]),
		).toBe("Steps ship-it.write, ship-it.b and 2 more");
	});

	test("no exclusion mentions money — tokens are enforced, cost is advisory", () => {
		// Ruling 3. An unpriced (OAuth-subscription) model reports a null
		// price and would spend without bound under a cents cap, so a cents
		// figure must not appear anywhere in this dialog's copy.
		const all = tokenBoundExclusions({ ...base, effortNoops: [NOOP] })
			.map((e) => e.text)
			.join(" ");
		expect(all).not.toMatch(/\$|cent|cost|USD/i);
	});
});

// ── the reach warning ─────────────────────────────────────────────────

describe("reachWarningFor — Phase 2's sentence, not a second one", () => {
	const reach = {
		code: "SERVICE_ACCOUNT_SYSTEM_ONLY",
		runnableVisibilities: ["system"],
		message: "A service account has no user identity, so it can only be delegated: system.",
	};

	test("`service` renders the server's message VERBATIM", () => {
		expect(reachWarningFor("service", reach)).toBe(reach.message);
	});

	test("`user` warns about nothing — a user reaches what they reach", () => {
		expect(reachWarningFor("user", reach)).toBeNull();
	});

	test("no reach loaded yet is silence, never an invented sentence", () => {
		// The alternative — composing a fallback here — is how a second
		// answer to "what can a service account reach" gets into the tree.
		expect(reachWarningFor("service", null)).toBeNull();
	});
});

describe("OWNER_KIND_CHOICES — Ruling 1", () => {
	test("BOTH kinds are offered, user first", () => {
		expect(OWNER_KIND_CHOICES.map((c) => c.kind)).toEqual(["user", "service"]);
	});

	test("each choice explains what it means for reach", () => {
		expect(OWNER_KIND_CHOICES[0]?.detail).toContain("workflows you can reach");
		expect(OWNER_KIND_CHOICES[1]?.detail).toContain("reaches less than you do");
	});
});

// ── the capability diff ───────────────────────────────────────────────

describe("summarizeCapabilities", () => {
	const graphed = material({
		graph: [
			{
				name: "ship-it",
				identity: "v1@1",
				defaultModel: "null",
				steps: [],
				capabilities: ["agent::writer", "shell::"],
			},
			{
				name: "nested",
				identity: "v2@1",
				defaultModel: "null",
				steps: [],
				capabilities: ["shell::", "tool::read_file"],
			},
		],
	});

	test("attributes each capability to EVERY definition that contributes it", () => {
		const rows = summarizeCapabilities(graphed);
		const shell = rows.find((r) => r.kind === "shell");
		// The attribution is the point: "this workflow can run shell" and "a
		// workflow three levels down can run shell" are the same capability
		// and very different consent decisions.
		expect(shell?.fromWorkflows).toEqual(["ship-it", "nested"]);
	});

	test("de-duplicates, and sorts so two runs read the same", () => {
		expect(summarizeCapabilities(graphed).map((r) => `${r.kind}::${r.value}`)).toEqual([
			"agent::writer",
			"shell::",
			"tool::read_file",
		]);
	});

	test("emphasises the kinds a reviewer must look hardest at", () => {
		const rows = summarizeCapabilities(graphed);
		expect(rows.find((r) => r.kind === "shell")?.sensitive).toBe(true);
		expect(rows.find((r) => r.kind === "agent")?.sensitive).toBe(false);
	});

	test("an empty closure summarizes to nothing rather than throwing", () => {
		expect(summarizeCapabilities(material())).toEqual([]);
	});
});

describe("parseCapabilityKey", () => {
	test("splits on the FIRST separator, so a value may contain one", () => {
		expect(parseCapabilityKey("net::https://a.example/b::c")).toEqual({
			kind: "net",
			value: "https://a.example/b::c",
		});
	});

	test("a key with no separator is all kind", () => {
		expect(parseCapabilityKey("storage")).toEqual({ kind: "storage", value: "" });
	});
});

describe("diffCapabilities", () => {
	const a = { kind: "shell", value: "", fromWorkflows: ["w"], sensitive: true };
	const b = { kind: "tool", value: "read_file", fromWorkflows: ["w"], sensitive: false };

	test("a FIRST consent is all-added — there is nothing to compare to", () => {
		expect(diffCapabilities(null, [a, b])).toEqual({ added: [a, b], removed: [], unchanged: [] });
	});

	test("a re-consent separates added, removed and unchanged", () => {
		const diff = diffCapabilities([a], [a, b]);
		expect(diff.added).toEqual([b]);
		expect(diff.unchanged).toEqual([a]);
		expect(diff.removed).toEqual([]);
	});

	test("a capability that went away is REMOVED, not silently dropped", () => {
		expect(diffCapabilities([a, b], [a]).removed).toEqual([b]);
	});

	test("an edit that changes no capability diffs to nothing on both sides", () => {
		// Ruling 2 re-asks on ANY edit, including an inputSchema-only one, so
		// this is a NORMAL outcome the dialog has to be able to say out loud.
		const diff = diffCapabilities([a, b], [a, b]);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
		expect(diff.unchanged).toHaveLength(2);
	});
});

// ── `when`-guarded steps ──────────────────────────────────────────────

describe("conditionalSteps — the caveat that no longer applies", () => {
	const guarded = material({
		graph: [
			{
				name: "ship-it",
				identity: "v1@1",
				defaultModel: "null",
				steps: [
					{ name: "always", kind: "agent", when: "null", skipDependents: true, model: "null" },
					{
						name: "maybe",
						kind: "tool",
						when: JSON.stringify("inputs.deploy == true"),
						skipDependents: true,
						model: "null",
					},
					{
						name: "leaky",
						kind: "tool",
						when: JSON.stringify("inputs.x"),
						skipDependents: false,
						model: "null",
					},
				],
				capabilities: [],
			},
		],
	});

	test("reports ONLY the guarded steps, with the guard decoded", () => {
		const steps = conditionalSteps(guarded);
		expect(steps.map((s) => s.stepName)).toEqual(["maybe", "leaky"]);
		expect(steps[0]?.when).toBe("inputs.deploy == true");
	});

	test("carries skipDependents, because false is the sharp edge", () => {
		// With `skipDependents: false` a failing guard does not stop the
		// branch below it, so a reader who assumed it did would be wrong
		// about what the workflow does.
		expect(conditionalSteps(guarded).find((s) => s.stepName === "leaky")?.skipDependents).toBe(
			false,
		);
	});

	test("an unguarded workflow reports none", () => {
		expect(conditionalSteps(material())).toEqual([]);
	});
});

describe("decodeCanonical", () => {
	test("`null` means the step declared none", () => {
		expect(decodeCanonical("null")).toBeNull();
	});

	test("a JSON string comes back unquoted", () => {
		expect(decodeCanonical('"a == b"')).toBe("a == b");
	});

	test("a non-string value is re-serialized rather than dropped", () => {
		expect(decodeCanonical('{"a":1}')).toBe('{"a":1}');
	});

	test("unparseable input is shown VERBATIM, never hidden", () => {
		// A guard nobody can read is still a guard; hiding it would
		// understate what is being consented to.
		expect(decodeCanonical("not json")).toBe("not json");
	});
});

describe("closureWarnings", () => {
	test("unresolved children are named, and counted", () => {
		const w = closureWarnings(material({ unresolved: ["a", "b"] }));
		expect(w).toHaveLength(1);
		expect(w[0]?.id).toBe("unresolved");
		expect(w[0]?.text).toContain("a, b");
		expect(w[0]?.text).toContain("cannot be shown");
	});

	test("cycles and depth cut-offs each get their own warning", () => {
		const w = closureWarnings(material({ cycles: ["a -> b -> a"], tooDeep: ["deep"] }));
		expect(w.map((x) => x.id)).toEqual(["cycles", "too-deep"]);
	});

	test("a clean closure warns about nothing", () => {
		expect(closureWarnings(material())).toEqual([]);
	});
});

// ── submit-time validation ────────────────────────────────────────────

describe("consentBlockedReason — a sentence, never a boolean", () => {
	const ok: ConsentDraft = {
		extensionId: "ext-1",
		jobRef: "job-1",
		workflowName: "ship-it",
		ownerKind: "user",
		ownerServiceAccountId: null,
		projectId: null,
		triggerKind: "cron",
		maxTokensPerRun: 5000,
		maxRunsPerDay: 24,
	};

	test("a complete draft is not blocked", () => {
		expect(consentBlockedReason(ok)).toBeNull();
	});

	test("a service draft with no account names the remedy", () => {
		const reason = consentBlockedReason({ ...ok, ownerKind: "service" });
		expect(reason).toContain("service account");
		expect(reason).toContain("Run as me");
	});

	test("NEITHER bound has a default — both must be chosen", () => {
		// A default would be a number nobody chose; an unlimited option
		// would be the number everybody chooses. The route requires both.
		expect(consentBlockedReason({ ...ok, maxTokensPerRun: null })).toContain("token limit");
		expect(consentBlockedReason({ ...ok, maxRunsPerDay: null })).toContain("runs per day");
	});

	test("zero, negative and fractional bounds are all refused", () => {
		for (const bad of [0, -1, 1.5]) {
			expect(consentBlockedReason({ ...ok, maxTokensPerRun: bad })).not.toBeNull();
			expect(consentBlockedReason({ ...ok, maxRunsPerDay: bad })).not.toBeNull();
		}
	});

	test("no workflow chosen is refused", () => {
		expect(consentBlockedReason({ ...ok, workflowName: "" })).toContain("workflow");
	});
});

describe("buildConsentBody", () => {
	const draft: ConsentDraft = {
		extensionId: "ext-1",
		jobRef: "job-1",
		workflowName: "ship-it",
		ownerKind: "user",
		ownerServiceAccountId: "svc-1",
		projectId: null,
		triggerKind: "cron",
		maxTokensPerRun: 5000,
		maxRunsPerDay: 24,
	};

	test("the USER arm never sends an account id, even when one is held", () => {
		// The route refuses a body naming both arms rather than ignoring
		// half of it, so a stale selection must not ride along.
		expect(buildConsentBody(draft)).not.toHaveProperty("ownerServiceAccountId");
	});

	test("the SERVICE arm sends it", () => {
		expect(buildConsentBody({ ...draft, ownerKind: "service" })).toMatchObject({
			ownerKind: "service",
			ownerServiceAccountId: "svc-1",
		});
	});

	test("no cents field is ever sent — Ruling 3", () => {
		expect(JSON.stringify(buildConsentBody(draft))).not.toMatch(/cent|cost/i);
	});
});

// ── presentation ──────────────────────────────────────────────────────

describe("describeRunStatus", () => {
	test("`awaiting_approval` reads as waiting on the person, not as success", () => {
		expect(describeRunStatus("awaiting_approval")).toEqual({ tone: "warn", text: "Waiting on you" });
	});

	test("success and error are distinguishable by tone", () => {
		expect(describeRunStatus("success").tone).toBe("ok");
		expect(describeRunStatus("error").tone).toBe("error");
	});

	test("an unknown status is shown as itself rather than hidden", () => {
		expect(describeRunStatus("weird")).toEqual({ tone: "muted", text: "weird" });
	});

	test("every status the table knows gets its own reading", () => {
		// Enumerated because a `case` that fell through to `default` would
		// still render — as the raw enum value — and look merely untidy
		// rather than broken.
		expect(describeRunStatus("cancelled")).toEqual({ tone: "muted", text: "Cancelled" });
		expect(describeRunStatus("running")).toEqual({ tone: "ok", text: "Running" });
		expect(describeRunStatus("suspended")).toEqual({ tone: "warn", text: "Paused" });
	});
});

describe("describeRunPrincipal", () => {
	const run: DelegatedRun = {
		id: "r1",
		workflowName: "w",
		status: "success",
		runAsKind: "service",
		runAs: "svc-1",
		delegationId: "d1",
		startedAt: "2026-08-03T00:00:00.000Z",
		finishedAt: null,
		error: null,
		suspendedReason: null,
	};

	test("a service run names the ACCOUNT, never a bare id", () => {
		expect(describeRunPrincipal(run, { "svc-1": "nightly-bot" })).toBe("as nightly-bot");
	});

	test("an unnamed account degrades to a phrase, still not an id", () => {
		// An ordinary user cannot list service accounts (that read is
		// admin-only), so this is the normal path for them.
		expect(describeRunPrincipal(run, {})).toBe("as a service account");
	});

	test("a user run reads as `as you`", () => {
		expect(describeRunPrincipal({ ...run, runAsKind: "user", runAs: "u1" }, {})).toBe("as you");
	});

	test("a non-delegated run says so", () => {
		expect(describeRunPrincipal({ ...run, runAsKind: null, runAs: null }, {})).toBe("not delegated");
	});
});

// ── the HTTP wrappers ─────────────────────────────────────────────────

describe("the HTTP layer — the server's sentence survives to the caller", () => {
	const draft: ConsentDraft = {
		extensionId: "ext-1",
		jobRef: "job-1",
		workflowName: "ship-it",
		ownerKind: "user",
		ownerServiceAccountId: null,
		projectId: null,
		triggerKind: "cron",
		maxTokensPerRun: 5000,
		maxRunsPerDay: 24,
	};

	/** Records every call and answers with a scripted response. */
	function stubFetch(response: { ok: boolean; status?: number; body?: unknown }) {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = ((url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return Promise.resolve({
				ok: response.ok,
				status: response.status ?? (response.ok ? 200 : 400),
				json: () => Promise.resolve(response.body ?? {}),
			} as Response);
		}) as typeof fetch;
		return calls;
	}

	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("a refusal returns the route's OWN message, never a status line", () => {
		// §6.1's refusal names the reason and the remedy. Replacing it with
		// "403 Forbidden" is how a user ends up filing a bug against a
		// message that was already written for them.
		const named = "Choose “run as me”, or ask an admin to make the workflow system-visible.";
		stubFetch({ ok: false, status: 403, body: { error: named } });
		return submitConsent(draft).then((result) => {
			expect(result).toEqual({ ok: false, message: named });
		});
	});

	test("a refusal with NO message still says something useful", () => {
		stubFetch({ ok: false, status: 500, body: {} });
		return revokeDelegation("del-1").then((result) => {
			expect(result.ok).toBe(false);
			expect(result.ok === false && result.message).toContain("500");
		});
	});

	test("a network failure is reported, not thrown", () => {
		globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
		return loadDelegations().then((result) => {
			expect(result).toEqual({ ok: false, message: "offline" });
		});
	});

	test("a non-Error rejection is still reported as a string", () => {
		globalThis.fetch = (() => Promise.reject("boom")) as unknown as typeof fetch;
		return loadDelegatedRuns().then((result) => {
			expect(result).toEqual({ ok: false, message: "boom" });
		});
	});

	test("a success carries the parsed body through", () => {
		stubFetch({ ok: true, body: { delegations: [] } });
		return loadDelegations().then((result) => {
			expect(result).toEqual({ ok: true, value: { delegations: [] } });
		});
	});

	test("a body that is not JSON degrades instead of throwing", () => {
		globalThis.fetch = (() =>
			Promise.resolve({
				ok: false,
				status: 502,
				json: () => Promise.reject(new Error("not json")),
			} as unknown as Response)) as unknown as typeof fetch;
		return loadServiceAccounts().then((result) => {
			expect(result.ok).toBe(false);
			expect(result.ok === false && result.message).toContain("502");
		});
	});

	test("PATCH sends ONLY the bound it was given — the route's schema is strict", () => {
		// Phase 8a's body schema is `.strict()`, so ANY extra key is a 400.
		// A UI that posted a whole delegation object back would always fail.
		const calls = stubFetch({ ok: true, body: { delegation: {} } });
		return patchDelegationBounds("del-1", { maxTokensPerRun: 1234 }).then(() => {
			expect(calls[0]?.url).toBe("/api/workflows/delegations/del-1");
			expect(calls[0]?.init?.method).toBe("PATCH");
			expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ maxTokensPerRun: 1234 });
		});
	});

	test("an UNSET bound is OMITTED, not sent as a key", () => {
		// `.strict()` refuses a key it does not own, so an unset bound must
		// not appear at all. Building the body by omission rather than
		// leaning on `JSON.stringify` dropping `undefined` is what keeps this
		// true if the serializer ever changes.
		const calls = stubFetch({ ok: true, body: { delegation: {} } });
		return patchDelegationBounds("del-1", { maxRunsPerDay: 96 }).then(() => {
			const body = JSON.parse(String(calls[0]?.init?.body));
			expect(body).toEqual({ maxRunsPerDay: 96 });
			expect(Object.keys(body)).toEqual(["maxRunsPerDay"]);
		});
	});

	test("both bounds together are ONE request", () => {
		const calls = stubFetch({ ok: true, body: { delegation: {} } });
		return patchDelegationBounds("del-1", { maxTokensPerRun: 7, maxRunsPerDay: 3 }).then(() => {
			expect(calls).toHaveLength(1);
			expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
				maxTokensPerRun: 7,
				maxRunsPerDay: 3,
			});
		});
	});

	test("PATCH may LOWER a bound, not only raise it", () => {
		// The boundary ceiling re-reads from the DB every boundary, so a lower
		// cap takes effect on a run already in flight. Nothing here may imply
		// increase-only.
		const calls = stubFetch({ ok: true, body: { delegation: {} } });
		return patchDelegationBounds("del-1", { maxTokensPerRun: 1, maxRunsPerDay: 1 }).then(() => {
			expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
				maxTokensPerRun: 1,
				maxRunsPerDay: 1,
			});
		});
	});

	test("PATCH surfaces a 409's message verbatim — it carries disabled_reason", () => {
		const reason =
			"This delegation is disabled and its budget cannot be adjusted: owner lost access. Consent again to restore it.";
		stubFetch({ ok: false, status: 409, body: { error: reason } });
		return patchDelegationBounds("del-1", { maxTokensPerRun: 10 }).then((result) => {
			expect(result).toEqual({ ok: false, message: reason });
		});
	});

	test("the preview posts the owner selection and no bounds", () => {
		const calls = stubFetch({ ok: true, body: {} });
		return previewConsent({ ...draft, ownerKind: "service", ownerServiceAccountId: "svc-1" }).then(
			() => {
				const body = JSON.parse(String(calls[0]?.init?.body));
				expect(body).toMatchObject({ ownerKind: "service", ownerServiceAccountId: "svc-1" });
				// A preview asks what a delegation WOULD authorize; neither
				// ceiling changes that, and the route's schema is strict.
				expect(body).not.toHaveProperty("maxTokensPerRun");
				expect(body).not.toHaveProperty("maxRunsPerDay");
				expect(body).not.toHaveProperty("jobRef");
			},
		);
	});

	test("the preview's USER arm sends no account id", () => {
		const calls = stubFetch({ ok: true, body: {} });
		return previewConsent({ ...draft, ownerServiceAccountId: "svc-1" }).then(() => {
			expect(JSON.parse(String(calls[0]?.init?.body))).not.toHaveProperty(
				"ownerServiceAccountId",
			);
		});
	});

	test("consent POSTs to the delegations collection", () => {
		const calls = stubFetch({ ok: true, body: { delegation: {}, supersededId: null } });
		return submitConsent(draft).then(() => {
			expect(calls[0]?.url).toBe("/api/workflows/delegations");
			expect(calls[0]?.init?.method).toBe("POST");
		});
	});

	test("revoke DELETEs the row's own URL", () => {
		const calls = stubFetch({ ok: true, body: { revoked: true } });
		return revokeDelegation("del-9").then(() => {
			expect(calls[0]?.url).toBe("/api/workflows/delegations/del-9");
			expect(calls[0]?.init?.method).toBe("DELETE");
		});
	});

	test("the runs list reads its own route, not the SDK's", () => {
		// `readRuns` scopes to granted names AND an acting user, so a
		// delegated run is invisible there; this view has to be its own read.
		const calls = stubFetch({ ok: true, body: { runs: [] } });
		return loadDelegatedRuns().then(() => {
			expect(calls[0]?.url).toBe("/api/workflows/delegated-runs");
		});
	});

	test("service accounts are read from the session-gated list", () => {
		const calls = stubFetch({ ok: true, body: { accounts: [], reach: {} } });
		return loadServiceAccounts().then(() => {
			expect(calls[0]?.url).toBe("/api/service-accounts");
			// A plain GET. No body, no method override — the read is widened
			// on the server, not by asking for it differently here.
			expect(calls[0]?.init).toBeUndefined();
		});
	});

	test("the NARROW {id,name} shape a non-admin receives parses through unchanged", () => {
		// The widened read answers a non-admin with two fields per row and no
		// `enabled`. `send` must not invent the missing keys or drop the rows.
		const narrow = [{ id: "svc-1", name: "nightly" }];
		stubFetch({ ok: true, body: { accounts: narrow, reach: { code: "X" } } });
		return loadServiceAccounts().then((result) => {
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.accounts).toEqual(narrow);
			expect(result.value.accounts[0]).not.toHaveProperty("enabled");
		});
	});
});

describe("describeRunStopReason — keyed on suspended_reason, the value that arrives", () => {
	// REGRESSION GUARD. This classifier used to key on `run.error` and match
	// `DELEGATION_*` deny codes as substrings, and every branch was dead:
	// D7-D10 deny at dispatch and create no run row, and the two paths that
	// DO leave a row write a SUSPEND REASON. The tests below therefore assert
	// against `WorkflowSuspendReason` values, and a deny code must NOT be
	// classified — matching one again would be the old bug returning.

	test("a DELEGATION_* deny code is NOT classified — it never reaches this field", () => {
		// The exact strings the old dead implementation matched. A run row is
		// never created for any of them (workflows-handler.ts D7-D10), so if
		// one of these ever produced a sentence again, the classifier would
		// have been re-keyed onto a field the server does not populate.
		for (const deadCode of [
			"denied: DELEGATION_DAILY_TOKENS_EXCEEDED",
			"denied: DELEGATION_SPEND_EXCEEDED",
			"DELEGATION_QUOTA_EXCEEDED",
			"DELEGATION_CONSENT_STALE",
			"DELEGATION_OWNER_LOST_WORKFLOW_ACCESS",
		]) {
			expect(describeRunStopReason(deadCode)).toBeNull();
		}
	});

	test("the PER-RUN token ceiling points at the control that fixes it", () => {
		const text = describeRunStopReason("budget-exceeded");
		expect(text).toContain("per-run token limit");
		expect(text).toContain("raise that limit");
	});

	test("a stale consent says re-approve, and says a limit change will NOT clear it", () => {
		// PATCH does not write `consented_at`, so a budget change cannot
		// recover a consent-stale park.
		const text = describeRunStopReason("consent-stale");
		expect(text).toContain("Approve it again");
		expect(text).toContain("raising a limit will not clear this");
	});

	test("the two remedies never produce the same sentence", () => {
		// The whole reason this function exists: one is a number on this
		// page, the other is the consent dialog.
		expect(describeRunStopReason("budget-exceeded")).not.toBe(
			describeRunStopReason("consent-stale"),
		);
	});

	test("a parked approval reads as waiting on a person, not as a failure", () => {
		expect(describeRunStopReason("approval")).toContain("waiting for someone");
	});

	test("an expired approval says it cannot be resumed", () => {
		// `liveOnSuspendedRow: false` — the sweep terminalizes the run, so
		// offering a resume would be offering something that cannot happen.
		const text = describeRunStopReason("approval-timeout");
		expect(text).toContain("cannot be resumed");
	});

	test("a nested wait names the other workflow as the thing being waited on", () => {
		expect(describeRunStopReason("nested-suspended")).toContain("another workflow");
	});

	test("an orphaned run says explicitly that nothing is wrong", () => {
		// The recovery sweep sets this to mean "safe to continue". Rendering
		// it as a fault would send someone hunting a bug that is not there.
		expect(describeRunStopReason("orphaned-resumable")).toContain("Nothing is wrong");
	});

	test("an unrecognised reason yields NULL, so the raw value is shown instead", () => {
		// A reason written by a newer instance mid-rolling-deploy. Guessing
		// would be worse than repeating what the server actually said.
		expect(describeRunStopReason("some-future-reason")).toBeNull();
		expect(describeRunStopReason(null)).toBeNull();
	});

	// ── The pin that makes the dead-classifier defect unrepeatable ────────
	//
	// Every test above still hands this function a string chosen by hand,
	// which is EXACTLY how the previous implementation stayed green for
	// eight phases while being unreachable in production. These three do not
	// invent an input: they derive it from WORKFLOW_SUSPEND_REASONS, the
	// canonical vocabulary that `satisfies Record<WorkflowSuspendReason,
	// ResumeRule>` already forces to stay total. Add a seventh reason
	// without teaching the UI about it and these fail.

	test("every canonical suspend reason gets a sentence — none falls through", () => {
		const unexplained = WORKFLOW_SUSPEND_REASONS.filter(
			(reason) => describeRunStopReason(reason) === null,
		);
		expect(unexplained).toEqual([]);
	});

	test("each reason's sentence is DISTINCT — two reasons never read alike", () => {
		// `budget-exceeded` and `consent-stale` have opposite remedies, and
		// telling them apart is the whole reason this function exists.
		const sentences = WORKFLOW_SUSPEND_REASONS.map((r) => describeRunStopReason(r));
		expect(new Set(sentences).size).toBe(WORKFLOW_SUSPEND_REASONS.length);
	});

	test("every sentence is prose a person can act on, not a slug echo", () => {
		// Guards the lazy fix for the test above: returning the reason itself
		// would make every sentence distinct and non-null while explaining
		// nothing to anybody.
		const slugEchoes = WORKFLOW_SUSPEND_REASONS.filter((reason) => {
			const text = describeRunStopReason(reason) ?? "";
			return text.length < 30 || text === reason;
		});
		expect(slugEchoes).toEqual([]);
	});
});

describe("describeRunTime", () => {
	const now = new Date("2026-08-03T12:00:00.000Z");

	test("scans as a relative age, not an ISO string", () => {
		expect(describeRunTime("2026-08-03T11:59:30.000Z", now)).toBe("just now");
		expect(describeRunTime("2026-08-03T11:30:00.000Z", now)).toBe("30m ago");
		expect(describeRunTime("2026-08-03T09:00:00.000Z", now)).toBe("3h ago");
		expect(describeRunTime("2026-08-01T12:00:00.000Z", now)).toBe("2d ago");
	});

	test("past a week it becomes a date — relative stops helping", () => {
		expect(describeRunTime("2026-06-01T12:00:00.000Z", now)).not.toContain("ago");
	});

	test("an unparseable timestamp is shown VERBATIM rather than as `Invalid Date`", () => {
		expect(describeRunTime("not-a-date", now)).toBe("not-a-date");
	});

	test("a clock skewed into the future does not render a negative age", () => {
		expect(describeRunTime("2026-08-03T13:00:00.000Z", now)).not.toContain("-");
	});
});

describe("describeDelegationState — Ruling 4 keeps `enabled` in the predicate", () => {
	const live: Delegation = {
		id: "d1",
		extensionId: "e1",
		jobRef: "j1",
		ownerKind: "user",
		ownerId: "u1",
		workflowName: "w",
		definitionVersionId: null,
		projectId: null,
		triggerKind: "cron",
		triggerSpec: null,
		capabilitySet: [],
		maxTokensPerRun: 1,
		maxRunsPerDay: 1,
		enabled: true,
		disabledReason: null,
		consentedAt: "2026-08-03T00:00:00.000Z",
		consentedByUserId: "u1",
	};

	test("an enabled delegation reads as live", () => {
		expect(describeDelegationState(live)).toEqual({ live: true, text: "Live" });
	});

	test("a disabled one shows its RECORDED reason", () => {
		// `disabledReason` is the only thing a person ever sees explaining
		// why their unattended job went quiet.
		expect(
			describeDelegationState({ ...live, enabled: false, disabledReason: "owner lost access" }),
		).toEqual({ live: false, text: "owner lost access" });
	});

	test("a disabled one with no reason says THAT, rather than looking live", () => {
		expect(describeDelegationState({ ...live, enabled: false }).text).toContain(
			"No reason was recorded",
		);
	});
});

// ── the job → consent handoff ─────────────────────────────────────────
//
// `resolveGrantPrefill` is where a deep link stops being a URL and starts
// being form state, so it is the function a crafted link attacks. Every
// test below is the same property from a different side: a parameter is a
// SELECTOR over lists the page already loaded, never a value, and a
// selector that selects nothing is refused OUT LOUD.

describe("describeTriggerKind / TRIGGER_KIND_CHOICES", () => {
	test("the three kinds a delegation can be granted for get a human label", () => {
		expect(TRIGGER_KIND_CHOICES.map((c) => c.kind)).toEqual(["cron", "webhook", "event"]);
		expect(describeTriggerKind("cron")).toBe("On a schedule");
		expect(describeTriggerKind("webhook")).toBe("On a webhook");
		expect(describeTriggerKind("event")).toBe("On an event");
	});

	test("`manual` is NOT offerable — a human-started run spends no standing authority", () => {
		expect(TRIGGER_KIND_CHOICES.some((c) => c.kind === "manual")).toBe(false);
	});

	test("an unknown kind renders VERBATIM rather than as a blank", () => {
		// A row written by a newer instance must still describe itself: a
		// blank "Starts on" in the consent dialog is a field the reader
		// cannot check.
		expect(describeTriggerKind("quantum")).toBe("quantum");
	});
});

describe("resolveGrantPrefill — every parameter is a SELECTOR, not a value", () => {
	const sources = {
		extensions: [
			{ id: "ext-1", name: "ez-factory" },
			{ id: "ext-2", name: "nightly" },
		],
		workflowNames: ["ez-factory:docs-factory", "ship-it"],
		current: { extensionId: "", workflowName: "", jobRef: "", triggerKind: "cron" },
	};

	const link = (over: Record<string, string> = {}) =>
		new URLSearchParams({
			extensionId: "ez-factory",
			jobRef: "job-abc",
			workflowName: "ez-factory:docs-factory",
			triggerKind: "cron",
			...over,
		});

	test("a well-formed link fills in all four fields and refuses nothing", () => {
		const out = resolveGrantPrefill(link(), sources);
		expect(out).not.toBeNull();
		expect(out?.draft).toEqual({
			// Resolved to the INSTALL ROW ID, which is what the POST body
			// carries — the link only ever knew the name.
			extensionId: "ext-1",
			workflowName: "ez-factory:docs-factory",
			jobRef: "job-abc",
			triggerKind: "cron",
		});
		expect(out?.rejected).toEqual([]);
		expect(out?.applied).toEqual(["Extension", "Workflow", "Job reference", "Trigger"]);
	});

	test("an extension ID resolves too — the link is not forced to know a name", () => {
		const out = resolveGrantPrefill(link({ extensionId: "ext-2" }), sources);
		expect(out?.draft.extensionId).toBe("ext-2");
		expect(out?.rejected).toEqual([]);
	});

	test("an extension NOT on the delegatable list is refused, not written in", () => {
		// THE load-bearing one. The list is filtered to extensions an
		// administrator granted `allowDelegated`; a link naming anything
		// else must not be able to put it in the form, because the form is
		// what the consent dialog then previews and the route then trusts.
		const out = resolveGrantPrefill(link({ extensionId: "evil" }), sources);
		expect(out?.draft.extensionId).toBe("");
		expect(out?.applied).not.toContain("Extension");
		expect(out?.rejected.join(" ")).toContain("evil");
		expect(out?.rejected.join(" ")).toContain("allowed to run workflows on your behalf");
	});

	test("a workflow this session cannot see is refused, not written in", () => {
		const out = resolveGrantPrefill(link({ workflowName: "someone-elses-secret" }), sources);
		expect(out?.draft.workflowName).toBe("");
		expect(out?.applied).not.toContain("Workflow");
		expect(out?.rejected.join(" ")).toContain("someone-elses-secret");
	});

	test("a refused field keeps what the FORM already held — it is never blanked", () => {
		// Silently clearing a field the person had chosen would be its own
		// bug: they would press Review against a form that changed under
		// them because of a link somebody sent.
		const out = resolveGrantPrefill(link({ workflowName: "nope" }), {
			...sources,
			current: { ...sources.current, workflowName: "ship-it" },
		});
		expect(out?.draft.workflowName).toBe("ship-it");
	});

	test("a trigger kind outside the three is refused and the trigger is left alone", () => {
		const out = resolveGrantPrefill(link({ triggerKind: "manual" }), sources);
		expect(out?.draft.triggerKind).toBe("cron");
		expect(out?.rejected.join(" ")).toContain("not a trigger a delegation can be granted for");
	});

	test("an over-long job reference is refused rather than filling the page with it", () => {
		const huge = "x".repeat(MAX_JOB_REF_CHARS + 1);
		const out = resolveGrantPrefill(link({ jobRef: huge }), sources);
		expect(out?.draft.jobRef).toBe("");
		expect(out?.rejected.join(" ")).toContain(String(MAX_JOB_REF_CHARS));
		// The refusal does not echo the whole thing back at the reader.
		expect(out?.rejected.join(" ").length).toBeLessThan(huge.length);
	});

	test("a job reference exactly AT the bound is accepted — the edge is inclusive", () => {
		const atBound = "y".repeat(MAX_JOB_REF_CHARS);
		expect(resolveGrantPrefill(link({ jobRef: atBound }), sources)?.draft.jobRef).toBe(atBound);
	});

	test("an echoed refusal clips a long value so the sentence stays readable", () => {
		const out = resolveGrantPrefill(link({ extensionId: "z".repeat(300) }), sources);
		expect(out?.rejected[0]).toContain("…");
		expect(out?.rejected[0]?.length).toBeLessThan(200);
	});

	test("a job reference is trimmed — a link's stray whitespace is not part of the key", () => {
		expect(resolveGrantPrefill(link({ jobRef: "  job-abc  " }), sources)?.draft.jobRef).toBe(
			"job-abc",
		);
	});

	test("blank parameters are treated as absent, not as empty selections", () => {
		expect(resolveGrantPrefill(new URLSearchParams({ jobRef: "   " }), sources)).toBeNull();
	});

	test("no parameters at all returns null — an ordinary visit is untouched", () => {
		expect(resolveGrantPrefill(new URLSearchParams(), sources)).toBeNull();
		expect(resolveGrantPrefill(new URLSearchParams({ unrelated: "1" }), sources)).toBeNull();
	});

	test("a PARTIAL link fills in only what it named", () => {
		const out = resolveGrantPrefill(new URLSearchParams({ jobRef: "solo" }), sources);
		expect(out?.applied).toEqual(["Job reference"]);
		expect(out?.draft).toEqual({ ...sources.current, jobRef: "solo" });
	});

	test("the parameter names match the POST body's field names", () => {
		// One spelling for the link, the form and the wire. This is also
		// the contract `extensions/ez-factory/lib/page.ts` mirrors.
		expect(GRANT_PARAMS).toEqual({
			extensionId: "extensionId",
			workflowName: "workflowName",
			jobRef: "jobRef",
			triggerKind: "triggerKind",
		});
	});
});

describe("grantParams — 'grant this again' goes through the SAME resolver", () => {
	const delegation: Delegation = {
		id: "d1",
		extensionId: "ext-1",
		jobRef: "job-abc",
		ownerKind: "user",
		ownerId: "u1",
		workflowName: "ez-factory:docs-factory",
		definitionVersionId: null,
		projectId: null,
		triggerKind: "cron",
		triggerSpec: null,
		capabilitySet: [],
		maxTokensPerRun: 1,
		maxRunsPerDay: 1,
		enabled: false,
		disabledReason: "consent is stale",
		consentedAt: "2026-08-03T00:00:00.000Z",
		consentedByUserId: "u1",
	};
	const sources = {
		extensions: [{ id: "ext-1", name: "ez-factory" }],
		workflowNames: ["ez-factory:docs-factory"],
		current: { extensionId: "", workflowName: "", jobRef: "", triggerKind: "cron" },
	};

	test("a stale delegation re-seeds the grant form from its own four fields", () => {
		const out = resolveGrantPrefill(grantParams(delegation), sources);
		expect(out?.draft).toEqual({
			extensionId: "ext-1",
			workflowName: "ez-factory:docs-factory",
			jobRef: "job-abc",
			triggerKind: "cron",
		});
		expect(out?.rejected).toEqual([]);
	});

	test("re-granting onto a workflow that has since vanished says so", () => {
		// The reason this path shares the resolver at all. A bundled
		// extension's workflows ship inside the app image, so "the workflow
		// is not there any more" is a real post-upgrade state, and a form
		// silently seeded with an unselectable workflow would strand the
		// person on a disabled Review button with nothing explaining why.
		const out = resolveGrantPrefill(grantParams(delegation), { ...sources, workflowNames: [] });
		expect(out?.draft.workflowName).toBe("");
		expect(out?.rejected.join(" ")).toContain("ez-factory:docs-factory");
	});

	test("a reader of an unnamed key answers null, matching URLSearchParams", () => {
		expect(grantParams({ jobRef: "j" }).get("extensionId")).toBeNull();
		expect(grantParams({ jobRef: "j" }).get("jobRef")).toBe("j");
	});
});

describe("describeGrantPrefill — the note that says what filled the form in", () => {
	const filled: GrantPrefill = {
		draft: { extensionId: "e", workflowName: "w", jobRef: "j", triggerKind: "cron" },
		applied: ["Extension", "Workflow"],
		rejected: [],
	};

	test("names every field the prefill filled in", () => {
		const note = describeGrantPrefill(filled, "link");
		expect(note).toContain("Extension, Workflow");
		// And it says the thing that makes the whole handoff safe to follow.
		expect(note).toContain("nothing is granted until you approve it");
	});

	test("the two sources are named APART — provenance is the whole point", () => {
		// Telling somebody re-granting their own delegation that the values
		// came "from the link you followed" is a small lie about provenance
		// on the one surface whose job is being exact about it.
		expect(describeGrantPrefill(filled, "link")).toContain("link you followed");
		const regrant = describeGrantPrefill(filled, "delegation");
		expect(regrant).toContain("delegation you are granting again");
		expect(regrant).not.toContain("link");
	});

	test("a prefill that filled in NOTHING gets no note — an empty banner is noise", () => {
		expect(
			describeGrantPrefill(
				{
					draft: { extensionId: "", workflowName: "", jobRef: "", triggerKind: "cron" },
					applied: [],
					rejected: ["nope"],
				},
				"link",
			),
		).toBeNull();
	});
});
