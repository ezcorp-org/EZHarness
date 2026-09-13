import { validateDurableInputPorts, validateValue, type CompiledFactory, type FactoryRunStartBody, type JsonValue, type PortSchema } from "@ezcorp/factory-sdk";
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
    await this.grants.authorizeInTransaction(transaction, principal, projectId, "factory.run");
    const resolved = await this.resolveNodeInTransaction(transaction, projectId, parameters, ports);
    const inline = Object.fromEntries(Object.entries(parameters).filter(([, value]) => value.kind === "inline").map(([name]) => [name, resolved[name]!])) as Record<string, JsonValue>;
    return { kind: "factory.run-resolved-parameters", input: inline };
  };

  /** Resolves every exact node input for a sealed repair after the caller authorizes the run. */
  async resolveNodeInTransaction(transaction: MigrationDb, projectId: string, input: FactoryRunStartBody["parameters"], portsValue: Readonly<Record<string, PortSchema>>): Promise<Readonly<Record<string, JsonValue>>> {
    const ports = structuredClone(portsValue);
    const parameters = JSON.parse(encodeFactoryPayload(input)) as FactoryRunStartBody["parameters"];
    const values: Record<string, JsonValue> = Object.create(null);
    for (const [name, value] of Object.entries(parameters)) if (value.kind === "inline") values[name] = value.value;
    if (!validateDurableInputPorts(ports, values, { schemaVersion: "factory.lazy-input.v1", parameters }).ok) throw new FactoryRunLifecycleError("factory_input_invalid");
    for (const [name, value] of Object.entries(parameters)) {
      if (value.kind !== "artifact") continue;
      const loaded = await this.artifacts.loadInTransaction(transaction, projectId, value.artifact).catch(error => {
        if (error instanceof FactoryInputArtifactError) throw new FactoryRunLifecycleError("factory_input_invalid");
        throw error;
      });
      if (!validateValue(ports[name]!, loaded.value).ok) throw new FactoryRunLifecycleError("factory_input_invalid");
      values[name] = loaded.value;
    }
    return values;
  }
}
