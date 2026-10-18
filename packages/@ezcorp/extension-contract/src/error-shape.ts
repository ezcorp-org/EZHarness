/**
 * An error's class and code for a refusal line: from the deepest cause that has them, never its message (a
 * database or decrypt message can quote a URL, a query or a value). No imports, so a caller can use it before
 * the database module loads.
 */
export function errorShape(error: unknown): { errorClass: string; errorCode?: string } {
  let deepest = error, errorCode: string | undefined;
  for (let at: unknown = error; at instanceof Error; at = at.cause) {
    deepest = at;
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string") errorCode = code;
  }
  const errorClass = deepest instanceof Error ? deepest.name : typeof deepest;
  return errorCode === undefined ? { errorClass } : { errorClass, errorCode };
}
