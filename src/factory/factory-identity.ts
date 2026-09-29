/**
 * The factory's identity check and its error, with no database behind them, so a host process can use them too
 * (the supervisor links no product database, C05). `records.ts` re-exports both.
 */
export class FactoryRecordError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FactoryRecordError";
  }
}

/** Refuses an empty, over-long or NUL-bearing identity. */
export function assertFactoryIdentity(...values: readonly string[]): void {
  if (values.some((value) => typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0"))) throw new FactoryRecordError("factory_identity_invalid");
}
