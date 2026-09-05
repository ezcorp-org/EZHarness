import { LifecycleError } from "./v4/types";

export type ExtensionSourceInput = (
  | { kind: "marketplace"; versionId: string }
  | { kind: "bundled"; name: string }
  | { kind: "local"; path: string }
  | { kind: "github"; repository: string; ref?: string; directory?: string; projectId?: string }) & { targetInstallationId?: string };

export function parseExtensionSourceInput(value: unknown): ExtensionSourceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LifecycleError("invalid_input", "Provide an extension source object");
  const input = value as Record<string, unknown>;
  const fields = input.kind === "github" ? ["repository", "ref", "directory", "projectId"] : input.kind === "marketplace" ? ["versionId"] : input.kind === "bundled" ? ["name"] : input.kind === "local" ? ["path"] : null;
  if (!fields || Object.keys(input).some((key) => !["kind", "targetInstallationId", ...fields].includes(key)) || typeof input[fields[0]!] !== "string" || !input[fields[0]!]) throw new LifecycleError("invalid_input", "Unknown source fields or missing source identity");
  for (const field of [...fields, "targetInstallationId"]) if (input[field] !== undefined && (typeof input[field] !== "string" || (input[field] as string).length > 4096)) throw new LifecycleError("invalid_input", "Source fields must be bounded strings");
  if (input.targetInstallationId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(input.targetInstallationId as string)) throw new LifecycleError("invalid_input", "Invalid target installation identifier");
  return { ...input } as ExtensionSourceInput;
}
