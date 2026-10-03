import type { NewSandboxBinding } from "../../db/schema";

export function sandboxBindingRow(projectId: string): NewSandboxBinding {
  return {
    id: crypto.randomUUID(),
    projectId,
    providerInstallationId: "provider-installation",
    providerReleaseId: "release",
    connectionId: "connection",
    desiredState: "RUNNING",
    observedState: "RUNNING",
  };
}
