/**
 * The reference image pack's content lock.
 *
 * One committed document pins everything a variant's bytes can depend on: the
 * model repository revision and every weight digest, the container image the
 * guest runs in, the interpreter, the generation settings C10 fixes, the PNG
 * normalization, the OCR configuration and its threshold, and the semantic
 * evaluation configuration. Nothing in the pack resolves any of these at
 * execution time, so two runs that disagree disagree about the hardware rather
 * than about what was asked.
 *
 * `referenceImageLockDigest` is the value a recipe and an evidence record carry.
 * It covers the whole document, so changing a seed, a threshold, or a weight
 * digest produces a different lock and therefore a different decision.
 */
import { createHash } from "node:crypto";

import lockDocument from "./sdxl-lock.json" with { type: "json" };

export const REFERENCE_IMAGE_LOCK_SCHEMA_VERSION = "factory.reference-image-lock.v1";

/**
 * One file of the model closure, bound before it is fetched.
 *
 * Two kinds of file arrive from the model host and they are bound differently.
 * A weight file is stored by content address, so `digest` is the authoritative
 * SHA-256 of its bytes and `blobId` identifies only the small pointer object
 * that stands in for it in the repository tree. A configuration or vocabulary
 * file is stored inline, so it has no `digest` upstream and `blobId` is the
 * SHA-1 over `blob <size>\0` and the content itself, which does bind the bytes.
 *
 * Applying the pointer's identifier to the weight bytes is the mistake this
 * comment exists to prevent; it was made once and caught by the fetcher.
 */
export interface ReferenceImageModelFile {
  readonly path: string;
  readonly bytes: number;
  /** The upstream Git object identifier: the content for a small file, the pointer for a weight. */
  readonly blobId: string;
  /** The model host's SHA-256 over the bytes. Present for content-addressed weight files only. */
  readonly digest?: string;
}

export interface ReferenceImageModelLock {
  readonly source: string;
  readonly repository: string;
  readonly revision: string;
  readonly variant: string;
  readonly pipeline: string;
  readonly files: readonly ReferenceImageModelFile[];
}

export interface ReferenceImageRuntimeLock {
  readonly baseImage: string;
  readonly pythonVersion: string;
  readonly resourceClass: string;
  readonly modelDirectory: string;
}

/** Exactly the C10 settings. Every field is a fixed input, not a default. */
export interface ReferenceImageGenerationLock {
  readonly seeds: readonly number[];
  readonly inferenceSteps: number;
  readonly guidanceScale: number;
  readonly width: number;
  readonly height: number;
  readonly dtype: string;
  readonly scheduler: string;
  readonly device: string;
  readonly selector: string;
}

export interface ReferenceImageNormalizationLock {
  readonly format: string;
  readonly colorMode: string;
  readonly bitDepth: number;
  readonly compressLevel: number;
  readonly stripAncillaryChunks: boolean;
  /** The only chunk types a normalized variant may contain. */
  readonly allowedChunks: readonly string[];
  readonly maximumBytes: number;
}

export interface ReferenceImageOcrLock {
  readonly engine: string;
  readonly language: string;
  readonly pageSegmentationMode: number;
  readonly engineMode: number;
  /** A word at or above this confidence counts as recognized text. */
  readonly minimumWordConfidence: number;
}

export interface ReferenceImageEvaluationLock {
  readonly model: string;
  readonly fields: readonly string[];
  readonly evaluations: number;
  readonly minimumPasses: number;
  readonly requireAllDecisive: boolean;
  readonly maxOutputTokens: number;
  readonly temperature: number;
}

export interface ReferenceImageLock {
  readonly schemaVersion: typeof REFERENCE_IMAGE_LOCK_SCHEMA_VERSION;
  readonly definitionId: string;
  readonly model: ReferenceImageModelLock;
  readonly runtime: ReferenceImageRuntimeLock;
  readonly generation: ReferenceImageGenerationLock;
  readonly normalization: ReferenceImageNormalizationLock;
  readonly ocr: ReferenceImageOcrLock;
  readonly evaluation: ReferenceImageEvaluationLock;
}

export class ReferenceImageLockError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReferenceImageLockError";
  }
}

function invalid(message: string): never {
  throw new ReferenceImageLockError("reference_image_lock_invalid", message);
}

/** Stable key order, so the digest measures content rather than authoring order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const BLOB = /^[a-f0-9]{40}$/;
const IMAGE = /^[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}$/;

/**
 * Accepts only a lock that pins every field this pack reads.
 *
 * The checks are deliberately about bindings rather than shape: a revision that
 * is not a commit, an unpinned image, an out-of-order or duplicated file list,
 * a quorum larger than the number of evaluations, or a normalization that
 * permits a chunk outside the allowed set would each let an execution-time
 * decision back in.
 */
export function assertReferenceImageLock(value: unknown): asserts value is ReferenceImageLock {
  if (typeof value !== "object" || value === null) invalid("The reference image lock must be an object");
  const lock = value as Record<string, unknown>;
  if (lock.schemaVersion !== REFERENCE_IMAGE_LOCK_SCHEMA_VERSION) invalid(`The reference image lock schema must be ${REFERENCE_IMAGE_LOCK_SCHEMA_VERSION}`);
  if (lock.definitionId !== "reference.image.v1") invalid("The reference image lock must name reference.image.v1");

  const model = lock.model as Record<string, unknown> | undefined;
  if (typeof model?.source !== "string" || !model.source.startsWith("https://")) invalid("The model source must be an HTTPS origin");
  if (typeof model.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(model.repository)) invalid("The model repository must be an owner and name");
  if (typeof model.revision !== "string" || !BLOB.test(model.revision)) invalid("The model revision must be a full commit identifier");
  if (typeof model.variant !== "string" || model.variant.length === 0) invalid("The model variant must be named");
  if (typeof model.pipeline !== "string" || model.pipeline.length === 0) invalid("The model pipeline must be named");
  if (!Array.isArray(model.files) || model.files.length === 0) invalid("The model lock must list its files");
  let previous = "";
  let weights = 0;
  for (const entry of model.files as readonly unknown[]) {
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string" || file.path.length === 0) invalid("Every model file must name a path");
    if (file.path.startsWith("/") || file.path.includes("..")) invalid(`Model file path ${file.path} must stay inside the closure`);
    if (file.path <= previous) invalid(`Model files must be sorted and unique; ${file.path} follows ${previous}`);
    previous = file.path;
    if (typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) invalid(`Model file ${file.path} must declare its byte count`);
    if (typeof file.blobId !== "string" || !BLOB.test(file.blobId)) invalid(`Model file ${file.path} must declare its blob identifier`);
    if (file.digest !== undefined) {
      if (typeof file.digest !== "string" || !DIGEST.test(file.digest)) invalid(`Model file ${file.path} declares a malformed digest`);
      weights += 1;
    }
  }
  if (weights === 0) invalid("The model lock must pin at least one weight file by digest");

  const runtime = lock.runtime as Record<string, unknown> | undefined;
  if (typeof runtime?.baseImage !== "string" || !IMAGE.test(runtime.baseImage)) invalid("The runtime base image must be pinned by registry digest");
  if (typeof runtime.pythonVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(runtime.pythonVersion)) invalid("The runtime must pin an exact interpreter version");
  if (typeof runtime.resourceClass !== "string" || runtime.resourceClass.length === 0) invalid("The runtime must name its resource class");
  if (typeof runtime.modelDirectory !== "string" || !runtime.modelDirectory.startsWith("/")) invalid("The runtime must name an absolute model directory");

  const generation = lock.generation as Record<string, unknown> | undefined;
  if (!Array.isArray(generation?.seeds) || generation.seeds.length === 0) invalid("The generation lock must record its seeds");
  let seed = -1;
  for (const entry of generation.seeds as readonly unknown[]) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) invalid("Every seed must be a nonnegative integer");
    if (entry <= seed) invalid("Seeds must be recorded in ascending input order without duplicates");
    seed = entry;
  }
  for (const field of ["inferenceSteps", "width", "height"] as const) {
    const item = generation[field];
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) invalid(`The generation lock must pin ${field}`);
  }
  if (typeof generation.guidanceScale !== "number" || !Number.isFinite(generation.guidanceScale) || generation.guidanceScale <= 0) invalid("The generation lock must pin its guidance scale");
  for (const field of ["dtype", "scheduler", "device", "selector"] as const) {
    if (typeof generation[field] !== "string" || (generation[field] as string).length === 0) invalid(`The generation lock must pin ${field}`);
  }

  const normalization = lock.normalization as Record<string, unknown> | undefined;
  if (normalization?.format !== "PNG") invalid("The normalization lock must produce PNG");
  if (typeof normalization.colorMode !== "string" || !["RGB", "RGBA"].includes(normalization.colorMode)) invalid("The normalization lock must pin an RGB or RGBA colour mode");
  if (normalization.bitDepth !== 8) invalid("The normalization lock must pin eight-bit samples");
  if (typeof normalization.compressLevel !== "number" || !Number.isSafeInteger(normalization.compressLevel) || normalization.compressLevel < 0 || normalization.compressLevel > 9) invalid("The normalization lock must pin a compression level");
  if (normalization.stripAncillaryChunks !== true) invalid("The normalization lock must strip ancillary chunks");
  if (!Array.isArray(normalization.allowedChunks) || normalization.allowedChunks.length === 0) invalid("The normalization lock must list the chunks it allows");
  for (const chunk of normalization.allowedChunks as readonly unknown[]) {
    if (typeof chunk !== "string" || !/^[A-Za-z]{4}$/.test(chunk)) invalid("Every allowed chunk must be a four-letter type");
  }
  for (const required of ["IHDR", "IDAT", "IEND"]) {
    if (!(normalization.allowedChunks as readonly string[]).includes(required)) invalid(`The normalization lock must allow the critical chunk ${required}`);
  }
  if (typeof normalization.maximumBytes !== "number" || !Number.isSafeInteger(normalization.maximumBytes) || normalization.maximumBytes <= 0) invalid("The normalization lock must pin a maximum size");

  const ocr = lock.ocr as Record<string, unknown> | undefined;
  if (typeof ocr?.engine !== "string" || ocr.engine.length === 0) invalid("The OCR lock must name its engine");
  if (typeof ocr.language !== "string" || !/^[a-z]{3}$/.test(ocr.language)) invalid("The OCR lock must name a three-letter language");
  for (const field of ["pageSegmentationMode", "engineMode"] as const) {
    const item = ocr[field];
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) invalid(`The OCR lock must pin ${field}`);
  }
  if (typeof ocr.minimumWordConfidence !== "number" || !Number.isSafeInteger(ocr.minimumWordConfidence) || ocr.minimumWordConfidence < 0 || ocr.minimumWordConfidence > 100) invalid("The OCR lock must pin a word confidence threshold between zero and one hundred");

  const evaluation = lock.evaluation as Record<string, unknown> | undefined;
  if (typeof evaluation?.model !== "string" || evaluation.model.length === 0) invalid("The evaluation lock must name its model");
  if (!Array.isArray(evaluation.fields) || evaluation.fields.length === 0) invalid("The evaluation lock must list its boolean fields");
  let field = "";
  for (const entry of evaluation.fields as readonly unknown[]) {
    if (typeof entry !== "string" || entry.length === 0) invalid("Every evaluation field must be named");
    if (entry === field) invalid("Evaluation fields must be unique");
    field = entry;
  }
  if (new Set(evaluation.fields as readonly string[]).size !== (evaluation.fields as readonly string[]).length) invalid("Evaluation fields must be unique");
  if (typeof evaluation.evaluations !== "number" || !Number.isSafeInteger(evaluation.evaluations) || evaluation.evaluations < 1) invalid("The evaluation lock must count its evaluations");
  if (typeof evaluation.minimumPasses !== "number" || !Number.isSafeInteger(evaluation.minimumPasses) || evaluation.minimumPasses < 1) invalid("The evaluation lock must pin a quorum");
  if (evaluation.minimumPasses > evaluation.evaluations) invalid("The evaluation quorum cannot exceed the number of evaluations");
  if (evaluation.requireAllDecisive !== true) invalid("The evaluation lock must require every evaluation to be decisive");
  if (typeof evaluation.maxOutputTokens !== "number" || !Number.isSafeInteger(evaluation.maxOutputTokens) || evaluation.maxOutputTokens <= 0) invalid("The evaluation lock must pin an output ceiling");
  if (typeof evaluation.temperature !== "number" || !Number.isFinite(evaluation.temperature) || evaluation.temperature < 0) invalid("The evaluation lock must pin a temperature");
}

function frozen(value: ReferenceImageLock): ReferenceImageLock {
  return Object.freeze({
    ...value,
    model: Object.freeze({ ...value.model, files: Object.freeze(value.model.files.map(file => Object.freeze({ ...file }))) }),
    runtime: Object.freeze({ ...value.runtime }),
    generation: Object.freeze({ ...value.generation, seeds: Object.freeze([...value.generation.seeds]) }),
    normalization: Object.freeze({ ...value.normalization, allowedChunks: Object.freeze([...value.normalization.allowedChunks]) }),
    ocr: Object.freeze({ ...value.ocr }),
    evaluation: Object.freeze({ ...value.evaluation, fields: Object.freeze([...value.evaluation.fields]) }),
  });
}

/** Parses a candidate lock document. Used for a caller-supplied or fixture lock. */
export function parseReferenceImageLock(value: unknown): ReferenceImageLock {
  assertReferenceImageLock(value);
  return frozen(value);
}

/** The one lock this installation runs. */
export const referenceImageLock: ReferenceImageLock = parseReferenceImageLock(lockDocument);

/** `sha256:` over the whole canonical lock. A recipe and an evidence record carry this. */
export function referenceImageLockDigest(lock: ReferenceImageLock = referenceImageLock): string {
  return `sha256:${createHash("sha256").update(canonical(lock)).digest("hex")}`;
}

/** The resolve URL for one closure file at the pinned revision. */
export function sdxlWeightUrl(path: string, lock: ReferenceImageLock = referenceImageLock): string {
  const file = lock.model.files.find(entry => entry.path === path);
  if (file === undefined) throw new ReferenceImageLockError("reference_image_lock_unknown_file", `The lock does not declare ${path}`);
  return `${lock.model.source}/${lock.model.repository}/resolve/${lock.model.revision}/${file.path}`;
}

/**
 * Where the sealed weight closure lives on this host.
 *
 * The revision is part of the path, so a lock that moves to another revision
 * cannot read the previous one's bytes out of a warm directory.
 */
export function sdxlClosureDirectory(lock: ReferenceImageLock = referenceImageLock): string {
  const base = process.env.EZCORP_FACTORY_SDXL_CLOSURE_DIR ?? "/tmp/ezcorp-factory-sdxl";
  return `${base}/${lock.model.revision}`;
}

/** The sorted `name@sha256:` model pins for a Python runner closure. */
export function referenceImageModelPins(lock: ReferenceImageLock = referenceImageLock): readonly string[] {
  return Object.freeze(
    lock.model.files
      .filter(file => file.digest !== undefined)
      .map(file => `${lock.model.repository}/${file.path}@${file.digest as string}`)
      .sort(),
  );
}
