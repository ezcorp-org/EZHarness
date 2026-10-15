import { compileFactory } from "./compiler.js";
import type { FactoryDefinition } from "./types.js";

export class FactoryAuthoringError extends Error {
  readonly diagnostics;

  constructor(diagnostics: readonly { readonly code: string; readonly message: string; readonly path: readonly (string | number)[] }[]) {
    super(diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("\n"));
    this.name = "FactoryAuthoringError";
    this.diagnostics = diagnostics;
  }
}

export function defineFactory(definition: FactoryDefinition): FactoryDefinition {
  const result = compileFactory(definition);
  if (!result.ok) throw new FactoryAuthoringError(result.diagnostics);
  return result.factory.definition;
}
