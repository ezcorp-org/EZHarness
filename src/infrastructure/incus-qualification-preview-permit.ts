import { sameSandboxWorkspaceBinding, type SandboxWorkspaceBinding,
  type SandboxWorkspaceTarget } from "../runtime/workspaces/target";

export interface QualificationPreviewPermitKey {
  previewId: string;
  userId: string;
  conversationId: string;
  binding: SandboxWorkspaceBinding;
}

export interface QualificationPreviewPermitState {
  runId: string;
  nonce: string;
  state: string;
  fixtureOperationId: string;
  fixtureBindingId: string;
  fixtureGeneration: number;
  connectionRevision: number;
  releaseDigest: string;
  binding: SandboxWorkspaceBinding;
  running: boolean;
}

export type QualificationPreviewTargetRegistrar = (key: QualificationPreviewPermitKey,
  resolve: () => Promise<SandboxWorkspaceTarget | undefined>) => () => void;

/** A claimed fixture may use the normal preview gate for one short host run.
 * The registration has no browser or model input and never survives restart. */
export async function registerClaimedQualificationPreview(input: {
  key: QualificationPreviewPermitKey;
  runId: string;
  nonce: string;
  fixtureOperationId: string;
  connectionRevision: number;
  releaseDigest: string;
  expiresAtMs: number;
  target: SandboxWorkspaceTarget;
}, deps: {
  register: QualificationPreviewTargetRegistrar;
  readCurrent: () => Promise<QualificationPreviewPermitState | null>;
  now?: () => number;
}): Promise<() => void> {
  const now = deps.now ?? Date.now;
  if (!input.key.previewId || !input.key.userId || !input.key.conversationId
    || !input.runId || !input.nonce || !input.fixtureOperationId
    || !Number.isSafeInteger(input.connectionRevision) || input.connectionRevision < 1
    || !/^[a-f0-9]{64}$/.test(input.releaseDigest)
    || !Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= now()
    || input.expiresAtMs > now() + 120_000
    || input.target.kind !== "sandbox" || !input.target.backend?.previews
    || !sameSandboxWorkspaceBinding(input.key.binding, input.target.binding)) {
    throw new Error("Qualification preview permit is unavailable");
  }
  const current = async (): Promise<SandboxWorkspaceTarget | undefined> => {
    if (now() >= input.expiresAtMs) return undefined;
    const value = await deps.readCurrent().catch(() => null);
    if (!value || value.state !== "CLAIMED" || value.runId !== input.runId || value.nonce !== input.nonce
      || value.fixtureOperationId !== input.fixtureOperationId
      || value.fixtureBindingId !== input.key.binding.workspaceId
      || value.fixtureGeneration !== input.key.binding.generation
      || value.connectionRevision !== input.connectionRevision
      || value.releaseDigest !== input.releaseDigest || !value.running
      || !sameSandboxWorkspaceBinding(value.binding, input.key.binding)) return undefined;
    return input.target;
  };
  if (!await current()) throw new Error("Qualification preview fixture is not claimed and running");
  return deps.register(input.key, current);
}
