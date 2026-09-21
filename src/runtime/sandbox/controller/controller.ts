import { canonicalJson, sha256, validateProviderMethodValue, validateProviderMethodExchange, type ProviderReceipt, type SandboxCreateInput, type SandboxResource } from "@ezcorp/extension-contract";
import { NATIVE_TOOL_ARTIFACT, NATIVE_TOOL_OUTPUT_BYTES } from "../native-tool-protocol";
import { sql } from "drizzle-orm";
import { getDb, type DbTransaction } from "../../../db/connection";
import { getProjectMembership } from "../../../db/queries/project-members";
import { getReleaseRuntime, releaseBinding, resolveActiveRelease, type ActiveExtensionRelease, type ReleaseRuntimeDependencies } from "../../../extensions/release-process";
import { SandboxControllerError, type AdmittedSandboxMethod, type AdmittedSandboxOperation, type LocalSandboxDriver, type LocalSandboxProvider, type NativeWorkspaceCommand, type SandboxController, type SandboxMethodInput, type SandboxOperationResult, type SandboxProjectStatus, type SandboxProviderInvocation } from "./types";

type Row = Record<string, unknown>;
type ProviderResult = { receipt: ProviderReceipt; resource?: SandboxResource };
type ProcessResult = { receipt: ProviderReceipt; process?: { identity: { bootId: string; processId: string }; state: string; exitCode?: number; outputCursor: number } };
type MethodKind = "writer" | "observation" | "cancel" | "invalid";
const activeRawOperations = new Map<string, Promise<unknown>>();

function rows(value: unknown): Row[] { return (value as { rows?: Row[] }).rows ?? []; }
function parse<T>(value: unknown): T { return typeof value === "string" ? JSON.parse(value) as T : value as T; }
async function requireMember(userId: string, projectId: string): Promise<void> {
  if (!await getProjectMembership(userId, projectId)) throw new SandboxControllerError("PROJECT_ACCESS_DENIED", "Project membership is required");
}
function receiptMatches(call: SandboxCreateInput["call"], receipt: ProviderReceipt): void {
  if (receipt.operationId !== call.operationId || receipt.idempotencyKey !== call.idempotencyKey || receipt.requestDigest !== call.requestDigest) throw new SandboxControllerError("PROVIDER_RECEIPT_MISMATCH", "Provider receipt does not match the admitted operation");
}
function resourceState(receipt: ProviderReceipt): "failed" | "unknown" { return receipt.outcome === "failed" ? "failed" : "unknown"; }
function isTerminalProcess(state: unknown): boolean { return state === "exited" || state === "cancelled" || state === "failed"; }
function methodKind(group: unknown, method: unknown): MethodKind {
  if (group === "sandbox.lifecycle.v1") return method === "inspect" ? "observation" : "invalid";
  if (group === "sandbox.process.v1") {
    if (method === "start") return "writer";
    if (method === "cancel") return "cancel";
    return method === "inspect" || method === "readOutput" ? "observation" : "invalid";
  }
  if (group === "sandbox.files.v1") {
    if (["write", "mkdir", "remove", "chmod"].includes(String(method))) return "writer";
    return ["stat", "list", "read"].includes(String(method)) ? "observation" : "invalid";
  }
  return "invalid";
}
function activeMethodError(operation: Row): SandboxControllerError {
  return operation.writer_id
    ? new SandboxControllerError("WRITER_LEASED", "A sandbox writer is already active or awaiting recovery")
    : new SandboxControllerError("OPERATION_IN_PROGRESS", "A sandbox method is already active or awaiting recovery");
}
async function requireNoActiveLifecycle(tx: DbTransaction, bindingId: string): Promise<void> {
  const active = rows(await tx.execute(sql`SELECT id FROM sandbox_operations WHERE binding_id=${bindingId} AND action IN ('start','stop','destroy') AND state IN ('admitted','running','unknown') LIMIT 1`))[0];
  if (active) throw new SandboxControllerError("OPERATION_IN_PROGRESS", "A sandbox lifecycle transition is already active or awaiting recovery");
}
async function requireNoActiveMethod(tx: DbTransaction, bindingId: string): Promise<void> {
  const active = rows(await tx.execute(sql`
    SELECT operation.id, operation.state, operation.method_group, operation.method,
      operation.completed_at, lease.operation_id AS writer_id,
      EXISTS (
        SELECT 1
        FROM sandbox_processes process
        WHERE process.binding_id=operation.binding_id
          AND process.state IN ('exited','cancelled','failed')
          AND process.result->'process'->'identity'=operation.input->'identity'
      ) AS exact_process_terminal
    FROM sandbox_method_operations operation
    LEFT JOIN sandbox_writer_leases lease ON lease.operation_id=operation.id
    WHERE operation.binding_id=${bindingId}
      AND (lease.operation_id IS NOT NULL OR operation.state IN ('admitted','running','unknown'))
    ORDER BY operation.created_at
  `));
  for (const operation of active) {
    if (!operation.writer_id && operation.state === "unknown") {
      const kind = methodKind(operation.method_group, operation.method);
      const completedObservation = kind === "observation" && operation.completed_at;
      const terminalCancel = kind === "cancel" && operation.exact_process_terminal;
      if (completedObservation || terminalCancel) continue;
    }
    throw activeMethodError(operation);
  }
}

export function createSandboxController(driver: LocalSandboxDriver, runtime: Pick<ReleaseRuntimeDependencies, "resolve"> = getReleaseRuntime(), invoke?: SandboxProviderInvocation, clock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }): SandboxController {
  const reviewedOperations = new Set<string>();
  const freshMethodAdmissions = new Set<string>();
  const executingMethods = new Set<string>();
  function requireReviewedWindow(operationId: string): void {
    if (!reviewedOperations.has(operationId)) throw new SandboxControllerError("RAW_DISPATCH_DENIED", "Raw sandbox dispatch requires an active reviewed invocation");
  }
  async function provider(installationId: string, providerId: string): Promise<LocalSandboxProvider> {
    let snapshot: ActiveExtensionRelease;
    try { snapshot = await resolveActiveRelease(installationId, runtime as ReleaseRuntimeDependencies); }
    catch { throw new SandboxControllerError("PROVIDER_INACTIVE", "Provider release is not active and acknowledged"); }
    if (!snapshot.release.manifest.providers?.some(item => item.id === providerId && item.kind === "sandbox")) throw new SandboxControllerError("PROVIDER_UNDECLARED", "Active release does not declare the local sandbox provider");
    return { installationId, providerId, releaseId: snapshot.release.id, releaseBinding: await sha256(releaseBinding(snapshot)), generation: snapshot.installation.generation };
  }
  async function boundProvider(binding: Row): Promise<LocalSandboxProvider> {
    const current = await provider(String(binding.installation_id), String(binding.provider_id));
    if (current.releaseId !== binding.release_id || current.generation !== Number(binding.generation) || current.releaseBinding !== binding.release_binding) throw new SandboxControllerError("STALE_PROVIDER_BINDING", "Provider release changed; review the binding again");
    return current;
  }
  async function status(userId: string, projectId: string): Promise<SandboxProjectStatus> {
    await requireMember(userId, projectId);
    const binding = rows(await getDb().execute(sql`SELECT * FROM sandbox_provider_bindings WHERE project_id = ${projectId}`))[0];
    if (!binding) throw new SandboxControllerError("SANDBOX_NOT_CONFIGURED", "Project has no sandbox binding");
    const current = await boundProvider(binding);
    const resource = rows(await getDb().execute(sql`SELECT * FROM sandbox_resources WHERE binding_id = ${binding.id}`))[0];
    const operation = rows(await getDb().execute(sql`SELECT * FROM sandbox_operations WHERE binding_id = ${binding.id} ORDER BY created_at DESC LIMIT 1`))[0];
    return { projectId, bindingId: String(binding.id), provider: current, resource: resource?.provider_resource_id ? { resourceId: String(resource.provider_resource_id), desiredState: resource.desired_state as SandboxResource["desiredState"], observedState: resource.observed_state as SandboxResource["observedState"], limits: parse<SandboxResource["limits"]>(resource.limits) } : null, operation: operation ? { id: String(operation.id), action: operation.action as AdmittedSandboxOperation["action"], state: operation.state as AdmittedSandboxOperation["state"], ...(operation.receipt ? { receipt: parse<ProviderReceipt>(operation.receipt) } : {}) } : null };
  }
  async function settle(operationId: string, bindingId: string, result: ProviderResult): Promise<void> {
    await getDb().transaction(async (tx: DbTransaction) => {
      await tx.execute(sql`UPDATE sandbox_operations SET state=${result.receipt.outcome}, receipt=${JSON.stringify(result.receipt)}, result=${JSON.stringify(result)}, completed_at=NOW() WHERE id=${operationId}`);
      if (result.resource) await tx.execute(sql`UPDATE sandbox_resources SET provider_resource_id=${result.resource.resourceId}, desired_state=${result.resource.desiredState}, observed_state=${result.resource.observedState}, updated_at=NOW() WHERE binding_id=${bindingId}`);
      else if (result.receipt.outcome !== "succeeded") {
        const action = rows(await tx.execute(sql`SELECT action FROM sandbox_operations WHERE id=${operationId}`))[0]?.action;
        const cleanCreateFailure = action === "create" && result.receipt.outcome === "failed" && result.receipt.error.code === "create_failed_clean";
        await tx.execute(sql`UPDATE sandbox_resources SET desired_state=${cleanCreateFailure ? "destroyed" : "stopped"},observed_state=${cleanCreateFailure ? "destroyed" : resourceState(result.receipt)}, updated_at=NOW() WHERE binding_id=${bindingId}`);
      }
      if (result.receipt.outcome === "succeeded" && result.resource) {
        await tx.execute(sql`UPDATE project_workspace_bindings SET state=${result.resource.observedState === "destroyed" ? "unknown" : "active"}, updated_at=NOW() WHERE binding_id=${bindingId}`);
        if (result.resource.observedState === "destroyed") await tx.execute(sql`DELETE FROM sandbox_writer_leases WHERE binding_id=${bindingId}`);
      }
    });
  }
  async function unknown(operationId: string, bindingId: string): Promise<void> {
    await getDb().transaction(async (tx: DbTransaction) => {
      await tx.execute(sql`UPDATE sandbox_operations SET state='unknown', completed_at=NOW() WHERE id=${operationId}`);
      await tx.execute(sql`UPDATE sandbox_resources SET observed_state='unknown', updated_at=NOW() WHERE binding_id=${bindingId}`);
    });
  }
  async function methodResult(userId: string, operationId: string): Promise<SandboxOperationResult> {
    const operation = rows(await getDb().execute(sql`SELECT operation.*, binding.project_id FROM sandbox_method_operations operation JOIN sandbox_provider_bindings binding ON binding.id=operation.binding_id WHERE operation.id=${operationId}`))[0];
    if (!operation || operation.actor_id !== userId) throw new SandboxControllerError("OPERATION_NOT_ADMITTED", "Operation is not available");
    await requireMember(userId, String(operation.project_id));
    const binding = rows(await getDb().execute(sql`SELECT * FROM sandbox_provider_bindings WHERE id=${operation.binding_id}`))[0]!;
    const current = await boundProvider(binding);
    return { id: String(operation.id), group: operation.method_group as SandboxMethodInput["group"], operation: String(operation.method), state: operation.state as SandboxOperationResult["state"], provider: current, ...(operation.receipt ? { receipt: parse<ProviderReceipt>(operation.receipt) } : {}), ...(operation.result ? { result: parse<unknown>(operation.result) } : {}) };
  }
  function nativeCommand(command: NativeWorkspaceCommand): void {
    if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 600_000 || command.argv.length < 3 || command.argv[0] !== "/usr/local/bin/bun" || command.argv[1] !== NATIVE_TOOL_ARTIFACT) throw new SandboxControllerError("INVALID_NATIVE_COMMAND", "Native command does not target the fixed helper");
    const encoded = command.argv.slice(2);
    if (encoded.some(part => part.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(part)) || encoded.join("").length > Math.ceil((32 * 1024) * 4 / 3)) throw new SandboxControllerError("INVALID_NATIVE_COMMAND", "Native helper payload exceeds its fixed bound");
  }
  async function wireMethodInput(operation: Row, providerValue: LocalSandboxProvider): Promise<Record<string, unknown>> {
    const payload = parse<Record<string, unknown>>(operation.input);
    const body: Record<string, unknown> = { ...payload, resourceId: String(operation.provider_resource_id) };
    if (operation.method_group === "sandbox.process.v1" && operation.method === "start") {
      const timeoutMs = body.timeoutMs;
      if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1) throw new SandboxControllerError("INVALID_INPUT", "Process timeout must be a positive integer");
    }
    const requestDigest = await sha256(canonicalJson(body));
    return { ...body, call: { scope: { projectId: String(operation.project_id), bindingId: String(operation.binding_id), generation: providerValue.generation }, operationId: String(operation.id), idempotencyKey: String(operation.idempotency_key), requestDigest } };
  }
  async function reviewed(userId: string, projectId: string, current: LocalSandboxProvider, group: SandboxMethodInput["group"], method: string, input: Record<string, unknown>, table: "sandbox_operations" | "sandbox_method_operations", signal?: AbortSignal): Promise<unknown> {
    if (!invoke) throw new SandboxControllerError("SANDBOX_INVOKER_UNAVAILABLE", "Reviewed sandbox provider invoker is not configured");
    validateProviderMethodValue(group, method as never, "input", input);
    const id = (input.call as SandboxCreateInput["call"]).operationId;
    if (reviewedOperations.has(id)) throw new SandboxControllerError("OPERATION_IN_PROGRESS", "Sandbox operation is already under reviewed execution");
    reviewedOperations.add(id);
    try {
      const response = await invoke(userId, projectId, current, group, method, input, signal);
      validateProviderMethodExchange(group, method as never, input, response);
      const actual = rows(await getDb().execute(sql`SELECT result FROM ${sql.raw(table)} WHERE id=${id}`))[0]?.result;
      if (!actual || canonicalJson(parse(actual)) !== canonicalJson(response)) throw new SandboxControllerError("PROVIDER_RESULT_UNVERIFIED", "Reviewed provider result differs from the durable host result");
      return parse(actual);
    } finally { reviewedOperations.delete(id); }
  }
  async function dispatchMethod(operation: Row, input: Record<string, unknown>): Promise<unknown> {
    const group = String(operation.method_group); const method = String(operation.method);
    if (group === "sandbox.lifecycle.v1" && method === "inspect") return driver.inspect(input as never);
    if (group === "sandbox.process.v1") {
      if (method === "start") return driver.processStart(input as never);
      if (method === "inspect") return driver.processInspect(input as never);
      if (method === "readOutput") return driver.processReadOutput(input as never);
      if (method === "cancel") return driver.processCancel(input as never);
    }
    if (group === "sandbox.files.v1") {
      if (method === "stat") return driver.fileStat(input as never);
      if (method === "list") return driver.fileList(input as never);
      if (method === "read") return driver.fileRead(input as never);
      if (method === "write") return driver.fileWrite(input as never);
      if (method === "mkdir") return driver.fileMkdir(input as never);
      if (method === "remove") return driver.fileRemove(input as never);
      if (method === "chmod") return driver.fileChmod(input as never);
    }
    throw new SandboxControllerError("INVALID_OPERATION", "Unsupported sandbox provider method");
  }
  async function executeRaw(userId: string, operationId: string, signal?: AbortSignal): Promise<unknown> {
      const lifecycle = rows(await getDb().execute(sql`SELECT operation.*, binding.project_id FROM sandbox_operations operation JOIN sandbox_provider_bindings binding ON binding.id = operation.binding_id WHERE operation.id=${operationId}`))[0];
      if (lifecycle) {
        if (lifecycle.actor_id !== userId) throw new SandboxControllerError("OPERATION_NOT_ADMITTED", "Operation is not available for execution");
        await requireMember(userId, String(lifecycle.project_id));
        if (["succeeded", "failed"].includes(String(lifecycle.state)) && lifecycle.result) return parse(lifecycle.result);
        const binding = rows(await getDb().execute(sql`SELECT * FROM sandbox_provider_bindings WHERE id=${lifecycle.binding_id}`))[0]!;
        await boundProvider(binding);
        const claimed = rows(await getDb().execute(sql`UPDATE sandbox_operations SET state='running', claimed_at=NOW() WHERE id=${operationId} AND state IN ('admitted','running','unknown') AND actor_id=${userId} RETURNING *`))[0];
        if (!claimed) throw new SandboxControllerError("OPERATION_IN_PROGRESS", "Operation cannot be claimed");
        let result: ProviderResult;
        try {
          const call = { scope: { projectId: String(binding.project_id), bindingId: String(binding.id), generation: Number(binding.generation) }, operationId, idempotencyKey: String(claimed.idempotency_key), requestDigest: String(claimed.input_digest) };
          const input = parse<{ resourceId?: string }>(claimed.input);
          result = claimed.action === "create" ? await driver.create(parse<SandboxCreateInput>(claimed.input)) : claimed.action === "start" ? await driver.start({ call, resourceId: input.resourceId! }) : claimed.action === "stop" ? await driver.stop({ call, resourceId: input.resourceId! }) : await driver.destroy({ call, resourceId: input.resourceId! });
          validateProviderMethodExchange("sandbox.lifecycle.v1", String(claimed.action) as never, claimed.action === "create" ? parse(claimed.input) : { ...input, call }, result); await settle(operationId, String(binding.id), result);
        } catch (error) { await unknown(operationId, String(binding.id)); throw error; }
        return result!;
      }
      const operation = rows(await getDb().execute(sql`SELECT operation.*, binding.project_id, resource.provider_resource_id FROM sandbox_method_operations operation JOIN sandbox_provider_bindings binding ON binding.id=operation.binding_id JOIN sandbox_resources resource ON resource.id=operation.resource_id WHERE operation.id=${operationId}`))[0];
      if (!operation || operation.actor_id !== userId) throw new SandboxControllerError("OPERATION_NOT_ADMITTED", "Operation is not available for execution");
      await requireMember(userId, String(operation.project_id));
      if (["succeeded", "failed"].includes(String(operation.state)) && operation.result) return parse(operation.result);
      const binding = rows(await getDb().execute(sql`SELECT * FROM sandbox_provider_bindings WHERE id=${operation.binding_id}`))[0]!;
      const current = await boundProvider(binding);
      const claimed = rows(await getDb().execute(sql`UPDATE sandbox_method_operations SET state='running',claimed_at=NOW() WHERE id=${operationId} AND state IN ('admitted','running','unknown') AND actor_id=${userId} RETURNING id`))[0];
      if (!claimed) throw new SandboxControllerError("OPERATION_IN_PROGRESS", "Operation cannot be claimed");
      let result: { receipt?: ProviderReceipt; process?: ProcessResult["process"] };
      try {
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        const input = await wireMethodInput(operation, current);
        validateProviderMethodValue(operation.method_group as SandboxMethodInput["group"], String(operation.method) as never, "input", input);
        result = await dispatchMethod(operation, input) as { receipt?: ProviderReceipt; process?: ProcessResult["process"] };
        const call = input.call as SandboxCreateInput["call"];
        if (!result.receipt) throw new SandboxControllerError("PROVIDER_RECEIPT_MISMATCH", "Provider did not return a receipt");
        receiptMatches(call, result.receipt);
        validateProviderMethodExchange(operation.method_group as SandboxMethodInput["group"], String(operation.method) as never, input, result);
        await getDb().transaction(async (tx: DbTransaction) => {
          await tx.execute(sql`UPDATE sandbox_method_operations SET state=${result.receipt!.outcome},receipt=${JSON.stringify(result.receipt)},result=${JSON.stringify(result)},completed_at=NOW() WHERE id=${operationId}`);
          if (operation.method_group === "sandbox.process.v1" && operation.method === "start") {
            const process = result.process;
            if (result.receipt!.outcome === "succeeded") {
              await tx.execute(sql`INSERT INTO sandbox_processes(id,binding_id,resource_id,operation_id,provider_process_id,state,result) VALUES(${crypto.randomUUID()},${operation.binding_id},${operation.resource_id},${operationId},${process?.identity.processId ?? null},${process?.state ?? 'unknown'},${JSON.stringify(result)}) ON CONFLICT (operation_id) DO UPDATE SET provider_process_id=EXCLUDED.provider_process_id,state=EXCLUDED.state,result=EXCLUDED.result,updated_at=NOW()`);
              await tx.execute(sql`UPDATE sandbox_writer_leases SET state=${process?.state === "running" ? "running" : "unknown"},updated_at=NOW() WHERE operation_id=${operationId}`);
            } else if (result.receipt!.outcome === "failed") await tx.execute(sql`DELETE FROM sandbox_writer_leases WHERE operation_id=${operationId}`);
            else await tx.execute(sql`UPDATE sandbox_writer_leases SET state='unknown',updated_at=NOW() WHERE operation_id=${operationId}`);
          }
          if (operation.method_group === "sandbox.process.v1" && (operation.method === "inspect" || operation.method === "cancel")) {
            const process = result.process;
            if (process) {
              await tx.execute(sql`UPDATE sandbox_processes SET state=${process.state},result=${JSON.stringify(result)},updated_at=NOW() WHERE binding_id=${operation.binding_id} AND provider_process_id=${process.identity.processId}`);
              if (isTerminalProcess(process.state)) await tx.execute(sql`DELETE FROM sandbox_writer_leases WHERE binding_id=${operation.binding_id} AND EXISTS (SELECT 1 FROM sandbox_processes p WHERE p.operation_id=sandbox_writer_leases.operation_id AND p.binding_id=${operation.binding_id} AND p.provider_process_id=${process.identity.processId} AND p.state IN ('exited','cancelled','failed'))`);
            }
          }
          if (operation.method_group === "sandbox.files.v1" && result.receipt!.outcome !== "unknown") await tx.execute(sql`DELETE FROM sandbox_writer_leases WHERE operation_id=${operationId}`);
          if (operation.method_group === "sandbox.lifecycle.v1" && operation.method === "inspect") {
            const resource = (result as ProviderResult).resource;
            if (!resource) throw new SandboxControllerError("PROVIDER_RECEIPT_MISMATCH", "Lifecycle inspection must return a resource");
            await tx.execute(sql`UPDATE sandbox_resources SET desired_state=${resource.desiredState},observed_state=${resource.observedState},updated_at=NOW() WHERE binding_id=${operation.binding_id}`);
            if (["stopped", "destroyed"].includes(resource.observedState)) await tx.execute(sql`DELETE FROM sandbox_writer_leases WHERE binding_id=${operation.binding_id} AND EXISTS (SELECT 1 FROM sandbox_processes p WHERE p.operation_id=sandbox_writer_leases.operation_id AND p.state IN ('exited','cancelled','failed'))`);
          }
        });
      } catch (error) {
        await getDb().execute(sql`UPDATE sandbox_method_operations SET state='unknown',completed_at=NOW() WHERE id=${operationId}`);
        await getDb().execute(sql`UPDATE sandbox_writer_leases SET state='unknown',updated_at=NOW() WHERE operation_id=${operationId}`);
        throw error;
      }
      return result!;
  }
  async function executeMethod(userId: string, operationId: string, signal?: AbortSignal): Promise<SandboxOperationResult> {
    const current = await methodResult(userId, operationId);
    if (["succeeded", "failed"].includes(current.state)) { freshMethodAdmissions.delete(operationId); return current; }
    if (executingMethods.has(operationId)) throw new SandboxControllerError("OPERATION_IN_PROGRESS", "Sandbox method is already under execution");
    executingMethods.add(operationId);
    freshMethodAdmissions.delete(operationId);
    try {
      const operation = rows(await getDb().execute(sql`SELECT operation.*,binding.project_id,resource.provider_resource_id FROM sandbox_method_operations operation JOIN sandbox_provider_bindings binding ON binding.id=operation.binding_id JOIN sandbox_resources resource ON resource.id=operation.resource_id WHERE operation.id=${operationId}`))[0]!;
      await reviewed(userId, String(operation.project_id), current.provider, current.group, current.operation, await wireMethodInput(operation, current.provider), "sandbox_method_operations", signal);
      return methodResult(userId, operationId);
    } finally { executingMethods.delete(operationId); }
  }
  async function reconcileFileWriter(bindingId: string, signal?: AbortSignal): Promise<void> {
    const pending = rows(await getDb().execute(sql`SELECT operation.id,operation.actor_id FROM sandbox_writer_leases lease JOIN sandbox_method_operations operation ON operation.id=lease.operation_id WHERE lease.binding_id=${bindingId} AND operation.method_group='sandbox.files.v1' AND operation.state IN ('admitted','running','unknown')`))[0];
    if (pending && !freshMethodAdmissions.has(String(pending.id))) await executeMethod(String(pending.actor_id), String(pending.id), signal);
  }
  async function reconcileProcessStart(bindingId: string, signal?: AbortSignal): Promise<Row | undefined> {
    const pending = rows(await getDb().execute(sql`SELECT op.id,op.actor_id,op.state FROM sandbox_writer_leases lease JOIN sandbox_method_operations op ON op.id=lease.operation_id WHERE lease.binding_id=${bindingId} AND op.method_group='sandbox.process.v1' AND op.method='start'`))[0];
    if (!pending) return undefined;
    if (pending.state === "failed") {
      await getDb().execute(sql`DELETE FROM sandbox_writer_leases WHERE binding_id=${bindingId} AND operation_id=${pending.id} AND EXISTS (SELECT 1 FROM sandbox_method_operations op WHERE op.id=${pending.id} AND op.state='failed')`);
      return undefined;
    }
    if (pending.state === "admitted" && freshMethodAdmissions.has(String(pending.id))) return pending;
    if (["admitted", "running", "unknown"].includes(String(pending.state))) await executeMethod(String(pending.actor_id), String(pending.id), signal);
    return pending;
  }
  async function reconcileInterruptedMethods(bindingId: string): Promise<void> {
    const pending = rows(await getDb().execute(sql`
      SELECT operation.id, operation.state, operation.method_group, operation.method
      FROM sandbox_method_operations operation
      LEFT JOIN sandbox_writer_leases lease ON lease.operation_id=operation.id
      WHERE operation.binding_id=${bindingId}
        AND lease.operation_id IS NULL
        AND operation.state IN ('admitted','running')
      ORDER BY operation.created_at
    `));
    for (const operation of pending) {
      const id = String(operation.id);
      if (freshMethodAdmissions.has(id) || executingMethods.has(id) || activeRawOperations.has(id)) continue;
      const kind = methodKind(operation.method_group, operation.method);
      if (kind === "cancel" && operation.state === "running") {
        await getDb().execute(sql`UPDATE sandbox_method_operations SET state='unknown',completed_at=NOW() WHERE id=${id} AND state='running'`);
        continue;
      }
      if (kind !== "writer") await getDb().execute(sql`UPDATE sandbox_method_operations SET state='failed',completed_at=NOW() WHERE id=${id} AND state IN ('admitted','running')`);
    }
  }
  return {
    async listLocalSandboxProviders(_userId) {
      const installations = rows(await getDb().execute(sql`SELECT id, payload FROM extension_release_installations`));
      const found: LocalSandboxProvider[] = [];
      for (const row of installations) {
        const installation = parse<{ activeReleaseId: string | null }>(row.payload);
        if (!installation.activeReleaseId) continue;
        const releaseRow = rows(await getDb().execute(sql`SELECT payload FROM extension_release_records WHERE installation_id=${row.id} AND kind='releases' AND id=${installation.activeReleaseId}`))[0];
        if (!releaseRow) continue;
        for (const contribution of parse<{ manifest: { providers?: { id: string; kind: string }[] } }>(releaseRow.payload).manifest.providers ?? []) if (contribution.kind === "sandbox") {
          try { found.push(await provider(String(row.id), contribution.id)); } catch (error) { if (!(error instanceof SandboxControllerError)) throw error; }
        }
      }
      return found;
    },
    async createSandboxProject(userId, input) {
      if (!input.name.trim() || !input.idempotencyKey || input.sourceProjectId) throw new SandboxControllerError("INVALID_INPUT", "Use a non-empty name, idempotency key, and empty workspace for the local MVP");
      const admissionDigest = await sha256(canonicalJson({ name: input.name.trim(), providerInstallationId: input.providerInstallationId, providerId: input.providerId, config: input.config, limits: input.limits }));
      const replay = rows(await getDb().execute(sql`SELECT operation.*, binding.project_id FROM sandbox_operations operation JOIN sandbox_provider_bindings binding ON binding.id=operation.binding_id WHERE operation.actor_id=${userId} AND operation.idempotency_key=${input.idempotencyKey}`))[0];
      if (replay) {
        if (replay.action !== "create" || replay.request_key_digest !== admissionDigest) throw new SandboxControllerError("IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to another request");
        return status(userId, String(replay.project_id));
      }
      const active = await provider(input.providerInstallationId, input.providerId);
      const projectId = crypto.randomUUID(); const bindingId = crypto.randomUUID(); const operationId = crypto.randomUUID(); const idempotencyKey = input.idempotencyKey;
      if (Object.keys(input.config).length) throw new SandboxControllerError("INVALID_INPUT", "The local MVP does not accept provider configuration");
      const configDigest = await sha256(canonicalJson(input.config));
      const call = { scope: { projectId, bindingId, generation: active.generation }, operationId, idempotencyKey, requestDigest: "" };
      const createInput = { call, profile: "linux-exec.v1" as const, limits: input.limits };
      call.requestDigest = await sha256(canonicalJson({ profile: createInput.profile, limits: createInput.limits }));
      validateProviderMethodValue("sandbox.lifecycle.v1", "create", "input", createInput);
      await getDb().transaction(async (tx: DbTransaction) => {
        await tx.execute(sql`INSERT INTO projects (id,name,path,variables) VALUES (${projectId},${input.name.trim()},'',${{}})`);
        await tx.execute(sql`INSERT INTO project_members (id,project_id,user_id,role) VALUES (${crypto.randomUUID()},${projectId},${userId},'owner')`);
        await tx.execute(sql`INSERT INTO sandbox_provider_bindings (id,project_id,owner_id,installation_id,provider_id,release_id,release_binding,generation,config_revision,config_digest) VALUES (${bindingId},${projectId},${userId},${active.installationId},${active.providerId},${active.releaseId},${active.releaseBinding},${active.generation},1,${configDigest})`);
        await tx.execute(sql`INSERT INTO project_workspace_bindings (project_id,kind,binding_id,state) VALUES (${projectId},'sandbox',${bindingId},'unknown')`);
        await tx.execute(sql`INSERT INTO sandbox_resources (id,binding_id,desired_state,observed_state,limits) VALUES (${crypto.randomUUID()},${bindingId},'stopped','creating',${JSON.stringify(input.limits)})`);
        await tx.execute(sql`INSERT INTO sandbox_operations (id,binding_id,resource_id,actor_id,action,idempotency_key,input_digest,request_key_digest,input) VALUES (${operationId},${bindingId},(SELECT id FROM sandbox_resources WHERE binding_id=${bindingId}),${userId},'create',${idempotencyKey},${call.requestDigest},${admissionDigest},${JSON.stringify(createInput)})`);
      });
      return status(userId, projectId);
    },
    getProjectSandboxStatus: status,
    async admitSandboxMethod(userId, projectId, input) {
      const current = await status(userId, projectId);
      if (!current.resource || !input.idempotencyKey || !input.operation) throw new SandboxControllerError("INVALID_INPUT", "A resource, method, and idempotency key are required");
      if (input.conversationId) {
        const conversation = rows(await getDb().execute(sql`SELECT project_id,user_id FROM conversations WHERE id=${input.conversationId}`))[0];
        if (!conversation || conversation.project_id !== projectId || conversation.user_id !== userId) throw new SandboxControllerError("CONVERSATION_ACCESS_DENIED", "Conversation does not belong to the authenticated project member");
      }
      const resource = rows(await getDb().execute(sql`SELECT id FROM sandbox_resources WHERE binding_id=${current.bindingId}`))[0]!;
      const id = crypto.randomUUID();
      const kind = methodKind(input.group, input.operation);
      if (kind === "invalid") throw new SandboxControllerError("INVALID_OPERATION", "Unsupported sandbox provider method");
      const writer = kind === "writer";
      const wire = await wireMethodInput({ input: input.payload, provider_resource_id: current.resource.resourceId, method_group: input.group, method: input.operation, project_id: projectId, binding_id: current.bindingId, id, idempotency_key: input.idempotencyKey }, current.provider);
      validateProviderMethodValue(input.group, input.operation as never, "input", wire);
      freshMethodAdmissions.add(id);
      try {
      const admitted = await getDb().transaction(async (tx: DbTransaction) => {
        await tx.execute(sql`SELECT id FROM sandbox_provider_bindings WHERE id=${current.bindingId} FOR UPDATE`);
        const refreshedResource = rows(await tx.execute(sql`SELECT observed_state FROM sandbox_resources WHERE binding_id=${current.bindingId}`))[0];
        if (refreshedResource?.observed_state === "destroyed") throw new SandboxControllerError("RESOURCE_DESTROYED", "This sandbox has been disposed");
        await requireNoActiveLifecycle(tx, current.bindingId);
      const inserted = rows(await tx.execute(sql`INSERT INTO sandbox_method_operations(id,binding_id,resource_id,actor_id,conversation_id,method_group,method,idempotency_key,input) VALUES(${id},${current.bindingId},${resource.id},${userId},${input.conversationId ?? null},${input.group},${input.operation},${input.idempotencyKey},${JSON.stringify(input.payload)}) ON CONFLICT DO NOTHING RETURNING id`))[0];
      if (!inserted) {
        const existing = rows(await tx.execute(sql`SELECT * FROM sandbox_method_operations WHERE binding_id=${current.bindingId} AND idempotency_key=${input.idempotencyKey}`))[0];
        if (!existing) throw new SandboxControllerError("WRITER_LEASED", "A sandbox writer is already active");
        if (existing.actor_id !== userId || existing.conversation_id !== (input.conversationId ?? null) || existing.method_group !== input.group || existing.method !== input.operation || canonicalJson(parse(existing.input)) !== canonicalJson(input.payload)) throw new SandboxControllerError("IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to another request");
        if (["admitted", "running", "unknown"].includes(String(existing.state))) freshMethodAdmissions.add(String(existing.id));
        return { id: String(existing.id), group: existing.method_group as SandboxMethodInput["group"], operation: String(existing.method), state: existing.state as AdmittedSandboxMethod["state"], provider: current.provider };
      }
      if (writer) {
        const leased = rows(await tx.execute(sql`INSERT INTO sandbox_writer_leases(binding_id,operation_id,state) VALUES(${current.bindingId},${id},'starting') ON CONFLICT DO NOTHING RETURNING binding_id`))[0];
        if (!leased) {
          throw new SandboxControllerError("WRITER_LEASED", "A sandbox writer is already active");
        }
      }
      return { id, group: input.group, operation: input.operation, state: "admitted" as const, provider: current.provider };
      });
      if (admitted.id !== id) freshMethodAdmissions.delete(id);
      return admitted;
      } catch (error) { freshMethodAdmissions.delete(id); throw error; }
    },
    getSandboxOperationResult: methodResult,
    async executeAdmittedSandboxMethod(userId, operationId, signal) {
      return executeMethod(userId, operationId, signal);
    },
    async executeAdmittedLocalSandboxOperationRaw(userId, operationId, signal) {
      requireReviewedWindow(operationId);
      const active = activeRawOperations.get(operationId);
      if (active) return active;
      const pending = executeRaw(userId, operationId, signal);
      activeRawOperations.set(operationId, pending);
      try { return await pending; } finally { activeRawOperations.delete(operationId); }
    },
    async reconcileSandboxProcess(userId, projectId, signal) {
      const current = await status(userId, projectId);
      const retained = await reconcileProcessStart(current.bindingId, signal);
      if (!retained) return null;
      const process = rows(await getDb().execute(sql`SELECT process.*,binding.id AS binding_id,resource.provider_resource_id FROM sandbox_processes process JOIN sandbox_provider_bindings binding ON binding.id=process.binding_id JOIN sandbox_resources resource ON resource.id=process.resource_id WHERE process.operation_id=${retained.id} AND binding.project_id=${projectId}`))[0];
      if (!process) return null;
      const result = parse<ProcessResult>(process.result);
      if (!result.process?.identity) throw new SandboxControllerError("PROCESS_IDENTITY_UNAVAILABLE", "A process identity is required for reconciliation");
      const admitted = await this.admitSandboxMethod(userId, projectId, { group: "sandbox.process.v1", operation: "inspect", idempotencyKey: crypto.randomUUID(), payload: { identity: result.process.identity } });
      const inspected = await this.executeAdmittedSandboxMethod(userId, admitted.id, signal);
      return inspected;
    },
    async runNativeWorkspaceProcess(target, command, signal, principal) {
      nativeCommand(command);
      signal?.throwIfAborted();
      if (!principal.userId || !principal.conversationId) throw new SandboxControllerError("PROJECT_ACCESS_DENIED", "An authenticated workspace principal is required");
      const conversation = rows(await getDb().execute(sql`SELECT project_id,user_id FROM conversations WHERE id=${principal.conversationId}`))[0];
      if (!conversation || conversation.project_id !== target.projectId || conversation.user_id !== principal.userId) throw new SandboxControllerError("CONVERSATION_ACCESS_DENIED", "Conversation does not belong to the authenticated project member");
      const workspace = rows(await getDb().execute(sql`SELECT binding_id,revision FROM project_workspace_bindings WHERE project_id=${target.projectId}`))[0];
      if (!workspace || workspace.binding_id !== target.bindingId || Number(workspace.revision) !== target.revision) throw new SandboxControllerError("STALE_WORKSPACE_BINDING", "Workspace binding changed");
      await this.reconcileSandboxProcess(principal.userId, target.projectId);
      await reconcileFileWriter(target.bindingId, signal);
      const retained = rows(await getDb().execute(sql`SELECT operation_id FROM sandbox_writer_leases WHERE binding_id=${target.bindingId}`))[0];
      if (retained) throw new SandboxControllerError("WRITER_LEASED", "A sandbox writer is already active or awaiting recovery");
      const resource = await status(principal.userId, target.projectId);
      if (resource.resource?.observedState !== "running") {
        const lifecycle = await this.requestSandboxAction(principal.userId, target.projectId, { action: "start", idempotencyKey: crypto.randomUUID() });
        const startedResource = await this.executeAdmittedLocalSandboxOperation(principal.userId, lifecycle.id);
        if (startedResource.resource?.observedState !== "running") throw new SandboxControllerError("RESOURCE_NOT_RUNNING", "Sandbox could not start");
      }
      const method = async (operation: string, payload: Record<string, unknown>) => {
        const admitted = await this.admitSandboxMethod(principal.userId, target.projectId, { group: "sandbox.process.v1", operation, idempotencyKey: crypto.randomUUID(), conversationId: principal.conversationId, payload });
        // Once admitted, cancellation must finish host reconciliation. An
        // aborted caller must not cancel its own cleanup RPC.
        const completed = await this.executeAdmittedSandboxMethod(principal.userId, admitted.id);
        const result = completed.result as ProcessResult;
        if (result.receipt.outcome !== "succeeded") throw new SandboxControllerError("PROCESS_UNAVAILABLE", "The process outcome could not be verified");
        return completed.result;
      };
      const started = await method("start", { argv: command.argv, env: {}, cwd: "/workspace", user: "workspace", timeoutMs: command.timeoutMs }) as ProcessResult;
      if (!started.process) throw new SandboxControllerError("PROCESS_IDENTITY_UNAVAILABLE", "Native process did not return an identity");
      const identity = started.process.identity;
      const deadline = clock.now() + command.timeoutMs + 30_000;
      let cursor = 0; let stdout = ""; let outputBytes = 0; let cancelSent = false;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          if (signal?.aborted && !cancelSent) { await method("cancel", { identity }); cancelSent = true; }
          const inspected = await method("inspect", { identity }) as ProcessResult;
          const terminal = inspected.process!;
          const output = await method("readOutput", { identity, cursor, maxBytes: NATIVE_TOOL_OUTPUT_BYTES }) as { cursor: number; chunks: Array<{ stream: string; encoding: string; data: string }>; eof: boolean; gap: boolean };
          cursor = output.cursor;
          if (output.gap) throw new SandboxControllerError("OUTPUT_INCOMPLETE", "Native process output exceeded its retained bound");
          for (const chunk of output.chunks) if (chunk.stream === "stdout") {
            const bytes = Buffer.from(chunk.data, chunk.encoding === "utf8" ? "utf8" : "base64");
            outputBytes += bytes.length;
            if (outputBytes > NATIVE_TOOL_OUTPUT_BYTES) throw new SandboxControllerError("OUTPUT_INCOMPLETE", "Native process output exceeded its retained bound");
            stdout += decoder.decode(bytes, { stream: true });
          }
          if (isTerminalProcess(terminal.state) && output.eof) {
            await this.reconcileSandboxProcess(principal.userId, target.projectId);
            if (rows(await getDb().execute(sql`SELECT operation_id FROM sandbox_writer_leases WHERE binding_id=${target.bindingId}`)).length) throw new SandboxControllerError("PROCESS_NOT_QUIESCENT", "Process stopped but workspace quiescence is unverified");
            signal?.throwIfAborted();
            if (typeof terminal.exitCode !== "number") throw new SandboxControllerError("NATIVE_RESULT_UNAVAILABLE", "Native process has no verified exit code");
            return { stdout: stdout + decoder.decode(), exitCode: terminal.exitCode };
          }
          if (clock.now() >= deadline) throw new SandboxControllerError("PROCESS_DEADLINE", "Native process did not settle within its deadline");
          if (!output.eof && output.chunks.length) continue;
          await clock.sleep(100);
        }
      } catch (error) {
        if (!cancelSent) await method("cancel", { identity }).catch(() => undefined);
        await this.reconcileSandboxProcess(principal.userId, target.projectId).catch(() => undefined);
        throw error;
      }
    },
    async requestSandboxAction(userId, projectId, input) {
      const current = await status(userId, projectId); if (!current.resource) throw new SandboxControllerError("RESOURCE_MISSING", "Sandbox resource is not created");
      if (current.resource.observedState === "destroyed") throw new SandboxControllerError("RESOURCE_DESTROYED", "This sandbox has been disposed");
      if (!input.idempotencyKey) throw new SandboxControllerError("INVALID_INPUT", "An idempotency key is required");
      await this.reconcileSandboxProcess(userId, projectId);
      await reconcileFileWriter(current.bindingId);
      await reconcileInterruptedMethods(current.bindingId);
      const value = { resourceId: current.resource.resourceId }; const digest = await sha256(canonicalJson(value)); const id = crypto.randomUUID();
      const replay = (operation: Row) => {
        if (operation.actor_id !== userId || operation.action !== input.action || operation.input_digest !== digest) throw new SandboxControllerError("IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to another request");
        return { id: String(operation.id), action: operation.action as AdmittedSandboxOperation["action"], state: operation.state as AdmittedSandboxOperation["state"], input: value, provider: current.provider };
      };
      return getDb().transaction(async (tx: DbTransaction) => {
        await tx.execute(sql`SELECT id FROM sandbox_provider_bindings WHERE id=${current.bindingId} FOR UPDATE`);
        const refreshedResource = rows(await tx.execute(sql`SELECT observed_state FROM sandbox_resources WHERE binding_id=${current.bindingId}`))[0];
        if (refreshedResource?.observed_state === "destroyed") throw new SandboxControllerError("RESOURCE_DESTROYED", "This sandbox has been disposed");
        const existing = rows(await tx.execute(sql`SELECT * FROM sandbox_operations WHERE binding_id=${current.bindingId} AND idempotency_key=${input.idempotencyKey}`))[0];
        if (existing) return replay(existing);
        const pendingSameAction = rows(await tx.execute(sql`SELECT * FROM sandbox_operations WHERE binding_id=${current.bindingId} AND resource_id=(SELECT id FROM sandbox_resources WHERE binding_id=${current.bindingId}) AND action=${input.action} AND state IN ('admitted','running','unknown') ORDER BY created_at DESC LIMIT 1`))[0];
        if (pendingSameAction) {
          if (pendingSameAction.actor_id !== userId) throw new SandboxControllerError("OPERATION_IN_PROGRESS", "A sandbox operation is already admitted or awaiting recovery");
          return replay(pendingSameAction);
        }
        await requireNoActiveLifecycle(tx, current.bindingId);
        await requireNoActiveMethod(tx, current.bindingId);
        const inserted = rows(await tx.execute(sql`INSERT INTO sandbox_operations (id,binding_id,resource_id,actor_id,action,idempotency_key,input_digest,request_key_digest,input) VALUES (${id},${current.bindingId},(SELECT id FROM sandbox_resources WHERE binding_id=${current.bindingId}),${userId},${input.action},${input.idempotencyKey},${digest},${digest},${JSON.stringify(value)}) ON CONFLICT DO NOTHING RETURNING id`))[0];
        if (!inserted) throw new SandboxControllerError("OPERATION_IN_PROGRESS", "A sandbox operation is already admitted or running");
        return { id, action: input.action, state: "admitted", input: value, provider: current.provider };
      });
    },
    async executeAdmittedLocalSandboxOperation(userId, operationId) {
      const operation = rows(await getDb().execute(sql`SELECT operation.*, binding.project_id FROM sandbox_operations operation JOIN sandbox_provider_bindings binding ON binding.id=operation.binding_id WHERE operation.id=${operationId}`))[0];
      if (!operation || operation.actor_id !== userId) throw new SandboxControllerError("OPERATION_NOT_ADMITTED", "Operation is not available for execution");
      await requireMember(userId, String(operation.project_id));
      const binding = rows(await getDb().execute(sql`SELECT * FROM sandbox_provider_bindings WHERE id=${operation.binding_id}`))[0]!;
      const current = await boundProvider(binding);
      if (!["succeeded", "failed"].includes(String(operation.state))) {
        const input = operation.action === "create" ? parse<Record<string, unknown>>(operation.input) : { ...parse<Record<string, unknown>>(operation.input), call: { scope: { projectId: String(binding.project_id), bindingId: String(binding.id), generation: Number(binding.generation) }, operationId, idempotencyKey: String(operation.idempotency_key), requestDigest: String(operation.input_digest) } };
        await reviewed(userId, String(binding.project_id), current, "sandbox.lifecycle.v1", String(operation.action), input, "sandbox_operations");
      }
      return status(userId, String(binding.project_id));
    },
  };
}
