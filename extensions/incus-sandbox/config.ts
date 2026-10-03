import { ContractError, compileValueSchema, type JsonValue, type ValueSchema } from "@ezcorp/extension-contract";

export interface IncusConnectionConfig {
  connectionId: string;
  serverCertificateSha256: string;
  project: string;
  profile: string;
  helperVersion: string;
  guestUser: string;
}

export const INCUS_CONNECTION_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    connectionId: { type: "string", minLength: 1, maxLength: 128 },
    serverCertificateSha256: {
      type: "string",
      minLength: 64,
      maxLength: 64,
      description: "Pinned SHA-256 fingerprint of the Incus server certificate.",
    },
    project: { type: "string", minLength: 1, maxLength: 63 },
    profile: { type: "string", minLength: 1, maxLength: 63 },
    helperVersion: {
      type: "string",
      minLength: 5,
      maxLength: 64,
    },
    guestUser: { type: "string", minLength: 1, maxLength: 32 },
  },
  required: [
    "connectionId",
    "serverCertificateSha256",
    "project",
    "profile",
    "helperVersion",
    "guestUser",
  ],
  additionalProperties: false,
} as const satisfies ValueSchema;

const checkConfig = compileValueSchema(INCUS_CONNECTION_CONFIG_SCHEMA);

export function parseIncusConnectionConfig(value: JsonValue | undefined): IncusConnectionConfig {
  try {
    checkConfig(value);
    const config = value as Record<string, JsonValue>;
    if (
      typeof config.serverCertificateSha256 !== "string"
      || typeof config.connectionId !== "string"
      || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(config.connectionId)
      || !/^[a-f0-9]{64}$/.test(config.serverCertificateSha256)
      || typeof config.project !== "string"
      || !/^[a-z][a-z0-9-]{0,62}$/.test(config.project)
      || config.project === "default"
      || typeof config.profile !== "string"
      || !/^[a-z][a-z0-9-]{0,62}$/.test(config.profile)
      || config.profile === "default"
      || typeof config.helperVersion !== "string"
      || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(config.helperVersion)
      || typeof config.guestUser !== "string"
      || !/^[a-z_][a-z0-9_-]{0,31}$/.test(config.guestUser)
    ) throw new Error("invalid config value");
  } catch {
    throw new ContractError("INVALID_PROVIDER_CONFIG", "Incus connection configuration is invalid");
  }
  const config = value as Record<string, JsonValue>;
  return {
    connectionId: config.connectionId as string,
    serverCertificateSha256: config.serverCertificateSha256 as string,
    project: config.project as string,
    profile: config.profile as string,
    helperVersion: config.helperVersion as string,
    guestUser: config.guestUser as string,
  };
}
