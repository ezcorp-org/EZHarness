/**
 * DOM tests for `DelegationConsentDialog.svelte` — the one place standing
 * authority is ever minted.
 *
 * Phase 8b shipped this component with no component test at all, which is
 * why `check-new-file-coverage.ts` was the one red gate on the branch. It is
 * closed by COVERING the file, never by relaxing the gate: there is no
 * threshold change, no EXCLUDES entry and no skipped test below.
 *
 * What is worth proving here rather than in the e2e spec — the e2e proves the
 * dialog is REACHABLE and renders; these prove the decisions inside it:
 *
 *   - **Nothing is pre-approved.** Both bounds start empty, approve is
 *     disabled, and the REASON is on screen next to it. A consent dialog whose
 *     primary action is disabled with no visible explanation is a dead end.
 *   - **Server-derived text is rendered, never re-composed.** The reach
 *     warning and the §6.1 refusal are byte-compared against what the fake
 *     server returned.
 *   - **The owner is a hash input**, so changing it RE-PREVIEWS, and a stale
 *     in-flight answer for the previous owner is discarded rather than shown.
 *   - **The picker consumes the widened read.** A row with no `enabled` field
 *     — which is every row a non-admin now receives — is SELECTABLE. Testing
 *     `!account.enabled` instead of `=== false` would grey out every option
 *     for exactly the people the widening was for, and nothing else in the
 *     suite would notice.
 *
 * `previewConsent` and `submitConsent` are the only fakes; every pure helper
 * (`consentBlockedReason`, `summarizeCapabilities`, `diffCapabilities`,
 * `tokenBoundExclusions`, `reachWarningFor`) is the REAL one, so the strings
 * asserted below are the strings the module actually produces.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";

const http = vi.hoisted(() => ({ previewConsent: vi.fn(), submitConsent: vi.fn() }));

vi.mock("$lib/workflow-delegations-logic", async (importActual) => {
  const actual = await importActual<typeof import("$lib/workflow-delegations-logic")>();
  return { ...actual, previewConsent: http.previewConsent, submitConsent: http.submitConsent };
});

const DelegationConsentDialog = (await import("./DelegationConsentDialog.svelte")).default;
import type {
  ConsentPreview,
  Delegation,
  ServiceAccountOption,
} from "$lib/workflow-delegations-logic";

const REACH_MESSAGE =
  "A service account has no user identity, so it can only be delegated workflows whose " +
  "visibility is one of: system.";

const PREVIEW: ConsentPreview = {
  material: {
    v: 1,
    extensionName: "nightly",
    workflowName: "ship-it",
    projectId: null,
    runAs: { kind: "user", id: "u1" },
    trigger: { kind: "cron", spec: null },
    graph: [
      {
        name: "ship-it",
        identity: "version:v1@3",
        defaultModel: "null",
        steps: [
          { name: "draft", kind: "agent", when: "null", skipDependents: true, model: "null" },
          {
            name: "publish",
            kind: "tool",
            when: JSON.stringify("inputs.confirm == true"),
            // `false` is the sharp edge the dialog calls out: a skipped step
            // does NOT skip what depends on it.
            skipDependents: false,
            model: "null",
          },
        ],
        capabilities: ["agent::writer", "shell::"],
      },
      {
        name: "notify",
        identity: "version:v2@1",
        defaultModel: "null",
        steps: [],
        capabilities: ["net::https://hooks.example"],
      },
    ],
    unresolved: ["missing-one"],
    cycles: ["a → b → a"],
    tooDeep: ["deep-one"],
  },
  capabilitySet: [{ kind: "agent", value: "writer" }],
  consentHash: "hash-1",
  definitionVersionId: "v1",
  effortNoops: [
    {
      workflowName: "ship-it",
      stepName: "draft",
      provider: "ollama",
      model: "llama3",
      effort: "high",
    },
  ],
  maxToolCallsPerRun: 100,
  maxNestingDepth: 3,
  reach: {
    code: "SERVICE_ACCOUNT_SYSTEM_ONLY",
    runnableVisibilities: ["system"],
    message: REACH_MESSAGE,
  },
};

/** A preview with no capabilities and no problems — the quiet workflow. */
const BARE_PREVIEW: ConsentPreview = {
  ...PREVIEW,
  material: {
    ...PREVIEW.material,
    graph: [{ name: "ship-it", identity: "v1", defaultModel: "null", steps: [], capabilities: [] }],
    unresolved: [],
    cycles: [],
    tooDeep: [],
  },
  effortNoops: [],
};

const DELEGATION = { id: "del-1", workflowName: "ship-it" } as unknown as Delegation;

const PROPS = {
  extensionId: "ext-nightly",
  extensionName: "nightly",
  jobRef: "nightly-ship",
  workflowName: "ship-it",
  triggerKind: "cron",
};

beforeEach(() => {
  http.previewConsent.mockReset().mockResolvedValue({ ok: true, value: PREVIEW });
  http.submitConsent.mockReset().mockResolvedValue({ ok: true, value: { delegation: DELEGATION } });
});

function mount(over: Record<string, unknown> = {}) {
  const onclose = vi.fn();
  const ondone = vi.fn();
  const utils = render(DelegationConsentDialog, {
    props: { ...PROPS, onclose, ondone, ...over },
  });
  return { ...utils, onclose, ondone };
}

/** Fill both bounds so the primary action becomes reachable. */
async function setBothBounds(getByTestId: (id: string) => HTMLElement) {
  await fireEvent.input(getByTestId("max-tokens-per-run"), { target: { value: "200000" } });
  await fireEvent.input(getByTestId("max-runs-per-day"), { target: { value: "24" } });
}

describe("what the dialog shows once the preview lands", () => {
  test("the capability set, attributed to the definition that contributes it", async () => {
    const { getByTestId, findByTestId, getAllByTestId } = mount();
    await findByTestId("capability-diff");

    const diff = getByTestId("capability-diff");
    expect(diff).toHaveTextContent("shell");
    // Attribution: a capability contributed by a NESTED definition names it,
    // so "a workflow you never opened can reach the network" is visible.
    expect(diff).toHaveTextContent("via notify");
    expect(getAllByTestId("capability-row")).toHaveLength(3);
    expect(diff).toHaveTextContent("What this job will be able to do");
  });

  test("a `when`-guarded step, and the fact that its dependents still run", async () => {
    const { findByTestId } = mount();
    const step = await findByTestId("conditional-step");
    expect(step).toHaveTextContent("ship-it.publish");
    expect(step).toHaveTextContent("inputs.confirm == true");
    expect(step).toHaveTextContent("steps that depend on it still run when it is skipped");
  });

  test("every closure problem the material reports", async () => {
    const { findByTestId, getByTestId } = mount();
    await findByTestId("closure-warnings");
    expect(getByTestId("closure-warning-unresolved")).toHaveTextContent("could not be resolved");
    expect(getByTestId("closure-warning-cycles")).toHaveTextContent("call each other in a loop");
    expect(getByTestId("closure-warning-too-deep")).toHaveTextContent("Nested deeper");
  });

  test("all THREE token-bound exclusions — the feature's honesty requirement", async () => {
    const { findByTestId, getByTestId } = mount();
    await findByTestId("token-bound-exclusions");
    expect(getByTestId("exclusion-tool-steps")).toHaveTextContent("100 tool calls per run");
    expect(getByTestId("exclusion-nested-runs")).toHaveTextContent("at most 3");
    expect(getByTestId("exclusion-effort-noop")).toHaveTextContent("ship-it.draft");
  });

  test("RULING 3 — no cents field is shown or collected anywhere", async () => {
    const { findByTestId, getByTestId } = mount();
    await findByTestId("capability-diff");
    const dialog = getByTestId("delegation-consent");
    expect(dialog.textContent).not.toContain("$");
    expect(dialog.textContent).not.toContain("cents");
  });

  test("a workflow that reaches nothing says so rather than rendering an empty list", async () => {
    http.previewConsent.mockResolvedValue({ ok: true, value: BARE_PREVIEW });
    const { findByTestId, queryByTestId } = mount();
    await findByTestId("no-capabilities");
    // …and the sections with nothing to report are absent, not empty boxes.
    expect(queryByTestId("conditional-steps")).toBeNull();
    expect(queryByTestId("closure-warnings")).toBeNull();
  });

  test("while the first preview is in flight, it says what it is waiting for", async () => {
    let resolve!: (v: unknown) => void;
    http.previewConsent.mockReturnValue(new Promise((r) => (resolve = r)));
    const { getByTestId, findByTestId } = mount();
    expect(getByTestId("preview-loading")).toBeInTheDocument();
    // The blocked reason names the WAIT, not the missing bounds — reporting
    // "set a token limit" under a spinner asks for input that cannot help.
    expect(getByTestId("consent-blocked-reason")).toHaveTextContent("Loading what this job");
    resolve({ ok: true, value: PREVIEW });
    await findByTestId("capability-diff");
  });
});

describe("the capability DIFF on a re-consent", () => {
  const previous = [
    { kind: "agent", value: "writer", fromWorkflows: ["ship-it"], sensitive: false },
    { kind: "fs", value: "/etc", fromWorkflows: ["ship-it"], sensitive: true },
  ];

  test("what is newly allowed and what is no longer allowed, separately", async () => {
    const { findByTestId, getByTestId } = mount({ previousCapabilities: previous });
    const diff = await findByTestId("capability-diff");
    expect(diff).toHaveTextContent("What changes");
    expect(diff).toHaveTextContent("Newly allowed");
    expect(diff).toHaveTextContent("No longer allowed");
    // The removed one is struck through, the added sensitive one emphasised.
    expect(getByTestId("capability-diff").textContent).toContain("/etc");
  });

  test("a re-consent that changes NOTHING says exactly that", async () => {
    // Ruling 2 re-asks on ANY edit, including one that moves no capability.
    // Saying so plainly is what lets a person approve quickly HERE without
    // learning to approve everything quickly.
    http.previewConsent.mockResolvedValue({ ok: true, value: BARE_PREVIEW });
    const { findByTestId } = mount({ previousCapabilities: [] });
    expect(await findByTestId("diff-unchanged")).toHaveTextContent(
      "Nothing about what this job can do has changed",
    );
  });
});

describe("the owner-kind picker (Ruling 1)", () => {
  test("both kinds are offered, and 'run as me' is the one that starts selected", async () => {
    const { findByTestId, getByTestId } = mount();
    await findByTestId("capability-diff");
    expect(getByTestId("owner-kind-user")).toBeChecked();
    expect(getByTestId("owner-kind-service")).not.toBeChecked();
    // Nothing to warn about while running as yourself.
    expect(
      getByTestId("owner-kind-picker").querySelector('[data-testid="reach-warning"]'),
    ).toBeNull();
  });

  test("choosing a service account surfaces the SERVER's reach sentence, verbatim", async () => {
    const { findByTestId, getByTestId } = mount();
    await findByTestId("capability-diff");
    await fireEvent.change(getByTestId("owner-kind-service"));
    // Byte-for-byte. The module refuses to compose its own sentence about
    // what a service account can reach; this is what pins that.
    expect(getByTestId("reach-warning")).toHaveTextContent(REACH_MESSAGE);
  });

  test("the reach warning is LATCHED — it survives having no account chosen", async () => {
    // Deriving it from `preview` made it vanish in the one situation that
    // needs it most: switching to `service` clears the preview (there is no
    // principal to preview yet), which took the warning down with it.
    const { findByTestId, getByTestId, queryByTestId } = mount();
    await findByTestId("capability-diff");
    await fireEvent.change(getByTestId("owner-kind-service"));
    expect(queryByTestId("capability-diff")).toBeNull();
    expect(getByTestId("reach-warning")).toHaveTextContent(REACH_MESSAGE);
  });

  test("an instance with no service account says so instead of an empty dropdown", async () => {
    const { findByTestId, getByTestId, queryByTestId } = mount();
    await findByTestId("capability-diff");
    await fireEvent.change(getByTestId("owner-kind-service"));
    expect(getByTestId("no-service-accounts")).toHaveTextContent("no service account switched on");
    expect(queryByTestId("service-account-select")).toBeNull();
  });

  test("a row with NO `enabled` field — the narrow read — is SELECTABLE", async () => {
    // THE regression this widening can produce. A non-admin's rows carry
    // `{id, name}` and nothing else; `disabled={!account.enabled}` would grey
    // every one of them out and the picker would look broken to exactly the
    // callers it was widened for.
    const narrow: ServiceAccountOption[] = [{ id: "svc-1", name: "nightly-runner" }];
    const { findByTestId, getByTestId } = mount({ serviceAccounts: narrow });
    await findByTestId("capability-diff");
    await fireEvent.change(getByTestId("owner-kind-service"));

    const select = getByTestId("service-account-select") as HTMLSelectElement;
    const option = [...select.options].find((o) => o.textContent?.includes("nightly-runner"))!;
    expect(option.disabled).toBe(false);
    expect(option.textContent).not.toContain("(disabled)");
  });

  test("an admin's DISABLED row is unselectable and says why", async () => {
    // The other side of the same predicate: an admin does receive `enabled`,
    // and `false` must still mean unselectable.
    const wide: ServiceAccountOption[] = [
      { id: "svc-1", name: "live-one", enabled: true },
      { id: "svc-2", name: "off-one", enabled: false },
    ];
    const { findByTestId, getByTestId } = mount({ serviceAccounts: wide });
    await findByTestId("capability-diff");
    await fireEvent.change(getByTestId("owner-kind-service"));

    const select = getByTestId("service-account-select") as HTMLSelectElement;
    const live = [...select.options].find((o) => o.textContent?.includes("live-one"))!;
    const off = [...select.options].find((o) => o.textContent?.includes("off-one"))!;
    expect(live.disabled).toBe(false);
    expect(off.disabled).toBe(true);
    expect(off.textContent).toContain("(disabled)");
  });

  test("switching back to 'run as me' clears the chosen account and re-previews", async () => {
    const { findByTestId, getByTestId } = mount({
      serviceAccounts: [{ id: "svc-1", name: "runner" }],
    });
    await findByTestId("capability-diff");
    await fireEvent.change(getByTestId("owner-kind-service"));
    await fireEvent.change(getByTestId("service-account-select"), { target: { value: "svc-1" } });
    await waitFor(() =>
      expect(http.previewConsent).toHaveBeenCalledWith(
        expect.objectContaining({ ownerKind: "service", ownerServiceAccountId: "svc-1" }),
      ),
    );

    await fireEvent.change(getByTestId("owner-kind-user"));
    await waitFor(() =>
      expect(http.previewConsent).toHaveBeenLastCalledWith(
        expect.objectContaining({ ownerKind: "user", ownerServiceAccountId: null }),
      ),
    );
  });

  test("the preview asks for NO bounds — they do not change what is authorized", async () => {
    const { findByTestId } = mount();
    await findByTestId("capability-diff");
    const asked = http.previewConsent.mock.calls.at(-1)![0];
    expect(asked.maxTokensPerRun).toBeNull();
    expect(asked.maxRunsPerDay).toBeNull();
  });

  test("a STALE in-flight preview for the previous owner is discarded", async () => {
    // Switching owner while the first answer is still in flight must not let
    // the old answer land: it describes a principal the person has moved off.
    let resolveFirst!: (v: unknown) => void;
    http.previewConsent
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      .mockResolvedValue({ ok: true, value: BARE_PREVIEW });

    const { getByTestId, findByTestId, queryByTestId } = mount({
      serviceAccounts: [{ id: "svc-1", name: "runner" }],
    });
    await fireEvent.change(getByTestId("owner-kind-service"));
    await fireEvent.change(getByTestId("service-account-select"), { target: { value: "svc-1" } });
    await findByTestId("no-capabilities");

    // The first, now-cancelled promise settles LAST and must change nothing.
    resolveFirst({ ok: true, value: PREVIEW });
    await Promise.resolve();
    expect(queryByTestId("no-capabilities")).toBeInTheDocument();
    expect(queryByTestId("conditional-step")).toBeNull();
  });
});

describe("the refusal path (§6.1)", () => {
  const REFUSAL =
    "This workflow is project-visible, and a service account can only run system-visible " +
    'workflows. Choose "run as me", or ask an admin to make the workflow system-visible.';

  test("the server's sentence reaches the human, and approve stays disabled", async () => {
    http.previewConsent.mockResolvedValue({ ok: false, message: REFUSAL });
    const { findByTestId, getByTestId } = mount();
    // Not a bare 403: the message names the reason AND both remedies.
    expect(await findByTestId("consent-refused")).toHaveTextContent(REFUSAL);
    expect(getByTestId("consent-approve")).toBeDisabled();
    // The reason next to the button is the refusal itself, not "loading".
    expect(getByTestId("consent-blocked-reason")).toHaveTextContent(REFUSAL);
    // The picker is still on screen, so the remedy is one click away.
    expect(getByTestId("owner-kind-picker")).toBeInTheDocument();
  });

  test("a refusal clears the previous answer rather than leaving it on screen", async () => {
    const { findByTestId, getByTestId, queryByTestId } = mount({
      serviceAccounts: [{ id: "svc-1", name: "runner" }],
    });
    await findByTestId("capability-diff");
    http.previewConsent.mockResolvedValue({ ok: false, message: REFUSAL });
    await fireEvent.change(getByTestId("owner-kind-service"));
    await fireEvent.change(getByTestId("service-account-select"), { target: { value: "svc-1" } });
    await findByTestId("consent-refused");
    expect(queryByTestId("capability-diff")).toBeNull();
  });
});

describe("nothing is pre-approved", () => {
  test("approve is disabled until BOTH bounds are set, with the reason on screen", async () => {
    const { findByTestId, getByTestId } = mount();
    await findByTestId("capability-diff");

    const approve = getByTestId("consent-approve");
    expect(approve).toBeDisabled();
    expect(getByTestId("consent-blocked-reason")).toHaveTextContent("Set a token limit per run");

    await fireEvent.input(getByTestId("max-tokens-per-run"), { target: { value: "200000" } });
    expect(approve).toBeDisabled();
    expect(getByTestId("consent-blocked-reason")).toHaveTextContent(
      "maximum number of runs per day",
    );

    await fireEvent.input(getByTestId("max-runs-per-day"), { target: { value: "24" } });
    expect(approve).toBeEnabled();
    expect(getByTestId("consent-blocked-reason")).toHaveTextContent("");
  });

  test("clearing a bound blocks it again — an emptied field is not zero", async () => {
    const { findByTestId, getByTestId } = mount();
    await findByTestId("capability-diff");
    await setBothBounds(getByTestId);
    expect(getByTestId("consent-approve")).toBeEnabled();

    await fireEvent.input(getByTestId("max-tokens-per-run"), { target: { value: "" } });
    expect(getByTestId("consent-approve")).toBeDisabled();
    expect(getByTestId("consent-blocked-reason")).toHaveTextContent("Set a token limit per run");
  });

  test("choosing 'service account' with none selected names THAT, not 'loading'", async () => {
    // Reporting a wait that is never going to end instead of the choice that
    // is missing is the specific failure this ordering prevents.
    const { findByTestId, getByTestId } = mount({
      serviceAccounts: [{ id: "svc-1", name: "runner" }],
    });
    await findByTestId("capability-diff");
    await setBothBounds(getByTestId);
    await fireEvent.change(getByTestId("owner-kind-service"));
    expect(getByTestId("consent-blocked-reason")).toHaveTextContent("Choose a service account");
    expect(getByTestId("consent-approve")).toBeDisabled();
  });
});

describe("approving", () => {
  test("the draft that is submitted is the one on screen", async () => {
    const { findByTestId, getByTestId, ondone } = mount({
      serviceAccounts: [{ id: "svc-1", name: "runner" }],
    });
    await findByTestId("capability-diff");
    await fireEvent.change(getByTestId("owner-kind-service"));
    await fireEvent.change(getByTestId("service-account-select"), { target: { value: "svc-1" } });
    await findByTestId("capability-diff");
    await setBothBounds(getByTestId);

    await fireEvent.click(getByTestId("consent-approve"));
    await waitFor(() => expect(ondone).toHaveBeenCalledWith(DELEGATION));
    expect(http.submitConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId: "ext-nightly",
        jobRef: "nightly-ship",
        workflowName: "ship-it",
        ownerKind: "service",
        ownerServiceAccountId: "svc-1",
        maxTokensPerRun: 200000,
        maxRunsPerDay: 24,
      }),
    );
  });

  test("a failed submit shows the server's message and does NOT report success", async () => {
    http.submitConsent.mockResolvedValue({ ok: false, message: "Somebody else already consented" });
    const { findByTestId, getByTestId, ondone } = mount();
    await findByTestId("capability-diff");
    await setBothBounds(getByTestId);
    await fireEvent.click(getByTestId("consent-approve"));

    expect(await findByTestId("consent-submit-error")).toHaveTextContent(
      "Somebody else already consented",
    );
    expect(ondone).not.toHaveBeenCalled();
    // Still usable: the dialog does not become a dead end after one failure.
    expect(getByTestId("consent-approve")).toBeEnabled();
  });

  test("while submitting, both buttons are held and the label says so", async () => {
    let resolve!: (v: unknown) => void;
    http.submitConsent.mockReturnValue(new Promise((r) => (resolve = r)));
    const { findByTestId, getByTestId } = mount();
    await findByTestId("capability-diff");
    await setBothBounds(getByTestId);
    await fireEvent.click(getByTestId("consent-approve"));

    expect(getByTestId("consent-approve")).toHaveTextContent("Approving…");
    expect(getByTestId("consent-approve")).toBeDisabled();
    // Cancel too — a close mid-submit would leave the caller unsure whether
    // authority was minted.
    expect(getByTestId("consent-cancel")).toBeDisabled();
    resolve({ ok: true, value: { delegation: DELEGATION } });
  });

  test("a bound emptied in the SAME tick as the click still refuses to submit", async () => {
    // The guard inside `approve()` is not redundant with the disabled
    // attribute: the attribute is flushed asynchronously, so a click landing
    // between the state change and the flush reaches the handler with a
    // button the DOM still calls enabled. Driven with raw DOM events on
    // purpose — `fireEvent` awaits a tick and would hide the race.
    const { findByTestId, getByTestId } = mount();
    await findByTestId("capability-diff");
    await setBothBounds(getByTestId);
    expect(getByTestId("consent-approve")).toBeEnabled();

    const tokens = getByTestId("max-tokens-per-run") as HTMLInputElement;
    tokens.value = "";
    tokens.dispatchEvent(new Event("input", { bubbles: true }));
    (getByTestId("consent-approve") as HTMLButtonElement).click();

    await Promise.resolve();
    expect(http.submitConsent).not.toHaveBeenCalled();
  });
});

describe("the dialog is not a trap", () => {
  test("Escape closes it; another key does not", async () => {
    const { findByTestId, getByTestId, onclose } = mount();
    await findByTestId("capability-diff");
    const overlay = getByTestId("delegation-consent").parentElement!;

    await fireEvent.keyDown(overlay, { key: "a" });
    expect(onclose).not.toHaveBeenCalled();
    await fireEvent.keyDown(overlay, { key: "Escape" });
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  test("clicking the backdrop closes it; clicking INSIDE the dialog does not", async () => {
    const { findByTestId, getByTestId, onclose } = mount();
    await findByTestId("capability-diff");
    const panel = getByTestId("delegation-consent");

    await fireEvent.click(panel);
    expect(onclose).not.toHaveBeenCalled();
    await fireEvent.click(panel.parentElement!);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  test("Cancel closes it without submitting anything", async () => {
    const { findByTestId, getByTestId, onclose } = mount();
    await findByTestId("capability-diff");
    await fireEvent.click(getByTestId("consent-cancel"));
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(http.submitConsent).not.toHaveBeenCalled();
  });
});
