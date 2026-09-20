import { ContractError, canonicalJson, sha256, validateProviderMethodExchange, validateProviderMethodValue, type SandboxProviderGroup } from "@ezcorp/extension-contract";
import { getProjectMembership } from "../../db/queries/project-members";
import { getProject } from "../../db/queries/projects";
import { getUserById } from "../../db/queries/users";
import { registerCallProvenance, releaseCallProvenance } from "../../extensions/call-provenance";
import { getPermissionEngine } from "../../extensions/permission-engine";
import { getExtensionProjectBinding } from "../../extensions/project-binding";
import { getReleaseRuntime, ReleaseProcess, releaseBinding, resolveActiveRelease } from "../../extensions/release-process";
import { ExtensionRegistry } from "../../extensions/registry";
import { ToolExecutor } from "../../extensions/tool-executor";

export interface SandboxProviderReference {
  installationId: string;
  providerId: string;
  releaseId: string;
  releaseBinding: string;
  generation: number;
}

export async function invokeSandboxProvider(
  userId: string,
  projectId: string,
  provider: SandboxProviderReference,
  group: SandboxProviderGroup,
  operation: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  validateProviderMethodValue(group, operation as never, "input", input);
  const runtime = getReleaseRuntime();
  const registry = ExtensionRegistry.getInstance();
  const snapshot = await assertLiveProviderInvocation(userId, projectId, provider, group, operation, input, runtime, registry);
  const process = new ReleaseProcess(provider.installationId, runtime);
  const executor = new ToolExecutor(registry, getPermissionEngine());
  await executor.ensureSubprocessRpcWired(provider.installationId, process);
  const token = registerCallProvenance({
    actorExtensionId: provider.installationId,
    onBehalfOf: userId,
    conversationId: null,
    projectId,
    projectBindingId: (input as { call: { scope: { bindingId: string } } }).call.scope.bindingId,
    runId: null,
    parentCallId: null,
    kind: "tool",
    ownerless: false,
  });
  try {
    signal?.throwIfAborted();
    const mappedMethod = providerMethod(snapshot.release.manifest.providers, provider.providerId, group, operation);
    const response = await process.call(mappedMethod, {
      ...(input as Record<string, unknown>),
      _meta: {
        ezCallId: token,
        releaseId: provider.releaseId,
        expectedGeneration: provider.generation,
        expectedReleaseBinding: await sha256(provider.releaseBinding),
      },
    }, {
      signal,
      invocationGuard: async () => {
        await assertLiveProviderInvocation(userId, projectId, provider, group, operation, input, runtime, registry);
      },
    });
    validateProviderMethodExchange(group, operation as never, input, response.result);
    return response.result;
  } finally {
    releaseCallProvenance(token);
    process.kill();
    await process.whenCallsSettled();
  }
}

async function assertLiveProviderInvocation(
  userId: string,
  projectId: string,
  provider: SandboxProviderReference,
  group: SandboxProviderGroup,
  operation: string,
  input: unknown,
  runtime: ReturnType<typeof getReleaseRuntime>,
  registry: ExtensionRegistry,
) {
  const [user, project, membership, snapshot, binding] = await Promise.all([
    getUserById(userId),
    getProject(projectId),
    getProjectMembership(userId, projectId),
    resolveActiveRelease(provider.installationId, runtime),
    getExtensionProjectBinding(provider.installationId),
  ]);
  if (user?.status !== "active" || !project || !membership) throw new ContractError("CAPABILITY_DENIED", "An active project member is required.");
  if (snapshot.release.id !== provider.releaseId || snapshot.installation.generation !== provider.generation || releaseBinding(snapshot) !== provider.releaseBinding) throw new ContractError("RELEASE_CHANGED", "Sandbox provider release changed.");
  if (!binding || binding.projectId !== projectId || binding.releaseId !== provider.releaseId || binding.generation !== provider.generation) throw new ContractError("CAPABILITY_DENIED", "Sandbox provider is not approved for this project.");
  const call = (input as { call?: { scope?: { projectId?: unknown; bindingId?: unknown; generation?: unknown } } }).call;
  if (call?.scope?.projectId !== projectId || call.scope.bindingId !== binding.id || call.scope.generation !== provider.generation) throw new ContractError("INVALID_PROVIDER_VALUE", "Provider call scope does not match the approved project binding.");
  const mappedMethod = providerMethod(snapshot.release.manifest.providers, provider.providerId, group, operation);
  const registeredManifest = registry.getManifest(provider.installationId);
  const registeredGrants = registry.getGrantedPermissions(provider.installationId);
  if (!registeredManifest || !registeredGrants || canonicalJson(registeredManifest) !== canonicalJson(snapshot.release.manifest) || canonicalJson(registeredGrants) !== canonicalJson(snapshot.installation.grants)) throw new ContractError("RELEASE_CHANGED", "Sandbox provider broker is not bound to the active release.");
  if (!snapshot.release.manifest.methods?.some(method => method.name === mappedMethod && method.sensitivity === "ordinary")) throw new ContractError("SENSITIVE_METHOD_REQUIRES_BROKER", "Sandbox provider method is not eligible for host invocation.");
  return snapshot;
}

function providerMethod(providers: readonly unknown[] | undefined, providerId: string, group: SandboxProviderGroup, operation: string): string {
  const provider = providers?.find((value): value is { id: string; kind: string; methodGroups: Array<{ name: string; methods: Record<string, string> }> } => Boolean(value) && typeof value === "object" && (value as { id?: unknown }).id === providerId);
  const method = provider?.kind === "sandbox" ? provider.methodGroups.find(candidate => candidate.name === group)?.methods[operation] : undefined;
  if (!method) throw new ContractError("UNDECLARED_CONTRIBUTION", "Sandbox provider method is not declared by the active release.");
  return method;
}
