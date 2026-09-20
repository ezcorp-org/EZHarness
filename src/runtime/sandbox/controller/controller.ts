import { canonicalJson, sha256, type ProviderReceipt, type SandboxCreateInput, type SandboxResource } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import { getDb, type DbTransaction } from "../../../db/connection";
import { getProjectMembership } from "../../../db/queries/project-members";
import { getReleaseRuntime, releaseBinding, resolveActiveRelease, type ActiveExtensionRelease, type ReleaseRuntimeDependencies } from "../../../extensions/release-process";
import { SandboxControllerError, type AdmittedSandboxMethod, type AdmittedSandboxOperation, type LocalSandboxDriver, type LocalSandboxProvider, type SandboxController, type SandboxMethodInput, type SandboxOperationResult, type SandboxProjectStatus, type SandboxProviderInvocation } from "./types";

type Row = Record<string, unknown>;
type ProviderResult = { receipt: ProviderReceipt; resource?: SandboxResource };

function rows(value: unknown): Row[] { return (value as { rows?: Row[] }).rows ?? []; }
function parse<T>(value: unknown): T { return typeof value === "string" ? JSON.parse(value) as T : value as T; }
async function requireMember(userId: string, projectId: string): Promise<void> {
  if (!await getProjectMembership(userId, projectId)) throw new SandboxControllerError("PROJECT_ACCESS_DENIED", "Project membership is required");
}
function receiptMatches(call: SandboxCreateInput["call"], receipt: ProviderReceipt): void {
  if (receipt.operationId !== call.operationId || receipt.idempotencyKey !== call.idempotencyKey || receipt.requestDigest !== call.requestDigest) throw new SandboxControllerError("PROVIDER_RECEIPT_MISMATCH", "Provider receipt does not match the admitted operation");
}
function resourceState(receipt: ProviderReceipt): "failed" | "unknown" { return receipt.outcome === "failed" ? "failed" : "unknown"; }

export function createSandboxController(driver: LocalSandboxDriver, runtime: Pick<ReleaseRuntimeDependencies, "resolve"> = getReleaseRuntime(), invoke?: SandboxProviderInvocation): SandboxController {
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
      await tx.execute(sql`UPDATE sandbox_operations SET state=${result.receipt.outcome}, receipt=${JSON.stringify(result.receipt)}, completed_at=NOW() WHERE id=${operationId}`);
      if (result.resource) await tx.execute(sql`UPDATE sandbox_resources SET provider_resource_id=${result.resource.resourceId}, desired_state=${result.resource.desiredState}, observed_state=${result.resource.observedState}, updated_at=NOW() WHERE binding_id=${bindingId}`);
      else if (result.receipt.outcome !== "succeeded") await tx.execute(sql`UPDATE sandbox_resources SET observed_state=${resourceState(result.receipt)}, updated_at=NOW() WHERE binding_id=${bindingId}`);
      if (result.receipt.outcome === "succeeded" && result.resource) await tx.execute(sql`UPDATE project_workspace_bindings SET state='active', updated_at=NOW() WHERE binding_id=${bindingId}`);
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
    if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.argv.length < 3 || command.argv[0] !== "/usr/local/bin/bun" || command.argv[1] !== "/opt/ezharness/native-tools.js") throw new SandboxControllerError("INVALID_NATIVE_COMMAND", "Native command does not target the fixed helper");
    const encoded = command.argv.slice(2);
    if (encoded.some(part => part.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(part)) || encoded.join("").length > Math.ceil((32 * 1024) * 4 / 3)) throw new SandboxControllerError("INVALID_NATIVE_COMMAND", "Native helper payload exceeds its fixed bound");
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
      const configDigest = await sha256(canonicalJson(input.config));
      const call = { scope: { projectId, bindingId, generation: active.generation }, operationId, idempotencyKey, requestDigest: "" };
      const createInput = { call, profile: "linux-exec.v1" as const, limits: input.limits };
      call.requestDigest = await sha256(canonicalJson({ profile: createInput.profile, limits: createInput.limits }));
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
      const writer = (input.group === "sandbox.process.v1" && input.operation === "start") || (input.group === "sandbox.files.v1" && ["write", "mkdir", "remove", "chmod"].includes(input.operation));
      const inserted = rows(await getDb().execute(sql`INSERT INTO sandbox_method_operations(id,binding_id,resource_id,actor_id,conversation_id,method_group,method,idempotency_key,input) VALUES(${id},${current.bindingId},${resource.id},${userId},${input.conversationId ?? null},${input.group},${input.operation},${input.idempotencyKey},${JSON.stringify(input.payload)}) ON CONFLICT DO NOTHING RETURNING id`))[0];
      if (!inserted) {
        const existing = rows(await getDb().execute(sql`SELECT * FROM sandbox_method_operations WHERE binding_id=${current.bindingId} AND idempotency_key=${input.idempotencyKey}`))[0];
        if (!existing) throw new SandboxControllerError("WRITER_LEASED", "A sandbox writer is already active");
        if (existing.actor_id !== userId || existing.method_group !== input.group || existing.method !== input.operation || canonicalJson(parse(existing.input)) !== canonicalJson(input.payload)) throw new SandboxControllerError("IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to another request");
        return { id: String(existing.id), group: existing.method_group as SandboxMethodInput["group"], operation: String(existing.method), state: existing.state as AdmittedSandboxMethod["state"], provider: current.provider };
      }
      if (writer) {
        const leased = rows(await getDb().execute(sql`INSERT INTO sandbox_writer_leases(binding_id,operation_id,state) VALUES(${current.bindingId},${id},'starting') ON CONFLICT DO NOTHING RETURNING binding_id`))[0];
        if (!leased) {
          await getDb().execute(sql`UPDATE sandbox_method_operations SET state='failed',completed_at=NOW() WHERE id=${id}`);
          throw new SandboxControllerError("WRITER_LEASED", "A sandbox writer is already active");
        }
      }
      return { id, group: input.group, operation: input.operation, state: "admitted", provider: current.provider };
    },
    getSandboxOperationResult: methodResult,
    async executeAdmittedSandboxMethod(userId, operationId, signal) {
      const current = await methodResult(userId, operationId);
      if (current.state !== "admitted") return current;
      if (!invoke) throw new SandboxControllerError("SANDBOX_INVOKER_UNAVAILABLE", "Reviewed sandbox provider invoker is not configured");
      const operation = rows(await getDb().execute(sql`SELECT operation.*,binding.project_id,resource.provider_resource_id FROM sandbox_method_operations operation JOIN sandbox_provider_bindings binding ON binding.id=operation.binding_id JOIN sandbox_resources resource ON resource.id=operation.resource_id WHERE operation.id=${operationId}`))[0]!;
      const claimed = rows(await getDb().execute(sql`UPDATE sandbox_method_operations SET state='running',claimed_at=NOW() WHERE id=${operationId} AND state='admitted' AND actor_id=${userId} RETURNING id`))[0];
      if (!claimed) return methodResult(userId, operationId);
      try {
        const payload = parse<Record<string, unknown>>(operation.input);
        const requestDigest = await sha256(canonicalJson(payload));
        const result = await invoke(userId, String(operation.project_id), current.provider, operation.method_group as SandboxMethodInput["group"], String(operation.method), { ...payload, resourceId: operation.provider_resource_id, call: { scope: { projectId: String(operation.project_id), bindingId: String(operation.binding_id), generation: current.provider.generation }, operationId, idempotencyKey: String(operation.idempotency_key), requestDigest } }, signal);
        const record = result as { receipt?: ProviderReceipt; process?: { identity?: { processId?: string }; state?: string } };
        if (!record.receipt || record.receipt.operationId !== operationId || record.receipt.idempotencyKey !== operation.idempotency_key || record.receipt.requestDigest !== requestDigest) throw new SandboxControllerError("PROVIDER_RECEIPT_MISMATCH", "Provider receipt does not match the admitted operation");
        await getDb().transaction(async (tx: DbTransaction) => {
          await tx.execute(sql`UPDATE sandbox_method_operations SET state=${record.receipt!.outcome},receipt=${JSON.stringify(record.receipt)},result=${JSON.stringify(result)},completed_at=NOW() WHERE id=${operationId}`);
          if (operation.method_group === "sandbox.process.v1" && operation.method === "start") await tx.execute(sql`INSERT INTO sandbox_processes(id,binding_id,resource_id,operation_id,provider_process_id,state,result) VALUES(${crypto.randomUUID()},${operation.binding_id},${operation.resource_id},${operationId},${record.process?.identity?.processId ?? null},${record.process?.state ?? 'unknown'},${JSON.stringify(result)}) ON CONFLICT (operation_id) DO UPDATE SET state=EXCLUDED.state,result=EXCLUDED.result,updated_at=NOW()`);
          if (operation.method_group === "sandbox.process.v1" && operation.method === "start") await tx.execute(sql`UPDATE sandbox_writer_leases SET state=${record.process?.state === "running" ? "running" : "unknown"},updated_at=NOW() WHERE operation_id=${operationId}`);
        });
      } catch (error) {
        await getDb().execute(sql`UPDATE sandbox_method_operations SET state='unknown',completed_at=NOW() WHERE id=${operationId}`);
        await getDb().execute(sql`UPDATE sandbox_writer_leases SET state='unknown',updated_at=NOW() WHERE operation_id=${operationId}`);
        throw error;
      }
      return methodResult(userId, operationId);
    },
    async reconcileSandboxProcess(userId, projectId, signal) {
      const current = await status(userId, projectId);
      const process = rows(await getDb().execute(sql`SELECT process.*,binding.id AS binding_id,resource.provider_resource_id FROM sandbox_processes process JOIN sandbox_provider_bindings binding ON binding.id=process.binding_id JOIN sandbox_resources resource ON resource.id=process.resource_id WHERE binding.project_id=${projectId} ORDER BY process.updated_at DESC LIMIT 1`))[0];
      if (!process) return null;
      if (!invoke) throw new SandboxControllerError("SANDBOX_INVOKER_UNAVAILABLE", "Reviewed sandbox provider invoker is not configured");
      const idempotencyKey = `inspect:${process.id}`;
      const requestDigest = await sha256(canonicalJson({ resourceId: process.provider_resource_id }));
      const result = await invoke(userId, projectId, current.provider, "sandbox.lifecycle.v1", "inspect", { resourceId: process.provider_resource_id, call: { scope: { projectId, bindingId: current.bindingId, generation: current.provider.generation }, operationId: String(process.operation_id), idempotencyKey, requestDigest } }, signal) as { receipt?: ProviderReceipt; resource?: SandboxResource };
      if (!result.receipt || !result.resource) throw new SandboxControllerError("PROVIDER_RECEIPT_MISMATCH", "Lifecycle inspect must return a receipt and resource");
      await getDb().transaction(async (tx: DbTransaction) => {
        await tx.execute(sql`UPDATE sandbox_resources SET observed_state=${result.resource!.observedState},desired_state=${result.resource!.desiredState},updated_at=NOW() WHERE binding_id=${current.bindingId}`);
        if (["stopped", "destroyed"].includes(result.resource.observedState)) await tx.execute(sql`DELETE FROM sandbox_writer_leases WHERE binding_id=${current.bindingId}`);
      });
      return methodResult(userId, String(process.operation_id));
    },
    async runNativeWorkspaceProcess(target, command, signal, principal) {
      nativeCommand(command);
      if (!principal.userId || !principal.conversationId) throw new SandboxControllerError("PROJECT_ACCESS_DENIED", "An authenticated workspace principal is required");
      const workspace = rows(await getDb().execute(sql`SELECT binding_id,revision FROM project_workspace_bindings WHERE project_id=${target.projectId}`))[0];
      if (!workspace || workspace.binding_id !== target.bindingId || Number(workspace.revision) !== target.revision) throw new SandboxControllerError("STALE_WORKSPACE_BINDING", "Workspace binding changed");
      const admitted = await this.admitSandboxMethod(principal.userId, target.projectId, { group: "sandbox.process.v1", operation: "start", idempotencyKey: `native:${principal.conversationId}:${await sha256(canonicalJson(command))}`, conversationId: principal.conversationId, payload: { argv: command.argv, env: {}, cwd: "/workspace", user: "workspace", timeoutMs: command.timeoutMs } });
      const settled = await this.executeAdmittedSandboxMethod(principal.userId, admitted.id, signal);
      const output = settled.result as { stdout?: unknown; exitCode?: unknown } | undefined;
      if (typeof output?.stdout !== "string" || !Number.isSafeInteger(output.exitCode)) throw new SandboxControllerError("NATIVE_RESULT_UNAVAILABLE", "Native process did not return a terminal result");
      return { stdout: output.stdout, exitCode: output.exitCode };
    },
    async requestSandboxAction(userId, projectId, input) {
      const current = await status(userId, projectId); if (!current.resource) throw new SandboxControllerError("RESOURCE_MISSING", "Sandbox resource is not created");
      if (!input.idempotencyKey) throw new SandboxControllerError("INVALID_INPUT", "An idempotency key is required");
      const value = { resourceId: current.resource.resourceId }; const digest = await sha256(canonicalJson(value)); const id = crypto.randomUUID();
      const inserted = rows(await getDb().execute(sql`INSERT INTO sandbox_operations (id,binding_id,resource_id,actor_id,action,idempotency_key,input_digest,request_key_digest,input) VALUES (${id},${current.bindingId},(SELECT id FROM sandbox_resources WHERE binding_id=${current.bindingId}),${userId},${input.action},${input.idempotencyKey},${digest},${digest},${JSON.stringify(value)}) ON CONFLICT DO NOTHING RETURNING id`))[0];
      if (!inserted) {
        const existing = rows(await getDb().execute(sql`SELECT * FROM sandbox_operations WHERE binding_id=${current.bindingId} AND idempotency_key=${input.idempotencyKey}`))[0];
        if (!existing) throw new SandboxControllerError("OPERATION_IN_PROGRESS", "A sandbox operation is already admitted or running");
        if (existing.actor_id !== userId || existing.action !== input.action || existing.input_digest !== digest) throw new SandboxControllerError("IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to another request");
        return { id: String(existing.id), action: existing.action as AdmittedSandboxOperation["action"], state: existing.state as AdmittedSandboxOperation["state"], input: value, provider: current.provider };
      }
      return { id, action: input.action, state: "admitted", input: value, provider: current.provider };
    },
    async executeAdmittedLocalSandboxOperation(userId, operationId) {
      const operation = rows(await getDb().execute(sql`SELECT operation.*, binding.project_id FROM sandbox_operations operation JOIN sandbox_provider_bindings binding ON binding.id = operation.binding_id WHERE operation.id=${operationId}`))[0];
      if (!operation || operation.actor_id !== userId) throw new SandboxControllerError("OPERATION_NOT_ADMITTED", "Operation is not available for execution");
      await requireMember(userId, String(operation.project_id));
      if (["succeeded", "failed", "unknown"].includes(String(operation.state))) return status(userId, String(operation.project_id));
      const binding = rows(await getDb().execute(sql`SELECT * FROM sandbox_provider_bindings WHERE id=${operation.binding_id}`))[0]!;
      await boundProvider(binding);
      const claimed = rows(await getDb().execute(sql`UPDATE sandbox_operations SET state='running', claimed_at=NOW() WHERE id=${operationId} AND state='admitted' AND actor_id=${userId} RETURNING *`))[0];
      if (!claimed) throw new SandboxControllerError("OPERATION_NOT_ADMITTED", "Operation is already running");
      try {
        await boundProvider(binding);
        const call = { scope: { projectId: String(binding.project_id), bindingId: String(binding.id), generation: Number(binding.generation) }, operationId, idempotencyKey: String(claimed.idempotency_key), requestDigest: String(claimed.input_digest) };
        const input = parse<{ resourceId?: string }>(claimed.input);
        const result = claimed.action === "create" ? await driver.create(parse<SandboxCreateInput>(claimed.input)) : claimed.action === "start" ? await driver.start({ call, resourceId: input.resourceId! }) : claimed.action === "stop" ? await driver.stop({ call, resourceId: input.resourceId! }) : claimed.action === "destroy" ? await driver.destroy({ call, resourceId: input.resourceId! }) : (() => { throw new SandboxControllerError("INVALID_OPERATION", "Unsupported sandbox operation"); })();
        receiptMatches(call, result.receipt);
        if (result.receipt.outcome === "succeeded" && !result.resource) throw new SandboxControllerError("PROVIDER_RECEIPT_MISMATCH", "Successful lifecycle receipts must include a resource");
        await settle(operationId, String(binding.id), result);
      } catch (error) {
        await unknown(operationId, String(binding.id));
        throw error;
      }
      return status(userId, String(binding.project_id));
    },
  };
}
