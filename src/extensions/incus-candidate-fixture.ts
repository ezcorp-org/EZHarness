import { canonicalJson, validateInvocationContext, type InvocationContext, type ReleaseRecord } from "@ezcorp/extension-contract";
import { LifecycleError } from "./v4/types";

export const INCUS_CANDIDATE_RPC = "ezcorp/provider.incus.transport";
export const INCUS_CANDIDATE_CONNECTION = "host-candidate-conformance";

const config = {
  connectionId: INCUS_CANDIDATE_CONNECTION,
  serverCertificateSha256: "a".repeat(64),
  project: "ezharness",
  profile: "compose",
  helperVersion: "0.1.0",
  guestUser: "sandbox",
};

/** A read-only synthetic probe for the real Incus worker's candidate test. */
export function incusCandidateFixture(release: ReleaseRecord) {
  if (release.manifest.name !== "incus-sandbox") return null;
  const provider = release.manifest.sandboxProviders?.find(item => item.id === "incus");
  if (!provider) return null;
  return {
    config,
    respond(raw: unknown, context: InvocationContext): unknown {
      const denied = () => { throw new LifecycleError("test_effect_denied", "Only the bounded Incus candidate probe is allowed."); };
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return denied();
      const envelope = raw as Record<string, unknown>;
      let sameContext = false;
      try { sameContext = canonicalJson(validateInvocationContext(envelope.context)) === canonicalJson(context); }
      catch { return denied(); }
      if (!sameContext || !envelope.input || typeof envelope.input !== "object" || Array.isArray(envelope.input)) return denied();
      const command = (envelope.input as Record<string, unknown>).command;
      if (!command || typeof command !== "object" || Array.isArray(command)) return denied();
      const request = command as Record<string, unknown>;
      const payload = request.payload as Record<string, unknown> | undefined;
      const preset = provider.presets.find(item => item.id === payload?.presetId);
      if (request.action !== "probe" || request.connectionId !== config.connectionId ||
        canonicalJson(request.pins) !== canonicalJson(config) || !payload || payload.allocate !== false ||
        payload.providerId !== provider.id || !preset || payload.profile !== preset.profile ||
        typeof payload.presetDigest !== "string" || typeof payload.effectiveSettingsDigest !== "string" ||
        canonicalJson(request.tags) !== canonicalJson({ managedBy: "ezharness-incus-sandbox", connectionId: config.connectionId })) return denied();
      return { ok: true, result: {
        serverCertificateSha256: config.serverCertificateSha256,
        project: config.project,
        profile: config.profile,
        helperVersion: config.helperVersion,
        backendApi: preset.requirements.backendApis[0],
        backendVersion: "host-conformance-v1",
        architecture: preset.requirements.architectures[0],
        storageDriver: preset.requirements.storageDrivers[0],
        isolation: preset.requirements.isolation[0],
        nestedCompose: preset.requirements.nestedCompose,
        controls: { restrictedProject: true, unprivileged: true, projectLimits: true,
          privateNetwork: true, workspaceRoot: "/workspace", explicitGuestUser: true,
          atomicFileReplace: true, durableProcesses: true, boundedOutput: true, endpointProxy: true },
      } };
    },
  };
}
