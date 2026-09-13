import type { KernelEvent } from "@ezcorp/factory-sdk";
import type { FactoryAssuranceCommands } from "./assurance-commands";
import type { FactoryChildRuns } from "./child-runs";
import type { FactoryCommandAuthority } from "./command-authority";
import type { FactoryLazyCommands } from "./lazy-commands";
import type { FactoryPrivateServiceCommands } from "./private-service";
import { assertFactoryIdentity } from "./records";
import type { FactoryTaskAdmission } from "./task-admission";
import type { FactoryTaskExecutionAdmission } from "./task-execution-admission";
import type { FactoryTransitionArtifacts } from "./transition-artifacts";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

const effectKinds = ["cancel-node", "request-acceptance", "request-release", "invalidate-partition", "notify-partition"] as const;
type EffectKind = typeof effectKinds[number];
export type FactoryPrivateCommandHandler = (service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference) => Promise<KernelEvent | null>;

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
    return handler(this.service, reference);
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
