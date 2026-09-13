/** A credential marker anywhere in an environment name or value. */
export const SENSITIVE_ENVIRONMENT_PATTERN =
  /SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|AUTHORIZATION|SESSION[_-]?COOKIE|DATABASE[_-]?URL|CONNECTION[_-]?STRING/i;

/** Recognizable credential values whose variable names are innocuous. */
const SENSITIVE_ENVIRONMENT_VALUE_PATTERN =
  /sk-(?:(?:live|test|proj)[-_])?[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{32,}|\bAIza[0-9A-Za-z_-]{35,40}\b|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bBearer\s+[A-Za-z0-9._\-+/=]{16,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/i;

/**
 * Environment permissions are declarations of names, but installation occurs
 * in a host environment. Reject both an obviously credential-bearing name and
 * a benign-looking name whose current value carries a credential marker.
 */
export function isSensitiveEnvironmentEntry(name: string, value?: string): boolean {
  return SENSITIVE_ENVIRONMENT_PATTERN.test(name) ||
    (value !== undefined && (
      SENSITIVE_ENVIRONMENT_PATTERN.test(value) || SENSITIVE_ENVIRONMENT_VALUE_PATTERN.test(value)
    ));
}
