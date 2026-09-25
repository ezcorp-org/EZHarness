export interface InfisicalHttpRequest {
  method: "GET" | "POST";
  endpoint: string;
  path: "/api/v1/auth/universal-auth/login" | `/api/v4/secrets/${string}`;
  query?: Readonly<Record<string, string>>;
  headers: Readonly<Record<string, string>>;
  body?: Readonly<{ machineIdentityAuthReference: string }>;
  redirect: "manual";
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface InfisicalHttpResponse {
  status: number;
  headers?: Readonly<Record<string, string>>;
  body: string;
}

export interface InfisicalHttpTransport {
  request(request: Readonly<InfisicalHttpRequest>): Promise<Readonly<InfisicalHttpResponse>>;
}

export type InfisicalProviderErrorCode =
  | "invalid_request"
  | "scope_denied"
  | "authentication_failed"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "redirect_denied"
  | "response_too_large"
  | "invalid_response";

const errorMessages: Record<InfisicalProviderErrorCode, string> = {
  invalid_request: "Infisical credential request is invalid.",
  scope_denied: "Infisical credential scope is not approved.",
  authentication_failed: "Infisical machine authentication failed.",
  not_found: "Infisical credential is unavailable.",
  rate_limited: "Infisical rate limit was reached.",
  unavailable: "Infisical is unavailable.",
  redirect_denied: "Infisical redirect was denied.",
  response_too_large: "Infisical response exceeded its limit.",
  invalid_response: "Infisical returned an invalid response.",
};

export class InfisicalProviderError extends Error {
  constructor(
    readonly code: InfisicalProviderErrorCode,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(errorMessages[code]);
    this.name = "InfisicalProviderError";
  }
}
