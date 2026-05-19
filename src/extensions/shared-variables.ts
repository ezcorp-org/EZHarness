import { basename } from "node:path";

/**
 * Shared variable resolvers.
 * Each key maps to a function that returns the current value.
 */
export const SHARED_VARIABLE_RESOLVERS: Record<string, () => string> = {
  "project.cwd": () => process.cwd(),
  "project.name": () => basename(process.cwd()),
};

/**
 * Resolve shared variables for tool arguments.
 * For each schema property with an `x-shared` annotation, if the corresponding
 * arg is missing/empty, fill it with the resolved value.
 *
 * Returns a new args object (does not mutate original).
 */
export function resolveSharedVariables(
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const properties = inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return args;

  const result = { ...args };

  for (const [key, prop] of Object.entries(properties)) {
    const sharedKey = prop["x-shared"] as string | undefined;
    if (!sharedKey) continue;

    // Only fill if arg is missing or empty
    if (result[key] !== undefined && result[key] !== "" && result[key] !== null) continue;

    const resolver = SHARED_VARIABLE_RESOLVERS[sharedKey];
    if (resolver) {
      result[key] = resolver();
    }
  }

  return result;
}

/**
 * Get default values for all x-shared fields in a schema.
 * Used client-side to pre-fill form fields.
 */
export function getSharedDefaults(
  inputSchema: Record<string, unknown>,
): Record<string, string> {
  const properties = inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return {};

  const defaults: Record<string, string> = {};

  for (const [key, prop] of Object.entries(properties)) {
    const sharedKey = prop["x-shared"] as string | undefined;
    if (!sharedKey) continue;

    const resolver = SHARED_VARIABLE_RESOLVERS[sharedKey];
    if (resolver) {
      defaults[key] = resolver();
    }
  }

  return defaults;
}
