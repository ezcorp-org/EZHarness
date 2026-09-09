/**
 * Dry-run a workflow: evaluate everything that is PURE, stand a stub in
 * for everything that is not, and touch nothing outside this process.
 *
 * ## Why "zero side effects" is structural here, not conventional
 *
 * The obvious implementation skips `agent` and `tool` steps by kind. That
 * relies on the skip list staying correct forever — and C7 is about to
 * add a `workflow` step kind that recursively contains tool steps, at
 * which point a stale skip list dispatches a real tool during what the
 * user was told is a dry run.
 *
 * So this harness never skips. It makes dispatch IMPOSSIBLE, three ways,
 * none of which depends on a list being right:
 *
 *   1. **The tool runner factory throws.** `WorkflowExecutor` builds the
 *      runner lazily via `toolRunnerFactory`; ours raises
 *      {@link WorkflowDryRunViolation}. A tool step that somehow reaches
 *      dispatch fails loudly instead of executing.
 *   2. **`runAgent` throws.** The `AgentExecutor` handed to the executor
 *      is {@link dryRunAgentExecutor}, whose `runAgent` raises the same
 *      violation. Zero LLM is a property of the object graph, not of a
 *      branch.
 *   3. **`persist: false`, asserted explicitly** rather than inherited
 *      from the default, so no `workflow_runs` row is written.
 *
 * Add a private bus nobody subscribes to and the run cannot reach the
 * filesystem, the network, an LLM, the DB, or an SSE client — because the
 * objects that could do those things are not present.
 *
 * {@link isPureDryRunKind} is then an ALLOW list of kinds we can evaluate
 * honestly, not a deny list of kinds to skip. A kind nobody has taught it
 * about is substituted, which is the safe default; the three guarantees
 * above are the backstop if that is ever wrong.
 *
 * ## What a dry run can and cannot tell you
 *
 * `transform` and `gate` steps run for real, so ref errors and template
 * mistakes against real data are caught. Refs INTO a stubbed step
 * resolve to {@link dryRunStub}, which answers any path — they have to,
 * because an agent's output shape is not knowable statically and the
 * strict resolver would otherwise fail every graph at its first
 * downstream ref. The honest consequence: a dry run cannot validate a ref
 * into an `agent`/`tool` result, only refs into steps it actually
 * evaluated.
 *
 * ## A gate over fabricated operands is NOT enforced
 *
 * The stub answers every path, so `exists`, `truthy`, `neq` and
 * `not(eq)` — the commonest shapes over an agent's output — all hold
 * against it, and `eq` against a literal never does. Enforcing either
 * answer would be reporting a verdict about data nobody produced: green
 * because a Proxy exists, or red because a Proxy is not `"ok"`. Neither
 * is a fact about the workflow, and the green one is the more dangerous
 * because it looks like a pass.
 *
 * So a gate whose operands are stub-derived is **evaluated, recorded and
 * not enforced**: its verdict lands in {@link DryRunReport.gatesOnStubs},
 * the step reports `mode: "evaluated-on-stubs"`, the run CONTINUES so the
 * rest of the graph is still checked, and the report's status is
 * downgraded to {@link DRY_RUN_UNVERIFIED} so it can never be read as a
 * clean pass. A gate over deterministic operands (`$input.*`, a
 * `transform` over real data) is enforced exactly as built — that is the
 * useful half of the feature and it is unchanged.
 */
import type {
  AgentEvents,
  AgentResult,
  WorkflowCondition,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepKind,
} from "../types";
import type { AgentExecutor } from "./executor";
import { EventBus } from "./events";
import { WorkflowExecutor } from "./workflow-executor";
import { conditionRefs, evaluateCondition } from "./workflow-condition";
import { resolveConditionRef, type RefContext } from "./workflow-refs";
import { stepKind } from "./workflow-validator";

const pureExecutors = new WeakSet<WorkflowExecutor>();

export function isPureWorkflowExecutor(executor: WorkflowExecutor): boolean {
  return pureExecutors.has(executor);
}

/**
 * A dry run reached something that would have had a real effect.
 *
 * Never expected. If this is ever thrown, the allow list below and the
 * executor's dispatch have diverged — which is exactly the condition the
 * three structural guarantees exist to make loud instead of silent.
 */
export class WorkflowDryRunViolation extends Error {
  constructor(what: string) {
    super(
      `Dry run attempted a real ${what}. A dry run must never dispatch — ` +
        "this is a bug in the dry-run harness, not in the workflow.",
    );
    this.name = "WorkflowDryRunViolation";
  }
}

/**
 * Step kinds a dry run can evaluate HONESTLY — no LLM, no I/O, no clock.
 *
 * An allow list, deliberately. Everything not named here is substituted,
 * so a step kind added by a later phase is stubbed by default rather than
 * dispatched. Compare a deny list, which would dispatch anything it had
 * not been told to skip.
 */
export function isPureDryRunKind(kind: WorkflowStepKind): boolean {
  return kind === "transform" || kind === "gate";
}

/** Marks a value produced by the dry run rather than by a real step. */
export const DRY_RUN_STUB_MARKER = "__ezDryRunStub";

/**
 * A value that resolves any property path to another stub.
 *
 * Needed because the ref resolver is STRICT: `$steps.draft.output.title`
 * throws when `title` is missing (`workflow-refs.ts`). A plain `{}` stub
 * would therefore make every dry run fail at its first downstream ref
 * into a stubbed step, which is most real graphs.
 *
 * Implemented as a Proxy because `getNestedValue` gates each hop on
 * `Object.hasOwn`, which routes through the `getOwnPropertyDescriptor`
 * trap. The proxy invariants hold because the target is extensible and
 * every reported descriptor is configurable.
 *
 * The target must stay an OBJECT, not a function: `getNestedValue` bails
 * on `typeof current !== "object"`, so a callable target would make every
 * path resolve to `undefined` and defeat the whole point. The visible
 * cost is that `interpolateTemplate` routes objects through
 * `JSON.stringify`, so a stub inside a `{{…}}` template renders QUOTED
 * (`"«draft.output.text»"`). That is cosmetic and still says exactly
 * which unrun step the value came from — worth more than an unquoted
 * `{}`, which is what dropping the `toJSON` trap would produce.
 */
export function dryRunStub(label: string): Record<string, unknown> {
  const describe = (): string => `«${label}»`;
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      // Let the well-known coercion/serialization hooks answer as a
      // STRING, so a stub interpolated into a `{{…}}` template renders
      // «step» rather than throwing or printing [object Object].
      if (prop === Symbol.toPrimitive || prop === "toString" || prop === "toJSON") {
        return describe;
      }
      if (prop === DRY_RUN_STUB_MARKER) return true;
      if (typeof prop === "symbol") return undefined;
      return dryRunStub(`${label}.${prop}`);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      return { configurable: true, enumerable: true, value: dryRunStub(`${label}.${prop}`) };
    },
    has: () => true,
    ownKeys: () => [],
  };
  return new Proxy({}, handler);
}

/** True when `value` came from {@link dryRunStub}. */
export function isDryRunStub(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[DRY_RUN_STUB_MARKER] === true
  );
}

/**
 * True when `value` IS a stub, or carries one anywhere inside it.
 *
 * A stub does not stay at the top level: a `transform` that copies
 * `$steps.draft.output.text` into its own `output` hands it onward as a
 * member of an otherwise-real object, and a gate reading THAT object is
 * still gating on fabricated data. So the check has to be deep, or
 * laundering a stub through one transform would buy back the false green.
 *
 * Recursion terminates on a stub without the marker check even firing:
 * the proxy reports no own keys, the same property {@link renderStubs}
 * relies on.
 */
export function containsDryRunStub(value: unknown): boolean {
  if (isDryRunStub(value)) return true;
  if (Array.isArray(value)) return value.some(containsDryRunStub);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsDryRunStub);
  }
  return false;
}

/**
 * Told when a guarantee fired, so {@link dryRunWorkflow} can re-throw the
 * violation instead of letting the executor's per-step catch launder it
 * into an ordinary run failure.
 *
 * Recorded AT THE THROW SITE rather than recovered from the run's error
 * text, because the throw does not survive the trip: `runToolStep` wraps
 * whatever its dispatch raised in `Step "<name>" failed: …`, so by the
 * time the report exists the only trace is a string — and classifying a
 * harness bug by matching prose is how the name-conflict 409 came to be
 * inert.
 */
export type ViolationSink = (violation: WorkflowDryRunViolation) => void;

/**
 * A `toolRunnerFactory` that cannot build a tool runner.
 *
 * Named and exported rather than inlined at the construction site so the
 * backstop is a thing a test can call. `WorkflowExecutor` builds the
 * runner lazily and only for a graph with a tool step, so in a correct
 * dry run this is never invoked — which is exactly why asserting it
 * throws needs a direct call rather than a workflow that reaches it.
 */
export function dryRunToolRunnerFactory(onViolation?: ViolationSink): never {
  const violation = new WorkflowDryRunViolation("tool dispatch");
  onViolation?.(violation);
  throw violation;
}

/**
 * An `AgentExecutor` that cannot run an agent.
 *
 * Only the two members `WorkflowExecutor` actually calls are implemented
 * — `runAgent` (throws) and `cancelRun` (a no-op, since nothing is ever
 * in flight to cancel). The cast is narrow and deliberate: constructing a
 * REAL `AgentExecutor` for a dry run would defeat the entire point of
 * guarantee 2.
 */
export function dryRunAgentExecutor(onViolation?: ViolationSink): AgentExecutor {
  const stub = {
    runAgent(): never {
      const violation = new WorkflowDryRunViolation("agent invocation");
      onViolation?.(violation);
      throw violation;
    },
    cancelRun(): void {},
  };
  return stub as unknown as AgentExecutor;
}

/** One step's outcome in a dry run. */
export interface DryRunStepReport {
  name: string;
  kind: WorkflowStepKind;
  /**
   * `evaluated` — actually run, against real data;
   * `stubbed` — stood in for, never dispatched;
   * `evaluated-on-stubs` — a gate that ran against fabricated operands,
   * so its verdict was recorded and NOT enforced.
   */
  mode: "evaluated" | "stubbed" | "evaluated-on-stubs";
  status: string;
}

/** A gate that ran against fabricated operands. Its verdict is reported
 *  and deliberately not acted on — see the module doc. */
export interface DryRunGateVerdict {
  name: string;
  /** What the gate WOULD have decided, against data nobody produced. */
  passed: boolean;
  /** The decisive leaf, verbatim from the condition evaluator. */
  reason: string;
}

/**
 * The status of a dry run that completed while at least one gate went
 * unenforced.
 *
 * Its own value rather than `success` because the two are not the same
 * claim: this one says "nothing failed", never "the graph passes". A
 * caller that treats every non-`error` status as a pass is the bug this
 * exists to make visible.
 */
export const DRY_RUN_UNVERIFIED = "unverified";

export interface DryRunReport {
  /**
   * Terminal status of the simulated run — `success`, `error`,
   * `cancelled`, or {@link DRY_RUN_UNVERIFIED}.
   *
   * Never bare `success` when a gate ran on stubs: see
   * {@link dryRunStatus}.
   */
  status: string;
  steps: DryRunStepReport[];
  /** Step names that were stood in for rather than executed. */
  stubbed: string[];
  /** Gates evaluated against stub-derived operands, verdict NOT enforced.
   *  Empty for a graph whose gates all read deterministic data. */
  gatesOnStubs: DryRunGateVerdict[];
  /** Failure message when the dry run did not complete. */
  error?: string;
  /** Final `$prev` output, with stubs rendered as their labels. */
  output?: unknown;
}

/**
 * The status a caller may act on.
 *
 * A run that completed with a gate unenforced proved nothing about that
 * gate, so reporting `success` would be the false green this module
 * exists to prevent — the UI renders that word as a plain pass. A run
 * that FAILED keeps its failure: that answer is already not green, and
 * overwriting it would hide the real fault behind a caveat.
 */
export function dryRunStatus(runStatus: string, gatesOnStubs: number): string {
  return runStatus === "success" && gatesOnStubs > 0 ? DRY_RUN_UNVERIFIED : runStatus;
}

/**
 * True when any operand of `cond` resolves to something the dry run
 * fabricated.
 *
 * An unresolvable root ref counts as NOT fabricated on purpose: letting
 * the gate run for real then reports the ref error, which is a genuine
 * finding a dry run should surface rather than swallow into "unenforced".
 */
function readsStub(cond: WorkflowCondition, ctx: RefContext): boolean {
  return conditionRefs(cond).some((ref) => {
    let value: unknown;
    try {
      value = resolveConditionRef(ref, ctx);
    } catch {
      return false;
    }
    return containsDryRunStub(value);
  });
}

/**
 * Record a gate's verdict WITHOUT enforcing it, when its operands are
 * fabricated. Returns `undefined` — meaning "run it for real" — when every
 * operand is deterministic.
 *
 * The substituted result is itself a stub, not `{ passed: <boolean> }`, so
 * a later gate reading `$steps.<gate>.output.passed` inherits the taint
 * instead of enforcing against a verdict that was never a fact. The
 * boolean the human needs is in the report, where it is labelled.
 */
function unenforcedGate(
  step: WorkflowStep,
  ctx: RefContext,
  into: DryRunGateVerdict[],
): AgentResult | undefined {
  // `condition!` mirrors `runGate`: a `gate` without one is rejected by
  // `validateWorkflow`, and a hand-edited row that smuggles one past it
  // should produce the executor's error, not a second message from here.
  const condition = step.condition!;
  if (!readsStub(condition, ctx)) return undefined;
  const verdict = evaluateCondition(condition, ctx);
  into.push({ name: step.name, passed: verdict.passed, reason: verdict.reason });
  return { success: true, output: dryRunStub(`${step.name}.output`) };
}

/**
 * Execute `definition` in dry-run mode and report what happened.
 *
 * Never throws for a workflow-level failure — a failed gate or an
 * unresolvable ref is the ANSWER the caller wanted, so it comes back in
 * `error`. It DOES propagate {@link WorkflowDryRunViolation}, because that
 * is a harness bug and swallowing it would hide the one thing this module
 * exists to prevent.
 *
 * That last sentence was false until the violations were recorded at their
 * throw sites: the executor's per-step catch turned a violation into an
 * ordinary batch failure, so an attempted real tool dispatch arrived as
 * `status: "error"` with a message — indistinguishable, to a caller and to
 * the editor, from a gate that failed. `input` is untrusted user data and a
 * workflow failure is routine; a harness bug is neither, and must not be
 * reportable as one.
 *
 * `isPure` is the allow list, injectable ONLY so a test can reach that
 * path: a correct harness substitutes every impure kind, which makes the
 * violation unreachable from outside — and an unreachable guarantee whose
 * escape route was never exercised is how the claim came to be wrong. No
 * caller in the product passes it.
 */
export async function dryRunWorkflow(
  definition: WorkflowDefinition,
  input: Record<string, unknown>,
  isPure: (kind: WorkflowStepKind) => boolean = isPureDryRunKind,
): Promise<DryRunReport> {
  const stubbed: string[] = [];
  const gatesOnStubs: DryRunGateVerdict[] = [];
  const violations: WorkflowDryRunViolation[] = [];
  const record: ViolationSink = (violation) => {
    violations.push(violation);
  };
  const executor = new WorkflowExecutor(
    dryRunAgentExecutor(record),
    // A private bus with no subscribers: a dry run's `workflow:*` frames
    // must not reach the SSE stream and be mistaken for a real run.
    new EventBus<AgentEvents>(),
    {
      // Asserted rather than inherited from the default — a dry run must
      // write no `workflow_runs` row, and that should be visible here.
      persist: false,
      toolRunnerFactory: () => dryRunToolRunnerFactory(record),
      stepSubstitute: (step: WorkflowStep, ctx: RefContext): AgentResult | undefined => {
        const kind = stepKind(step);
        if (isPure(kind)) {
          // Pure by KIND is not the same as trustworthy. A transform over
          // fabricated data is still just data movement, but a gate DECIDES
          // on it — so a gate is handed back unenforced when its operands
          // are stubs, and run for real when they are not.
          return kind === "gate" ? unenforcedGate(step, ctx, gatesOnStubs) : undefined;
        }
        stubbed.push(step.name);
        // Labelled `<step>.output` because the stub sits AT `result.output`
        // — so a `$steps.draft.output.meta.title` ref renders the ref that
        // produced it, not a path that starts two hops in.
        return { success: true, output: dryRunStub(`${step.name}.output`) };
      },
    },
  );

  pureExecutors.add(executor);
  const run: WorkflowRun = await executor.runWorkflow(definition, input);
  // Before any report exists: a violation means a guarantee fired, and the
  // caller must not get something that reads like a verdict on their graph.
  const violation = violations[0];
  if (violation !== undefined) throw violation;
  const stubbedSet = new Set(stubbed);
  const onStubs = new Set(gatesOnStubs.map((gate) => gate.name));
  return {
    status: dryRunStatus(run.status, gatesOnStubs.length),
    steps: (definition.steps ?? []).map((step) => ({
      name: step.name,
      kind: stepKind(step),
      mode: stubbedSet.has(step.name)
        ? ("stubbed" as const)
        : onStubs.has(step.name)
          ? ("evaluated-on-stubs" as const)
          : ("evaluated" as const),
      status: run.steps.find((s) => s.stepName === step.name)?.status ?? "skipped",
    })),
    stubbed,
    gatesOnStubs,
    ...(run.result?.error !== undefined
      ? { error: typeof run.result.error === "string" ? run.result.error : run.result.error.message }
      : {}),
    output: renderStubs(run.result?.output),
  };
}

/**
 * Replace stub proxies with their labels so the report is JSON-safe.
 *
 * A stub serializes to `{}` through `JSON.stringify` (its `ownKeys` trap
 * is empty), which would tell the user nothing. Rendering the label
 * instead makes it obvious which value came from a step that did not run.
 */
export function renderStubs(value: unknown): unknown {
  if (isDryRunStub(value)) return String(value);
  if (Array.isArray(value)) return value.map(renderStubs);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) out[key] = renderStubs(member);
    return out;
  }
  return value;
}
