export type EmbeddingLogFailureKind = "invalid-json" | "json-error" | "json-fatal" | "native-cache" | "native-error";

export type EmbeddingLogFailure = {
  line: number;
  kind: EmbeddingLogFailureKind;
};

function composePayload(line: string): string {
  const trimmed = line.trim();
  const prefixed = trimmed.match(/^[A-Za-z0-9][A-Za-z0-9_.-]*\s+\|\s+(.*)$/);
  return prefixed?.[1] ?? trimmed;
}

function jsonFailure(payload: string, number: number): EmbeddingLogFailure | undefined {
  if (!payload.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(payload) as { level?: unknown };
    const level = value.level;
    const normalized = typeof level === "string" ? level.toLowerCase() : level;
    if (normalized === "error" || normalized === 50) return { line: number, kind: "json-error" };
    if (normalized === "fatal" || normalized === 60) return { line: number, kind: "json-fatal" };
  } catch {
    return { line: number, kind: "invalid-json" };
  }
  return undefined;
}

function nativeFailure(payload: string, number: number): EmbeddingLogFailure | undefined {
  if (payload.startsWith("Unable to add response to browser cache: Error:")) {
    return { line: number, kind: "native-cache" };
  }
  if (/^(?:Error|Fatal|EACCES):\s/.test(payload)) return { line: number, kind: "native-error" };
  return undefined;
}

/** Returns only safe failure metadata, never the application log payload. */
export function findEmbeddingLogFailures(composeLog: string): EmbeddingLogFailure[] {
  return composeLog.split(/\r?\n/).flatMap((line, index) => {
    const number = index + 1;
    const payload = composePayload(line);
    return [jsonFailure(payload, number) ?? nativeFailure(payload, number)].filter((failure): failure is EmbeddingLogFailure => failure !== undefined);
  });
}

export function assertEmbeddingLogHealthy(composeLog: string): void {
  if (composeLog.trim() === "") throw new Error("embedding compose log is empty");
  const failures = findEmbeddingLogFailures(composeLog);
  if (failures.length === 0) return;
  const summary = failures.map(({ kind, line }) => `${kind}@${line}`).join(", ");
  throw new Error(`embedding compose log has ${failures.length} failure record(s): ${summary}`);
}
