/**
 * Shared vector literal helper for safe SQL embedding interpolation.
 * Validates all values are finite numbers before constructing the PostgreSQL vector literal.
 */
export function toVectorLiteral(embedding: number[]): string {
  if (embedding.length === 0) {
    throw new Error("Invalid embedding: array must not be empty");
  }
  for (const v of embedding) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(
        "Invalid embedding value: all values must be finite numbers",
      );
    }
  }
  return `'[${embedding.join(",")}]'::vector`;
}
