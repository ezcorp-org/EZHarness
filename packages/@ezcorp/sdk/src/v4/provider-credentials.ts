import { Buffer } from "node:buffer";
import { ContractError, validateInvocationContext } from "@ezcorp/extension-contract";
import type { InvocationContext } from "@ezcorp/extension-contract";

export const SENSITIVE_PROVIDER_METHOD = "provider/credentials.resolve";
export const MAX_PROVIDER_CREDENTIAL_BYTES = 16 * 1024;

export interface ProviderCredentialInput {
  providerId: string;
  connectionId: string;
  name: string;
  scope: {
    extensionId: string;
    userId: string;
    conversationId: string | null;
  };
}

type SensitiveEnvelope =
  | { kind: "provider-credential"; missing: true }
  | { kind: "provider-credential"; encoding: "base64"; data: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractError("INVALID_REQUEST", "Sensitive provider input is invalid");
  return value as Record<string, unknown>;
}

function bounded(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}

export function parseProviderCredentialRequest(value: unknown): { input: ProviderCredentialInput; context: InvocationContext } {
  const params = record(value);
  if (Object.keys(params).some(key => !["providerId", "connectionId", "name", "scope", "context"].includes(key))) throw new ContractError("INVALID_REQUEST", "Sensitive provider input is invalid");
  const scope = record(params.scope);
  if (Object.keys(scope).some(key => !["extensionId", "userId", "conversationId"].includes(key))
    || !bounded(params.providerId, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
    || !bounded(params.connectionId, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
    || !bounded(params.name, /^[A-Z][A-Z0-9_]{0,127}$/)
    || !bounded(scope.extensionId, /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
    || !boundedText(scope.userId)
    || (scope.conversationId !== null && !boundedText(scope.conversationId))) throw new ContractError("INVALID_REQUEST", "Sensitive provider input is invalid");
  return {
    input: Object.freeze({
      providerId: params.providerId,
      connectionId: params.connectionId,
      name: params.name,
      scope: Object.freeze({ extensionId: scope.extensionId, userId: scope.userId, conversationId: scope.conversationId }),
    }),
    context: validateInvocationContext(params.context),
  } as { input: ProviderCredentialInput; context: InvocationContext };
}

export function encodeProviderCredential(value: unknown): SensitiveEnvelope {
  if (value === null) return { kind: "provider-credential", missing: true };
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) throw new ContractError("INVALID_RESPONSE", "Provider credential is invalid");
  const bytes = Buffer.from(value, "utf8");
  try {
    if (bytes.byteLength > MAX_PROVIDER_CREDENTIAL_BYTES) throw new ContractError("INVALID_RESPONSE", "Provider credential is invalid");
    return { kind: "provider-credential", encoding: "base64", data: bytes.toString("base64") };
  } finally {
    bytes.fill(0);
  }
}
