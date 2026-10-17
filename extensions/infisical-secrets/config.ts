import {
  ContractError,
  compileValueSchema,
  type JsonValue,
  type ValueSchema,
} from "@ezcorp/extension-contract";

export interface InfisicalCredentialMapping {
  credentialName: string;
  secretName: string;
  allowedExtensionIds: readonly string[];
}

export interface InfisicalConnectionConfig {
  endpoint: string;
  projectId: string;
  environment: string;
  secretPath: string;
  connectionId: string;
  machineIdentityAuthReference: string;
  credentials: readonly InfisicalCredentialMapping[];
}

export const INFISICAL_CONNECTION_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    endpoint: { type: "string", minLength: 9, maxLength: 2048 },
    projectId: { type: "string", minLength: 36, maxLength: 36 },
    environment: { type: "string", minLength: 1, maxLength: 64 },
    secretPath: { type: "string", minLength: 1, maxLength: 256 },
    connectionId: { type: "string", minLength: 1, maxLength: 128 },
    machineIdentityAuthReference: {
      type: "string",
      minLength: 13,
      maxLength: 139,
    },
    credentials: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        type: "object",
        properties: {
          credentialName: { type: "string", minLength: 1, maxLength: 128 },
          secretName: { type: "string", minLength: 1, maxLength: 128 },
          allowedExtensionIds: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
        required: ["credentialName", "secretName", "allowedExtensionIds"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "endpoint",
    "projectId",
    "environment",
    "secretPath",
    "connectionId",
    "machineIdentityAuthReference",
    "credentials",
  ],
  additionalProperties: false,
} as const satisfies ValueSchema;

const checkConfig = compileValueSchema(INFISICAL_CONNECTION_CONFIG_SCHEMA, 64 * 1024);

function normalizeEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
    || url.port
  ) throw new Error("unsafe endpoint");
  return url.origin;
}

function normalizeSecretPath(path: string): string {
  if (!path.startsWith("/") || path.includes("\\") || path.includes("//")) throw new Error("invalid path");
  const segments = path.split("/").slice(1);
  if (segments.some(segment => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9_.-]{1,64}$/.test(segment))) {
    if (path !== "/") throw new Error("invalid path");
  }
  return path;
}

function validAuthReference(reference: string): boolean {
  if (!/^host-secret:[a-zA-Z0-9][a-zA-Z0-9._/-]{0,126}$/.test(reference)) return false;
  return reference.slice("host-secret:".length).split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

export function parseInfisicalConnectionConfig(value: JsonValue | undefined): InfisicalConnectionConfig {
  try {
    checkConfig(value);
    const input = value as unknown as InfisicalConnectionConfig;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.projectId)
      || !/^[a-z][a-z0-9-]{0,63}$/.test(input.environment)
      || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.connectionId)
      || !validAuthReference(input.machineIdentityAuthReference)
    ) throw new Error("invalid identity");
    const credentialNames = new Set<string>();
    for (const mapping of input.credentials) {
      if (
        !/^[A-Z][A-Z0-9_]{0,127}$/.test(mapping.credentialName)
        || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(mapping.secretName)
        || mapping.allowedExtensionIds.some(extensionId => !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(extensionId))
        || credentialNames.has(mapping.credentialName)
        || new Set(mapping.allowedExtensionIds).size !== mapping.allowedExtensionIds.length
      ) {
        throw new Error("duplicate mapping");
      }
      credentialNames.add(mapping.credentialName);
    }
    return Object.freeze({
      endpoint: normalizeEndpoint(input.endpoint),
      projectId: input.projectId,
      environment: input.environment,
      secretPath: normalizeSecretPath(input.secretPath),
      connectionId: input.connectionId,
      machineIdentityAuthReference: input.machineIdentityAuthReference,
      credentials: Object.freeze(input.credentials.map(mapping => Object.freeze({
        credentialName: mapping.credentialName,
        secretName: mapping.secretName,
        allowedExtensionIds: Object.freeze([...mapping.allowedExtensionIds]),
      }))),
    });
  } catch {
    throw new ContractError("INVALID_PROVIDER_CONFIG", "Infisical connection configuration is invalid");
  }
}
