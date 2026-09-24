import { factoryAdmissionRefusedEvent, factoryCommandFailedEvent, type KernelCommand, type KernelEvent } from "@ezcorp/factory-sdk";
import type { FactoryAttemptQueue } from "./attempt-queue";
import type { FactoryAssuranceCommands } from "./assurance-commands";
import type { FactoryChildRuns } from "./child-runs";
import type { FactoryCommandAuthority } from "./command-authority";
import type { FactoryLazyCommands } from "./lazy-commands";
import { factoryErrorCode } from "./plain-values";
import type { FactoryPrivateServiceCommands } from "./private-service";
import { assertFactoryIdentity } from "./records";
import type { FactoryTaskAdmission } from "./task-admission";
import type { FactoryTaskExecutionAdmission } from "./task-execution-admission";
import type { FactoryTransitionArtifacts } from "./transition-artifacts";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

const effectKinds = ["cancel-node", "request-acceptance", "request-release", "invalidate-partition", "notify-partition"] as const;
type EffectKind = typeof effectKinds[number];
export type FactoryPrivateCommandHandler = (service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference) => Promise<KernelEvent | null>;

/** The routes whose named refusals are answered as kernel events: the executions route and the effects. */
const NAMED_REFUSAL_KINDS: ReadonlySet<string> = new Set(["dispatch-node", ...effectKinds]);

/** The `factory_` code a refusal names itself with, or `undefined` for any other error. */
function namedRefusalCode(error: unknown): string | undefined {
  const code = factoryErrorCode(error);
  return code?.startsWith("factory_") ? code : undefined;
}

export interface FactoryPrivateCommandStores {
  readonly service: TrustedFactoryServiceIdentity;
  readonly authority: Pick<FactoryCommandAuthority, "tenantId" | "assertService">;
  readonly transitions: Pick<FactoryTransitionArtifacts, "loadStoredCommand">;
  readonly tasks: Pick<FactoryTaskAdmission, "request">;
  readonly execution: Pick<FactoryTaskExecutionAdmission, "admit">;
  readonly inputs: Pick<FactoryLazyCommands, "execute">;
  readonly children: Pick<FactoryChildRuns, "resolve">;
  readonly approvals: Pick<FactoryAssuranceCommands, "tenantId" | "execute">;
  /** Each effect module rechecks current command authority in its own receipt transaction. */
  readonly effects: Readonly<Record<EffectKind, FactoryPrivateCommandHandler>>;
  /**
   * The attempt queue, read to prove that a refused dispatch left no queued attempt. Without it a
   * refused dispatch keeps the cautious answer, `command-failed`, and the kernel's ordinary stop.
   */
  readonly attempts?: Pick<FactoryAttemptQueue, "read">;
}

export class FactoryPrivateCommandError extends Error {
  constructor(readonly code: "factory_private_commands_invalid" | "factory_private_command_forbidden") { super(code); this.name = "FactoryPrivateCommandError"; }
}

/** Routes stored command kinds; transport bodies never select an effect or supply its authority. */
export class FactoryPrivateCommands implements FactoryPrivateServiceCommands {
  private readonly service: TrustedFactoryServiceIdentity;
  private readonly handlers: ReadonlyMap<string, FactoryPrivateCommandHandler>;
  private readonly authorize: (service: TrustedFactoryServiceIdentity) => void;
  private readonly load: FactoryTransitionArtifacts["loadStoredCommand"];
  private readonly resolve: FactoryChildRuns["resolve"];
  private readonly attempts: Pick<FactoryAttemptQueue, "read"> | undefined;

  constructor(stores: FactoryPrivateCommandStores) {
    if (!stores?.service || stores.authority?.tenantId !== stores.service.tenantId || stores.approvals?.tenantId !== stores.service.tenantId
      || typeof stores.authority?.assertService !== "function" || typeof stores.transitions?.loadStoredCommand !== "function"
      || typeof stores.tasks?.request !== "function" || typeof stores.execution?.admit !== "function" || typeof stores.inputs?.execute !== "function"
      || typeof stores.children?.resolve !== "function" || typeof stores.approvals?.execute !== "function"
      || !stores.effects || Object.keys(stores.effects).length !== effectKinds.length || effectKinds.some(kind => typeof stores.effects[kind] !== "function")) throw new FactoryPrivateCommandError("factory_private_commands_invalid");
    this.service = Object.freeze({ tenantId: stores.service.tenantId, subject: stores.service.subject });
    assertFactoryIdentity(this.service.tenantId, this.service.subject);
    this.authorize = stores.authority.assertService.bind(stores.authority);
    this.authorize(this.service);
    this.load = stores.transitions.loadStoredCommand.bind(stores.transitions);
    this.resolve = stores.children.resolve.bind(stores.children);
    this.attempts = stores.attempts;
    const request = stores.tasks.request.bind(stores.tasks);
    const admit = stores.execution.admit.bind(stores.execution);
    const input = stores.inputs.execute.bind(stores.inputs);
    const approval = stores.approvals.execute.bind(stores.approvals);
    this.handlers = new Map<string, FactoryPrivateCommandHandler>([
      ["request-admission", async (service, reference) => { await request(service, reference); return null; }],
      ["dispatch-node", async (service, reference) => { await admit(service, reference); return null; }],
      ["read-input-value", input], ["read-input-page", input],
      ["request-approval", (_service, reference) => approval(reference)],
      ...effectKinds.map(kind => [kind, stores.effects[kind].bind(stores.effects)] as const),
    ]);
  }

  async execute(service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference): Promise<KernelEvent | null> {
    const reference = this.reference(service, value);
    const command = await this.load(reference);
    const handler = this.handlers.get(command.kind);
    if (!handler || command.id !== reference.commandId) throw new FactoryPrivateCommandError("factory_private_command_forbidden");
    if (!NAMED_REFUSAL_KINDS.has(command.kind)) return handler(this.service, reference);
    try {
      return await handler(this.service, reference);
    } catch (error) {
      const code = namedRefusalCode(error);
      if (code === undefined) throw error;
      return this.refusal(command, reference, code);
    }
  }

  /**
   * The event for a command refused by name.
   *
   * The private service answers a refusal it does not classify with an opaque `request_failed`, so
   * the orchestrator could only record "Activity task failed" and nobody could see which rule
   * stopped the run. A refusal that names itself is answered here instead, carrying the name. Every
   * command runs once, and any failure of it already fails the run, so only the reason changes.
   *
   * A refused dispatch with no queued attempt started nothing, and says so with `admission_denied`,
   * so the kernel ends the node without a stop nobody could answer. Every other case, including a
   * dispatch whose attempt is queued, is `command-failed` and keeps the kernel's ordinary stop.
   */
  private async refusal(command: KernelCommand, reference: TrustedFactoryCommandReference, code: string): Promise<KernelEvent> {
    const now = Date.now();
    if (command.kind === "dispatch-node" && this.attempts !== undefined && await this.attempts.read(reference.projectId, command.id) === null) {
      return factoryAdmissionRefusedEvent(command, code, now);
    }
    return factoryCommandFailedEvent(command, code, now);
  }

  async resolveFactory(service: TrustedFactoryServiceIdentity, value: Parameters<FactoryPrivateServiceCommands["resolveFactory"]>[1]): ReturnType<FactoryPrivateServiceCommands["resolveFactory"]> {
    const reference = this.reference(service, value);
    const factory = Object.freeze({ id: value.factory.id, version: value.factory.version, digest: value.factory.digest });
    return this.resolve(this.service, Object.freeze({ ...reference, factory }));
  }

  private reference(service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference): TrustedFactoryCommandReference {
    if (service.tenantId !== this.service.tenantId || service.subject !== this.service.subject || value.tenantId !== this.service.tenantId) throw new FactoryPrivateCommandError("factory_private_command_forbidden");
    this.authorize(this.service);
    const reference = Object.freeze({ tenantId: value.tenantId, projectId: value.projectId, logicalRunId: value.logicalRunId, interpreterId: value.interpreterId, commandId: value.commandId });
    assertFactoryIdentity(...Object.values(reference));
    return reference;
  }
}
