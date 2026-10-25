import type { ProviderCredentialInput } from "@ezcorp/sdk/v4";
import type { InfisicalConnectionConfig, InfisicalCredentialMapping } from "./config";
import {
  InfisicalProviderError,
  type InfisicalHttpRequest,
  type InfisicalHttpResponse,
  type InfisicalHttpTransport,
} from "./transport";

const LOGIN_PATH = "/api/v1/auth/universal-auth/login" as const;
const RESPONSE_LIMIT = 64 * 1024;
const SECRET_LIMIT = 16 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_MS = 1_000;

interface AuthSession {
  accessToken: string;
  issuedAtMs: number;
  expiresAtMs: number;
  refreshAtMs: number;
  renewal: number;
}

export interface InfisicalLifetimeMetadata {
  providerAuth: {
    kind: "infisical-access-token";
    issuedAtMs: number;
    expiresAtMs: number;
    renewal: number;
  };
  brokerHandle: {
    authority: "host";
    validity: "host-managed";
  };
  staticCredential: {
    kind: "static";
    issuerExpiry: "not-provided";
    renewable: false;
    dynamicLease: false;
  };
}

export interface InfisicalProviderOptions {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onLifetimeMetadata?: (metadata: Readonly<InfisicalLifetimeMetadata>) => void;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseJsonObject(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value as Record<string, unknown>;
  } catch {
    throw new InfisicalProviderError("invalid_response", false);
  }
}

function header(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
  const match = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return match?.[1];
}

function retryAfterMs(response: Readonly<InfisicalHttpResponse>): number | undefined {
  const value = header(response.headers, "retry-after");
  if (value === undefined || !/^\d{1,6}$/.test(value)) return undefined;
  return Math.min(Number(value) * 1_000, MAX_RETRY_DELAY_MS);
}

function requestBase(config: InfisicalConnectionConfig): Pick<InfisicalHttpRequest, "endpoint" | "redirect" | "timeoutMs" | "maxResponseBytes"> {
  return {
    endpoint: config.endpoint,
    redirect: "manual",
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxResponseBytes: RESPONSE_LIMIT,
  };
}

export class InfisicalStaticSecretProvider {
  private auth: AuthSession | undefined;
  private renewal = 0;
  private readonly mappings = new Map<string, InfisicalCredentialMapping>();
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly onLifetimeMetadata: (metadata: Readonly<InfisicalLifetimeMetadata>) => void;

  constructor(
    readonly config: InfisicalConnectionConfig,
    options: InfisicalProviderOptions = {},
  ) {
    for (const mapping of config.credentials) this.mappings.set(mapping.credentialName, mapping);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.onLifetimeMetadata = options.onLifetimeMetadata ?? (() => {});
  }

  async resolve(
    input: Readonly<ProviderCredentialInput>,
    transport: InfisicalHttpTransport,
  ): Promise<string | null> {
    const mapping = this.authorize(input);
    let renewedAfterUnauthorized = false;
    for (;;) {
      const session = await this.session(transport);
      const response = await this.request(transport, {
        ...requestBase(this.config),
        method: "GET",
        path: `/api/v4/secrets/${encodeURIComponent(mapping.secretName)}`,
        query: {
          projectId: this.config.projectId,
          environment: this.config.environment,
          secretPath: this.config.secretPath,
          type: "shared",
          viewSecretValue: "true",
          expandSecretReferences: "false",
          includeImports: "false",
        },
        headers: {
          accept: "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
      }, true);
      if (response.status === 401 && !renewedAfterUnauthorized) {
        this.auth = undefined;
        renewedAfterUnauthorized = true;
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new InfisicalProviderError("scope_denied", false);
      }
      if (response.status === 404) return null;
      this.requireSuccess(response);
      return this.parseSecret(response.body, mapping);
    }
  }

  private authorize(input: Readonly<ProviderCredentialInput>): InfisicalCredentialMapping {
    if (input.providerId !== "infisical" || input.connectionId !== this.config.connectionId) {
      throw new InfisicalProviderError("invalid_request", false);
    }
    const mapping = this.mappings.get(input.name);
    if (!mapping?.allowedExtensionIds.includes(input.scope.extensionId)) {
      throw new InfisicalProviderError("scope_denied", false);
    }
    return mapping;
  }

  private async session(transport: InfisicalHttpTransport): Promise<AuthSession> {
    if (this.auth && this.now() < this.auth.refreshAtMs) return this.auth;
    const response = await this.request(transport, {
      ...requestBase(this.config),
      method: "POST",
      path: LOGIN_PATH,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { machineIdentityAuthReference: this.config.machineIdentityAuthReference },
    }, false);
    if (response.status === 401 || response.status === 403) {
      throw new InfisicalProviderError("authentication_failed", false);
    }
    this.requireSuccess(response);
    const body = parseJsonObject(response.body);
    if (
      typeof body.accessToken !== "string"
      || !body.accessToken
      || body.accessToken.length > SECRET_LIMIT
      || !/^[A-Za-z0-9._~+\x2f-]+=*$/.test(body.accessToken)
      || body.tokenType !== "Bearer"
      || !Number.isSafeInteger(body.expiresIn)
      || (body.expiresIn as number) < 1
      || (body.expiresIn as number) > 315_360_000
      || !Number.isSafeInteger(body.accessTokenMaxTTL)
      || (body.accessTokenMaxTTL as number) < (body.expiresIn as number)
    ) throw new InfisicalProviderError("invalid_response", false);
    const issuedAtMs = this.now();
    const lifetimeMs = (body.expiresIn as number) * 1_000;
    const auth: AuthSession = {
      accessToken: body.accessToken,
      issuedAtMs,
      expiresAtMs: issuedAtMs + lifetimeMs,
      refreshAtMs: issuedAtMs + lifetimeMs - Math.min(30_000, Math.floor(lifetimeMs / 10)),
      renewal: ++this.renewal,
    };
    this.auth = auth;
    this.onLifetimeMetadata(Object.freeze({
      providerAuth: Object.freeze({
        kind: "infisical-access-token",
        issuedAtMs: auth.issuedAtMs,
        expiresAtMs: auth.expiresAtMs,
        renewal: auth.renewal,
      }),
      brokerHandle: Object.freeze({ authority: "host", validity: "host-managed" }),
      staticCredential: Object.freeze({
        kind: "static",
        issuerExpiry: "not-provided",
        renewable: false,
        dynamicLease: false,
      }),
    }));
    return auth;
  }

  private async request(
    transport: InfisicalHttpTransport,
    request: Readonly<InfisicalHttpRequest>,
    retrySafe: boolean,
  ): Promise<Readonly<InfisicalHttpResponse>> {
    let lastRetryAfter: number | undefined;
    for (let attempt = 0; attempt < (retrySafe ? 2 : 1); attempt++) {
      let response: Readonly<InfisicalHttpResponse>;
      try {
        response = await transport.request(request);
      } catch (error) {
        if (error instanceof InfisicalProviderError) {
          if (retrySafe && error.retryable && attempt === 0) continue;
          throw error;
        }
        if (retrySafe && attempt === 0) continue;
        throw new InfisicalProviderError("unavailable", true);
      }
      if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599 || typeof response.body !== "string") {
        throw new InfisicalProviderError("invalid_response", false);
      }
      if (byteLength(response.body) > request.maxResponseBytes) {
        throw new InfisicalProviderError("response_too_large", false);
      }
      if (response.status >= 300 && response.status < 400) {
        throw new InfisicalProviderError("redirect_denied", false);
      }
      if (response.status === 429) {
        lastRetryAfter = retryAfterMs(response);
        if (retrySafe && attempt === 0) {
          await this.sleep(lastRetryAfter ?? 0);
          continue;
        }
        throw new InfisicalProviderError("rate_limited", true, lastRetryAfter);
      }
      if (response.status >= 500) {
        if (retrySafe && attempt === 0) continue;
        throw new InfisicalProviderError("unavailable", true);
      }
      return response;
    }
    throw new InfisicalProviderError("unavailable", true, lastRetryAfter);
  }

  private requireSuccess(response: Readonly<InfisicalHttpResponse>): void {
    if (response.status < 200 || response.status >= 300) {
      throw new InfisicalProviderError("invalid_response", false);
    }
  }

  private parseSecret(bodyText: string, mapping: InfisicalCredentialMapping): string {
    const body = parseJsonObject(bodyText);
    if (!body.secret || typeof body.secret !== "object" || Array.isArray(body.secret)) {
      throw new InfisicalProviderError("invalid_response", false);
    }
    const secret = body.secret as Record<string, unknown>;
    if (
      secret.workspace !== this.config.projectId
      || secret.environment !== this.config.environment
      || secret.secretPath !== this.config.secretPath
      || secret.secretKey !== mapping.secretName
      || secret.type !== "shared"
      || typeof secret.secretValue !== "string"
      || !secret.secretValue
      || byteLength(secret.secretValue) > SECRET_LIMIT
      || /[\r\n]/.test(secret.secretValue)
    ) throw new InfisicalProviderError("invalid_response", false);
    return secret.secretValue;
  }
}
