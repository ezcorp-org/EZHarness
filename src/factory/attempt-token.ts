import { signInstallationToken, verifyInstallationToken } from "../auth/jwt";
import type { FactoryAttemptAuthority } from "./executions";

/** Control credentials are refreshed independently of the attempt's effect deadline. */
export const FACTORY_ATTEMPT_TOKEN_MAX_SECONDS = 60 * 60;
const identityFields = ["attemptId", "tenantId", "projectId", "runId", "nodeInstanceId"] as const;
const counterFields = ["candidateGeneration", "attemptNumber", "grantRevision", "reservationGeneration", "executionEpoch", "cancellationEpoch"] as const;
const claimFields = new Set<string>([...identityFields, ...counterFields, "requestDigest", "deadlineAt", "tokenUse", "iat", "exp", "iss", "aud"]);

function authority(value: Record<string, unknown>): FactoryAttemptAuthority | null {
  if (identityFields.some(key => typeof value[key] !== "string" || !value[key] || value[key].length > 512 || value[key].includes("\0"))
    || counterFields.some(key => !Number.isSafeInteger(value[key]) || (value[key] as number) < 0)
    || typeof value.requestDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.requestDigest)
    || !Number.isSafeInteger(value.deadlineAt) || (value.deadlineAt as number) < 0 || !Number.isFinite(new Date(value.deadlineAt as number).getTime())) return null;
  return {
    attemptId: value.attemptId as string, tenantId: value.tenantId as string, projectId: value.projectId as string,
    runId: value.runId as string, nodeInstanceId: value.nodeInstanceId as string, requestDigest: value.requestDigest,
    candidateGeneration: value.candidateGeneration as number, attemptNumber: value.attemptNumber as number,
    grantRevision: value.grantRevision as number, reservationGeneration: value.reservationGeneration as number,
    executionEpoch: value.executionEpoch as number, cancellationEpoch: value.cancellationEpoch as number,
    deadlineAt: new Date(value.deadlineAt as number),
  };
}

/** Mint only from product-derived authority, never from a transport request body. */
export async function signFactoryAttemptToken(value: FactoryAttemptAuthority, secret: string, installationId: string, expiresInSeconds = 60): Promise<string> {
  const captured = authority({ ...value, deadlineAt: value.deadlineAt.getTime() });
  if (!captured || !installationId.trim() || !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > FACTORY_ATTEMPT_TOKEN_MAX_SECONDS) throw new Error("Invalid factory attempt token identity or lifetime.");
  const iat = Math.floor(Date.now() / 1_000);
  return signInstallationToken({ ...captured, deadlineAt: captured.deadlineAt.getTime(), tokenUse: "factory-attempt", iat, exp: iat + expiresInSeconds }, secret, installationId);
}

/** A signed user, preview, or public-service credential cannot become attempt authority. */
export async function verifyFactoryAttemptToken(token: string, secret: string, installationId: string): Promise<FactoryAttemptAuthority | null> {
  if (!installationId.trim()) return null;
  const payload = await verifyInstallationToken(token, secret, installationId);
  const now = Math.floor(Date.now() / 1_000);
  if (payload?.tokenUse !== "factory-attempt" || Object.keys(payload).length !== claimFields.size
    || Object.keys(payload).some(key => !claimFields.has(key)) || payload.iat < 0 || payload.iat > now
    || payload.exp - payload.iat > FACTORY_ATTEMPT_TOKEN_MAX_SECONDS) return null;
  return authority(payload);
}
