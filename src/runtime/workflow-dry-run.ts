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
 * A `gate` is evaluated for real, which means a gate comparing a stubbed
 * value against a literal WILL fail and stop the dry run there. That is
 * the truthful outcome — the same thing a real run would report given
 * that data — and the UI says so rather than letting the user discover it.
 */
import type {
  AgentEvents,
  AgentResult,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepKind,
} from "../types";
import type { AgentExecutor } from "./executor";
import { EventBus } from "./events";
import { WorkflowExecutor } from "./workflow-executor";
import { stepKind } from "./workflow-validator";

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
 * A `toolRunnerFactory` that cannot build a tool runner.
 *
 * Named and exported rather than inlined at the construction site so the
 * backstop is a thing a test can call. `WorkflowExecutor` builds the
 * runner lazily and only for a graph with a tool step, so in a correct
 * dry run this is never invoked — which is exactly why asserting it
 * throws needs a direct call rather than a workflow that reaches it.
 */
export function dryRunToolRunnerFactory(): never {
  throw new WorkflowDryRunViolation("tool dispatch");
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
export function dryRunAgentExecutor(): AgentExecutor {
  const stub = {
    runAgent(): never {
      throw new WorkflowDryRunViolation("agent invocation");
    },
    cancelRun(): void {},
  };
  return stub as unknown as AgentExecutor;
}

/** One step's outcome in a dry run. */
export interface DryRunStepReport {
  name: string;
  kind: WorkflowStepKind;
  /** `evaluated` — actually run; `stubbed` — stood in for. */
  mode: "evaluated" | "stubbed";
  status: string;
}

export interface DryRunReport {
  /** Terminal status of the simulated run (`success`, `error`, …). */
  status: string;
  steps: DryRunStepReport[];
  /** Step names that were stood in for rather than executed. */
  stubbed: string[];
  /** Failure message when the dry run did not complete. */
  error?: string;
  /** Final `$prev` output, with stubs rendered as their labels. */
  output?: unknown;
}

/**
 * Execute `definition` in dry-run mode and report what happened.
 *
 * Never throws for a workflow-level failure — a failed gate or an
 * unresolvable ref is the ANSWER the caller wanted, so it comes back in
 * `error`. It does propagate {@link WorkflowDryRunViolation}, because
 * that is a harness bug and swallowing it would hide the one thing this
 * module exists to prevent.
 */
export async function dryRunWorkflow(
  definition: WorkflowDefinition,
  input: Record<string, unknown>,
): Promise<DryRunReport> {
  const stubbed: string[] = [];
  const executor = new WorkflowExecutor(
    dryRunAgentExecutor(),
    // A private bus with no subscribers: a dry run's `workflow:*` frames
    // must not reach the SSE stream and be mistaken for a real run.
    new EventBus<AgentEvents>(),
    {
      // Asserted rather than inherited from the default — a dry run must
      // write no `workflow_runs` row, and that should be visible here.
      persist: false,
      toolRunnerFactory: dryRunToolRunnerFactory,
      stepSubstitute: (step: WorkflowStep): AgentResult | undefined => {
        if (isPureDryRunKind(stepKind(step))) return undefined;
        stubbed.push(step.name);
        // Labelled `<step>.output` because the stub sits AT `result.output`
        // — so a `$steps.draft.output.meta.title` ref renders the ref that
        // produced it, not a path that starts two hops in.
        return { success: true, output: dryRunStub(`${step.name}.output`) };
      },
    },
  );

  const run: WorkflowRun = await executor.runWorkflow(definition, input);
  const stubbedSet = new Set(stubbed);
  return {
    status: run.status,
    steps: (definition.steps ?? []).map((step) => ({
      name: step.name,
      kind: stepKind(step),
      mode: stubbedSet.has(step.name) ? ("stubbed" as const) : ("evaluated" as const),
      status: run.steps.find((s) => s.stepName === step.name)?.status ?? "skipped",
    })),
    stubbed,
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
