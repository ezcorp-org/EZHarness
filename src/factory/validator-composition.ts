/**
 * The installation's trusted validators, composed from its startup document.
 *
 * W05 built every piece a protected claim needs — the trusted gateway
 * (`FactoryTrustedValidators`), the scheduler that turns a missing claim into a
 * durable admission and attempt (`FactoryProtectedValidatorScheduler`), and the
 * settlement that records a validator's terminal fact without a kernel node
 * (`FactoryValidatorAttemptDispatch`). None of them had a production caller:
 * the gateway was built with an empty runtime set, no material was ever
 * registered, and nothing scheduled a validator. This file is that caller, and
 * it adds no rule of its own. Admission, binding, evidence, and the verdict
 * are W05's, consumed exactly as written.
 *
 * What it composes, and from what:
 *
 * - The gateway, from the declared runtimes (`validator-declaration.ts`).
 * - Material registration, from every published version whose protected
 *   claims name a declared runtime. Each version is registered once per
 *   process, so a restart re-registers every version and a changed runtime
 *   refuses by name (`factory_validator_material_conflict`) rather than
 *   silently judging an old lock with a new judge.
 * - The resource policy W05's scheduler asks for, from the runner profiles the
 *   document already declares: the live `factory.run` grant of the run's
 *   initiator, and the pool allocation of the runtime's resource class.
 * - The attempt settlement router, so the ONE attempt dispatcher settles a
 *   validator attempt through W05's validator settlement and every other
 *   attempt through the task path. The route is chosen by the durable
 *   assignment row, never by the shape of an id.
 * - The acceptance driver (`validator-acceptance.ts`).
 */
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import type { FactoryApplication } from "./application";
import type { FactoryBudgetAmount } from "./budgets";
import type { FactoryInstallationStores } from "./installation-stores";
import { factoryErrorCode } from "./plain-values";
import { FactoryProtectedCommandEffects } from "./protected-command-effects";
import { assertFactoryIdentity } from "./records";
import type { FactoryRoleDriver } from "./runtime-seams";
import type { FactoryStartupConfig } from "./startup-config";
import type { FactoryTaskCompletions } from "./task-completions";
import type { FactoryTaskOutcomes } from "./task-outcomes";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";
import { FactoryValidatorAcceptance } from "./validator-acceptance";
import type { FactoryDeclaredValidatorRuntime } from "./validator-declaration";
import { FactoryValidatorAttemptDispatch } from "./validator-dispatch";
import type { FactoryTrustedValidators } from "./validator-materials";
import { FactoryProtectedValidatorScheduler, type FactoryValidatorResourcePolicy, type FactoryValidatorResourceProfile } from "./validator-scheduler";
import type { FactoryTaskResourceProfile } from "./task-admission";

/** Published versions visited per registration pass. */
export const FACTORY_VALIDATOR_REGISTRATION_SCAN_LIMIT = 16;

export class FactoryValidatorCompositionError extends Error {
  constructor(
    readonly code: "factory_validator_runtime_rejected" | "factory_validator_resource_class_unknown" | "factory_validator_resource_denied",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "FactoryValidatorCompositionError";
  }
}

/**
 * The gateway, built from the declared runtimes, with the failing one named.
 *
 * `FactoryTrustedValidators` validates each runtime and refuses the whole set
 * with one code. A refusal an operator cannot attribute to a runtime is a
 * refusal they have to bisect by hand, so on failure each runtime is tried
 * alone — the constructor is pure — and the first that fails is named.
 */
export function factoryTrustedValidatorsFromDeclaration(
  build: (runtimes: readonly FactoryDeclaredValidatorRuntime["runtime"][]) => FactoryTrustedValidators,
  declared: readonly FactoryDeclaredValidatorRuntime[],
): FactoryTrustedValidators {
  try {
    return build(declared.map(entry => entry.runtime));
  } catch (error) {
    const failing = declared.find(entry => { try { build([entry.runtime]); return false; } catch { return true; } });
    // Every runtime valid alone and the set still refused means two of them
    // pin the same runner, which is a property of the set rather than of one.
    throw new FactoryValidatorCompositionError("factory_validator_runtime_rejected",
      `${failing?.name ?? declared.map(entry => entry.name).join(",")}: ${factoryErrorCode(error) ?? (error as Error).message}`);
  }
}

/**
 * W05's resource policy, answered from this installation's runner profiles.
 *
 * The three checks the scheduler's contract names: the run's initiator still
 * holds `factory.run` at the run's grant revision; the runtime's resource
 * class is one this installation allocates; and what the runtime asks for fits
 * that allocation. Package trust is re-checked where the task path checks it,
 * by the dispatcher's readiness gate immediately before launch, so a validator
 * package that is not prepared never starts.
 */
export function factoryValidatorResourcePolicy(options: {
  readonly lifecycle: Pick<FactoryApplication["runs"], "readExecutionPlanInTransaction">;
  readonly grants: Pick<FactoryApplication["grants"], "authorizeInTransaction">;
  readonly allocations: Readonly<Record<string, FactoryTaskResourceProfile>>;
}): FactoryValidatorResourcePolicy {
  return {
    async resolveInTransaction(transaction, { reference, schedule }): Promise<FactoryValidatorResourceProfile> {
      const plan = await options.lifecycle.readExecutionPlanInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId });
      await options.grants.authorizeInTransaction(transaction, plan.initiator, reference.projectId, "factory.run", plan.fence.grantRevision);
      const bounds = schedule.runtime.resources;
      const resourceClass = bounds.resourceClass ?? "cpu";
      const allocation = Object.hasOwn(options.allocations, resourceClass) ? options.allocations[resourceClass] : undefined;
      if (allocation === undefined) throw new FactoryValidatorCompositionError("factory_validator_resource_class_unknown", resourceClass);
      const amount: FactoryBudgetAmount = {
        costMicros: bounds.maxCostMicros ?? allocation.budget.costMicros,
        tokens: bounds.maxTokens ?? allocation.budget.tokens,
        computeMs: bounds.maxComputeMs ?? allocation.budget.computeMs,
      };
      const memoryBytes = bounds.memoryBytes ?? allocation.memoryBytes;
      if (memoryBytes > allocation.memoryBytes || BigInt(amount.costMicros) > BigInt(allocation.budget.costMicros)
        || amount.tokens > allocation.budget.tokens || amount.computeMs > allocation.budget.computeMs) {
        throw new FactoryValidatorCompositionError("factory_validator_resource_denied", `${schedule.runtime.validatorId} asks for more than the ${resourceClass} allocation`);
      }
      return { envelopeId: "root", amount, resources: allocation.resources, memoryBytes };
    },
  };
}

type CompletionSeam = Pick<FactoryTaskCompletions, "completeInTransaction" | "readInTransaction">;
type OutcomeSeam = Pick<FactoryTaskOutcomes, "recordInTransaction" | "readInTransaction">;

/**
 * The dispatcher's two settlement seams, routed by the durable assignment.
 *
 * A validator attempt's queue reference carries the attempt id as its command
 * id, and `readBoundAttemptInTransaction` finds an assignment for it; a task
 * attempt's carries a transition command id, for which none exists. Only the
 * one "no assignment" code routes to the task path — any other failure of the
 * lookup is raised, because guessing a route on a corrupt assignment would
 * settle a validator as a task or a task as a validator.
 */
export function factoryValidatorAwareSettlement(
  validators: Pick<FactoryTrustedValidators, "readBoundAttemptInTransaction">,
  validator: Pick<FactoryValidatorAttemptDispatch, "completeInTransaction" | "readInTransaction" | "recordInTransaction" | "readOutcomeInTransaction">,
  tasks: { readonly completions: CompletionSeam; readonly outcomes: OutcomeSeam },
): { readonly completions: CompletionSeam; readonly outcomes: OutcomeSeam } {
  const bound = async (transaction: MigrationDb, reference: TrustedFactoryCommandReference): Promise<boolean> => {
    try {
      await validators.readBoundAttemptInTransaction(transaction, reference.projectId, reference.commandId);
      return true;
    } catch (error) {
      if (factoryErrorCode(error) === "factory_validator_assignment_missing") return false;
      throw error;
    }
  };
  return Object.freeze({
    completions: Object.freeze({
      completeInTransaction: async (transaction: MigrationDb, service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference, result: Parameters<CompletionSeam["completeInTransaction"]>[3]) =>
        await bound(transaction, reference) ? validator.completeInTransaction(transaction, service, reference, result) : tasks.completions.completeInTransaction(transaction, service, reference, result),
      readInTransaction: async (transaction: MigrationDb, service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference) =>
        await bound(transaction, reference) ? validator.readInTransaction(transaction, service, reference) : tasks.completions.readInTransaction(transaction, service, reference),
    }),
    outcomes: Object.freeze({
      recordInTransaction: async (transaction: MigrationDb, service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference, result: Parameters<OutcomeSeam["recordInTransaction"]>[3]) =>
        await bound(transaction, reference) ? validator.recordInTransaction(transaction, service, reference, result) : tasks.outcomes.recordInTransaction(transaction, service, reference, result),
      readInTransaction: async (transaction: MigrationDb, service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference) =>
        await bound(transaction, reference) ? validator.readOutcomeInTransaction() : tasks.outcomes.readInTransaction(transaction, service, reference),
    }),
  });
}

/** One published version, as the registration scan names it. */
interface PublishedVersion { readonly projectId: string; readonly factoryId: string; readonly version: string }

/**
 * Registers the validator material of every published version, once per process.
 *
 * A version is visited once whatever the answer, and the answer is reported
 * by name when it is a refusal: a version whose claim names an undeclared
 * runtime refuses `factory_validator_runtime_untrusted`, and one whose stored
 * material no longer matches the declared runtime refuses
 * `factory_validator_material_conflict`. A version with no protected claim has
 * nothing to register and is not reported. The scan walks all versions with a
 * cursor and wraps, so a refused version can never starve a newer one.
 */
export class FactoryValidatorMaterialRegistration {
  private readonly visited = new Set<string>();
  private cursor: PublishedVersion | undefined;

  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly definitions: Pick<FactoryApplication["definitions"], "readPublishedInTransaction">,
    private readonly validators: Pick<FactoryTrustedValidators, "registerMaterialInTransaction">,
    private readonly report: (role: string, error: unknown) => void,
    private readonly limit = FACTORY_VALIDATOR_REGISTRATION_SCAN_LIMIT,
  ) {
    assertFactoryIdentity(tenantId);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("factory_validator_registration_invalid");
  }

  /** One bounded page. Resolves true when it registered a version it had not seen. */
  async step(signal: AbortSignal): Promise<boolean> {
    const after = this.cursor;
    const page = rows<{ project_id: string; factory_id: string; version: string }>(await this.database.execute(sql`
      SELECT project_id, factory_id, version FROM factory_versions
      WHERE tenant_id=${this.tenantId} ${after === undefined ? sql`` : sql`AND (project_id, factory_id, version) > (${after.projectId}, ${after.factoryId}, ${after.version})`}
      ORDER BY project_id, factory_id, version LIMIT ${this.limit}`));
    this.cursor = page.length < this.limit ? undefined : { projectId: page.at(-1)!.project_id, factoryId: page.at(-1)!.factory_id, version: page.at(-1)!.version };
    let registered = false;
    for (const row of page) {
      if (signal.aborted) break;
      const key = `${row.project_id}/${row.factory_id}@${row.version}`;
      if (this.visited.has(key)) continue;
      registered = await this.register({ projectId: row.project_id, factoryId: row.factory_id, version: row.version }, key) || registered;
    }
    return registered;
  }

  /** Walk every page once, for startup, so a refusal is named before admission opens. */
  async registerAll(signal: AbortSignal): Promise<void> {
    do { await this.step(signal); } while (this.cursor !== undefined && !signal.aborted);
  }

  /**
   * Register one version. A version is settled for this process by success or
   * by one of W05's named refusals; any other failure — a lost connection, an
   * unreadable blob — is reported and retried on a later pass.
   */
  private async register(version: PublishedVersion, key: string): Promise<boolean> {
    try {
      await this.database.transaction(async (transaction) => {
        const { compiled } = await this.definitions.readPublishedInTransaction(transaction, { projectId: version.projectId, factoryId: version.factoryId }, version.version);
        await this.validators.registerMaterialInTransaction(transaction, version.projectId, compiled);
      });
      this.visited.add(key);
      return true;
    } catch (error) {
      const code = factoryErrorCode(error);
      if (code?.startsWith("factory_validator_")) this.visited.add(key);
      if (code === "factory_validator_material_unprotected") return false;
      this.report(`validator-materials:${code ?? "failed"}:${key}`, error);
      return false;
    }
  }
}

export interface FactoryValidatorCompositionOptions {
  readonly database: TransactionalDb;
  readonly config: FactoryStartupConfig;
  readonly application: Pick<FactoryApplication, "definitions" | "runs" | "journal" | "artifacts" | "releaseAuthority" | "grants">;
  readonly stores: FactoryInstallationStores;
  readonly service: TrustedFactoryServiceIdentity;
  /** The gateway, already built from the declaration. */
  readonly validators: FactoryTrustedValidators;
  /** The runner profiles' allocations, keyed by resource class. */
  readonly allocations: Readonly<Record<string, FactoryTaskResourceProfile>>;
  readonly assurance: ConstructorParameters<typeof FactoryProtectedCommandEffects>[5];
  readonly releases: ConstructorParameters<typeof FactoryProtectedCommandEffects>[6];
  readonly report: (role: string, error: unknown) => void;
}

export interface FactoryComposedValidators {
  readonly registration: FactoryValidatorMaterialRegistration;
  readonly acceptance: FactoryValidatorAcceptance;
  /** The two seams the attempt dispatcher settles through. */
  readonly settlement: ReturnType<typeof factoryValidatorAwareSettlement>;
  readonly roles: { readonly registration: FactoryRoleDriver; readonly scheduling: FactoryRoleDriver };
}

/**
 * The scheduler, the settlement, the registration, and the acceptance driver.
 *
 * Every store is the installation's own, shared with the task path: the same
 * command authority, budgets, compute ledger, journal, attempt queue, and
 * inbox. A validator therefore reaches the pool through the same admission
 * roles and a runner through the same attempt dispatcher as any task, which
 * is what the C05 origin rules were written against.
 */
export function composeFactoryValidators(options: FactoryValidatorCompositionOptions): FactoryComposedValidators {
  const { database, config, application, stores, validators } = options;
  const compute = stores.compute;
  const completions = stores.completions;
  const outcomes = stores.outcomes;
  if (compute === undefined || completions === undefined || outcomes === undefined) {
    throw new Error("factory_validator_stores_missing: a protected validator needs the compute ledger and the task settlement stores");
  }
  const scheduler = new FactoryProtectedValidatorScheduler(
    config.tenantId, stores.authority, validators, stores.budgets, compute, stores.journal, stores.queue,
    factoryValidatorResourcePolicy({ lifecycle: application.runs, grants: application.grants, allocations: options.allocations }),
  );
  const dispatch = new FactoryValidatorAttemptDispatch(database, config.tenantId, stores.authority, validators, stores.journal, stores.queue, application.artifacts);
  // Only `decideAcceptance` and `recordCurrentCandidate` are called on this
  // instance, and neither reads the release profile set, so it holds none.
  const effects = new FactoryProtectedCommandEffects(database, config.tenantId, stores.authority, completions, application.releaseAuthority, options.assurance, options.releases, []);
  const acceptance = new FactoryValidatorAcceptance({
    database, tenantId: config.tenantId, service: options.service, authority: stores.authority,
    scheduler, dispatch, queue: stores.queue, budgets: stores.budgets, journal: stores.journal, artifacts: application.artifacts,
    effects, inbox: stores.inbox, report: options.report,
  });
  const registration = new FactoryValidatorMaterialRegistration(database, config.tenantId, application.definitions, validators, options.report);
  return Object.freeze({
    registration,
    acceptance,
    settlement: factoryValidatorAwareSettlement(validators, dispatch, { completions, outcomes }),
    roles: Object.freeze({ registration: { step: (signal: AbortSignal) => registration.step(signal) }, scheduling: acceptance.driver() }),
  });
}
