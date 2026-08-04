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
import { test, expect, describe } from "vitest";
import {
	OWNER_KIND_CHOICES,
	buildConsentBody,
	closureWarnings,
	conditionalSteps,
	consentBlockedReason,
	decodeCanonical,
	describeDelegationState,
	describeEffortNoopSteps,
	describeRunPrincipal,
	describeRunStatus,
	diffCapabilities,
	parseCapabilityKey,
	reachWarningFor,
	summarizeCapabilities,
	tokenBoundExclusions,
	type ConsentDraft,
	type ConsentHashMaterial,
	type Delegation,
	type DelegatedRun,
	type EffortNoop,
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
