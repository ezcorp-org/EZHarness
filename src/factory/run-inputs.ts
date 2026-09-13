import { validateDurableInputPorts, validateValue, type CompiledFactory, type FactoryRunStartBody, type JsonValue } from "@ezcorp/factory-sdk";
import type { MigrationDb } from "../db/migrations/types";
import type { FactoryDefinitionKey } from "./definitions";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { FactoryInputArtifactError, type FactoryInputArtifacts } from "./input-artifacts";
import { encodeFactoryPayload } from "./records";
import { FactoryRunLifecycleError, type FactoryResolvedParameters } from "./run-lifecycle";

/** Validates full input on the trusted host, retaining only bounded inline values in workflow history. */
export class FactoryRunInputs {
  constructor(private readonly grants: FactoryGrants, private readonly artifacts: FactoryInputArtifacts) {
    if (grants.tenantId !== artifacts.tenantId) throw new FactoryRunLifecycleError("factory_input_invalid");
  }

  readonly resolveInTransaction = async (transaction: MigrationDb, actor: FactoryPrincipal, key: FactoryDefinitionKey, input: FactoryRunStartBody["parameters"], compiled: CompiledFactory): Promise<FactoryResolvedParameters> => {
    const principal = structuredClone(actor);
    const projectId = key.projectId;
    const ports = structuredClone(compiled.definition.inputPorts);
    const parameters = JSON.parse(encodeFactoryPayload(input)) as FactoryRunStartBody["parameters"];
    const inline: Record<string, JsonValue> = Object.create(null);
    for (const [name, value] of Object.entries(parameters)) if (value.kind === "inline") inline[name] = value.value;
    if (!validateDurableInputPorts(ports, inline, { schemaVersion: "factory.lazy-input.v1", parameters }).ok) throw new FactoryRunLifecycleError("factory_input_invalid");
    await this.grants.authorizeInTransaction(transaction, principal, projectId, "factory.run");
    for (const [name, value] of Object.entries(parameters)) {
      if (value.kind !== "artifact") continue;
      const loaded = await this.artifacts.loadInTransaction(transaction, projectId, value.artifact).catch(error => {
        if (error instanceof FactoryInputArtifactError) throw new FactoryRunLifecycleError("factory_input_invalid");
        throw error;
      });
      if (!validateValue(ports[name]!, loaded.value).ok) throw new FactoryRunLifecycleError("factory_input_invalid");
    }
    return { kind: "factory.run-resolved-parameters", input: inline };
  };
}
