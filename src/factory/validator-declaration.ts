/**
 * The declared validator runtimes, read from the files the startup document names.
 *
 * A trusted validator runtime is the judge of a protected claim, so it is the
 * one runtime a factory definition must never be able to supply. The startup
 * document names each one BY REFERENCE — a material file, that file's digest,
 * the runtime kind, and the runner lock it registers under — and this file
 * turns the reference into the `FactoryTrustedValidatorRuntime` W05's gateway
 * takes. It follows W09b's release declaration: a path is a reference until the
 * moment it is read, it is read through the private bounded reader, and a
 * failure names the runtime and what is wrong with the FILE, never its bytes.
 *
 * Three refusals, each by name:
 *
 * - `factory_validator_declaration_unreadable`: the file is missing, not a
 *   regular file, not owned by this process, readable by anyone else, or too
 *   large.
 * - `factory_validator_declaration_digest_mismatch`: the bytes are not the
 *   bytes the operator declared. A swapped or edited material is refused
 *   before a single field of it is believed.
 * - `factory_validator_declaration_invalid`: the bytes are the declared ones
 *   and do not describe a runtime, or describe a different runner or kind than
 *   the document says. The deeper runtime rules — digest shapes, the evidence
 *   age bound, the configuration binding — stay W05's and are applied by
 *   `FactoryTrustedValidators` itself.
 */
import type { FactoryModelPin, ResourceBounds, RunnerReference } from "@ezcorp/factory-sdk";
import { canonicalJson } from "@ezcorp/extension-contract";
import { digestBytes } from "../extensions/v4/blobs";
import { readPrivatePath } from "./private-files";
import type { FactoryStartupConfig, FactoryStartupValidatorRuntime } from "./startup-config";
import type { FactoryTrustedValidatorRuntime } from "./validator-materials";

/** A runtime description is a few hundred bytes; this bound only refuses a wrong file. */
export const MAX_VALIDATOR_MATERIAL_BYTES = 64 * 1024;
export const FACTORY_VALIDATOR_RUNTIME_SCHEMA = "factory.validator-runtime.v1";

export type FactoryValidatorDeclarationCode =
  | "factory_validator_declaration_unreadable"
  | "factory_validator_declaration_digest_mismatch"
  | "factory_validator_declaration_invalid";

export class FactoryValidatorDeclarationError extends Error {
  constructor(readonly code: FactoryValidatorDeclarationCode, readonly runtime: string, message: string) {
    super(`${code}: ${runtime}: ${message}`);
    this.name = "FactoryValidatorDeclarationError";
  }
}

/** One declared runtime, with the name the document gave it for reports. */
export interface FactoryDeclaredValidatorRuntime {
  readonly name: string;
  readonly runtime: FactoryTrustedValidatorRuntime;
}

/** The material file's own shape: the runtime, the kind, and the runner it repeats. */
interface ValidatorMaterialFile {
  readonly schemaVersion: typeof FACTORY_VALIDATOR_RUNTIME_SCHEMA;
  readonly kind: string;
  readonly runner: RunnerReference;
  readonly resources: ResourceBounds;
  readonly model?: FactoryModelPin;
  readonly brokerAudience: string;
  readonly environmentDigest: string;
  readonly configurationDigest: string;
  readonly maxEvidenceAgeMs: number;
}

const MATERIAL_KEYS = ["schemaVersion", "kind", "runner", "resources", "brokerAudience", "environmentDigest", "configurationDigest", "maxEvidenceAgeMs"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function materialShape(value: unknown): value is ValidatorMaterialFile {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  const expected = Object.hasOwn(value, "model") ? [...MATERIAL_KEYS, "model"] : MATERIAL_KEYS;
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
    && value.schemaVersion === FACTORY_VALIDATOR_RUNTIME_SCHEMA
    && record(value.runner) && record(value.resources) && (value.model === undefined || record(value.model));
}

/** Read one declared runtime's file, prove it is the declared bytes, and describe it. */
async function loadRuntime(declared: FactoryStartupValidatorRuntime): Promise<FactoryDeclaredValidatorRuntime> {
  let bytes: Uint8Array;
  try {
    bytes = await readPrivatePath(declared.materialPath, MAX_VALIDATOR_MATERIAL_BYTES);
  } catch (error) {
    throw new FactoryValidatorDeclarationError("factory_validator_declaration_unreadable", declared.name,
      `its material file is not readable and private (${(error as Error).message})`);
  }
  if (`sha256:${digestBytes(bytes)}` !== declared.materialDigest) {
    throw new FactoryValidatorDeclarationError("factory_validator_declaration_digest_mismatch", declared.name,
      "its material file does not have the declared digest");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new FactoryValidatorDeclarationError("factory_validator_declaration_invalid", declared.name, "its material file is not UTF-8 JSON");
  }
  if (!materialShape(parsed)) {
    throw new FactoryValidatorDeclarationError("factory_validator_declaration_invalid", declared.name,
      `its material file is not a ${FACTORY_VALIDATOR_RUNTIME_SCHEMA} runtime`);
  }
  if (parsed.kind !== declared.kind || canonicalJson(parsed.runner) !== canonicalJson(declared.runner)) {
    throw new FactoryValidatorDeclarationError("factory_validator_declaration_invalid", declared.name,
      "its material file describes a different runner or kind than the startup document declares");
  }
  const { schemaVersion: _schemaVersion, kind: _kind, ...runtime } = parsed;
  return Object.freeze({ name: declared.name, runtime: Object.freeze(runtime) });
}

/**
 * Every declared runtime, or `undefined` when the document declares none.
 *
 * Undefined is not an error: an installation without validators still serves
 * runs, and the composition holds the validator roles with the reason. A
 * declaration that cannot be read IS an error, and it names the runtime.
 */
export async function loadFactoryValidatorRuntimes(
  config: Pick<FactoryStartupConfig, "validators">,
): Promise<readonly FactoryDeclaredValidatorRuntime[] | undefined> {
  const declaration = config.validators;
  if (declaration === undefined) return undefined;
  const loaded: FactoryDeclaredValidatorRuntime[] = [];
  for (const runtime of declaration.runtimes) loaded.push(await loadRuntime(runtime));
  return Object.freeze(loaded);
}
