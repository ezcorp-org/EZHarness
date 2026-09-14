import { REFERENCE_DATA_LIMITS } from "./csv";
import { REFERENCE_DATA_PARQUET_SCHEMA } from "./parquet";

/**
 * The manifest C10 requires beside the exported Parquet: "row count,
 * per-category counts, and exact integer amount sums".
 *
 * Every sum is a DECIMAL STRING. The declared domain reaches 2**63 - 1 and a
 * JSON number is a double, so a manifest that wrote its totals as numbers
 * would silently round exactly the values C10 says must match exactly. The
 * assertion below refuses a number in a sum position rather than reading it.
 */

export const REFERENCE_DATA_MANIFEST_SCHEMA_VERSION = "factory.reference-data-manifest.v1";
export const REFERENCE_DATA_MANIFEST_MEDIA_TYPE = "application/json";
/** The reserved manifest member name inside the export directory. */
export const REFERENCE_DATA_MANIFEST_NAME = "manifest.json";

export type ReferenceDataManifestIssueCode =
  | "manifest_shape"
  | "manifest_schema_version"
  | "manifest_amount"
  | "manifest_category_order"
  | "manifest_file_order"
  | "manifest_schema"
  | "manifest_totals";

export class ReferenceDataManifestError extends Error {
  constructor(
    readonly code: ReferenceDataManifestIssueCode,
    message: string,
  ) {
    super(message);
    this.name = "ReferenceDataManifestError";
  }
}

function refuse(code: ReferenceDataManifestIssueCode, message: string): never {
  throw new ReferenceDataManifestError(code, message);
}

export interface ReferenceDataManifestCategory {
  readonly category: string;
  readonly count: number;
  /** Exact decimal integer. */
  readonly sumCents: string;
}

export interface ReferenceDataManifestFile {
  readonly name: string;
  readonly digest: string;
  readonly encodedBytes: number;
}

export interface ReferenceDataManifestField {
  readonly name: string;
  readonly physicalType: string;
  readonly logicalType: string;
  readonly repetition: string;
}

export interface ReferenceDataManifest {
  readonly schemaVersion: typeof REFERENCE_DATA_MANIFEST_SCHEMA_VERSION;
  /** The immutable input this export was produced from. */
  readonly source: { readonly digest: string; readonly totalBytes: number };
  readonly rowCount: number;
  /** Exact decimal integer. */
  readonly totalAmountCents: string;
  /** Ordered by category, so two runs of the same input produce the same bytes. */
  readonly categories: readonly ReferenceDataManifestCategory[];
  readonly partitionRows: number;
  /** Ordered by partition index, which is input order. */
  readonly files: readonly ReferenceDataManifestFile[];
  readonly schema: readonly ReferenceDataManifestField[];
  readonly writerSettings: Readonly<Record<string, unknown>>;
}

const MANIFEST_KEYS = Object.freeze(["schemaVersion", "source", "rowCount", "totalAmountCents", "categories", "partitionRows", "files", "schema", "writerSettings"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const PART_NAME = /^part-(\d{5})\.parquet$/;

function record(value: unknown, code: ReferenceDataManifestIssueCode, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(code, `${what} is not an object.`);
  return value as Record<string, unknown>;
}

function whole(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) refuse("manifest_shape", `${what} is not a nonnegative safe integer.`);
  return value;
}

/**
 * Reads one exact decimal amount. A number here is a refusal, not a
 * conversion: the whole point of the string is that the value may not survive
 * one.
 */
export function referenceDataManifestAmount(value: unknown, what: string): bigint {
  if (typeof value !== "string") refuse("manifest_amount", `${what} is not a decimal string; a JSON number cannot carry the declared domain exactly.`);
  if (!DECIMAL.test(value)) refuse("manifest_amount", `${what} is not a nonnegative ASCII decimal integer.`);
  const amount = BigInt(value);
  // A GLOBAL total may exceed one row's domain, so only the per-row bound is
  // checked against the domain; the total is bounded by rows times that bound.
  if (amount > REFERENCE_DATA_LIMITS.maxAmountCents * BigInt(REFERENCE_DATA_LIMITS.maxRows)) refuse("manifest_amount", `${what} exceeds the largest total the declared bounds allow.`);
  return amount;
}

/** The zero-based partition index a member name carries, or `undefined` when it is not one. */
export function referenceDataPartitionIndex(name: string): number | undefined {
  const matched = PART_NAME.exec(name);
  return matched ? Number(matched[1]) : undefined;
}

/** The member name partition `index` must take. */
export function referenceDataPartitionName(index: number): string {
  return `part-${String(index).padStart(5, "0")}.parquet`;
}

/**
 * Reads the manifest the reduction wrote, refusing anything outside its shape.
 *
 * This is a parse, not a validation pass: everything downstream takes the
 * returned value, so a field that gets past here is a field the reconciliation
 * is entitled to trust the TYPE of. It never makes the reconciliation trust the
 * VALUE: every number here is recomputed from the input and the export.
 */
export function assertReferenceDataManifest(value: unknown): ReferenceDataManifest {
  const manifest = record(value, "manifest_shape", "The manifest");
  const keys = Object.keys(manifest).sort();
  if (keys.length !== MANIFEST_KEYS.length || keys.some((key, index) => key !== [...MANIFEST_KEYS].sort()[index])) refuse("manifest_shape", `The manifest holds ${keys.join(",")} rather than exactly ${[...MANIFEST_KEYS].sort().join(",")}.`);
  if (manifest.schemaVersion !== REFERENCE_DATA_MANIFEST_SCHEMA_VERSION) refuse("manifest_schema_version", `The manifest declares ${String(manifest.schemaVersion)}.`);

  const source = record(manifest.source, "manifest_shape", "The manifest source");
  if (typeof source.digest !== "string" || !DIGEST.test(source.digest)) refuse("manifest_shape", "The manifest source digest is not a sha256 reference.");
  const sourceBytes = whole(source.totalBytes, "The manifest source byte count");

  const rowCount = whole(manifest.rowCount, "The manifest row count");
  if (rowCount === 0 || rowCount > REFERENCE_DATA_LIMITS.maxRows) refuse("manifest_totals", `The manifest declares ${rowCount} row(s), outside 1..${REFERENCE_DATA_LIMITS.maxRows}.`);
  const total = referenceDataManifestAmount(manifest.totalAmountCents, "The manifest total");
  const partitionRows = whole(manifest.partitionRows, "The manifest partition size");
  if (partitionRows !== REFERENCE_DATA_LIMITS.partitionRows) refuse("manifest_totals", `The manifest declares ${partitionRows}-row partitions rather than ${REFERENCE_DATA_LIMITS.partitionRows}.`);

  if (!Array.isArray(manifest.categories) || manifest.categories.length === 0) refuse("manifest_shape", "The manifest names no category.");
  const categories: ReferenceDataManifestCategory[] = [];
  let summed = 0n;
  let counted = 0;
  for (const entry of manifest.categories) {
    const bucket = record(entry, "manifest_shape", "A manifest category");
    if (Object.keys(bucket).length !== 3 || typeof bucket.category !== "string" || bucket.category.length === 0) refuse("manifest_shape", "A manifest category is not {category,count,sumCents}.");
    const previous = categories.at(-1);
    if (previous && previous.category >= bucket.category) refuse("manifest_category_order", `Manifest categories are not strictly increasing at ${bucket.category}.`);
    const count = whole(bucket.count, `Category ${bucket.category} count`);
    const sum = referenceDataManifestAmount(bucket.sumCents, `Category ${bucket.category} sum`);
    summed += sum;
    counted += count;
    categories.push(Object.freeze({ category: bucket.category, count, sumCents: bucket.sumCents as string }));
  }
  // The manifest must at least be self-consistent before anything compares it
  // with the export. An internally contradictory manifest is a defect on its
  // own, and saying so here names it precisely.
  if (summed !== total) refuse("manifest_totals", `Manifest category sums total ${summed} against a declared ${total}.`);
  if (counted !== rowCount) refuse("manifest_totals", `Manifest category counts total ${counted} against a declared ${rowCount}.`);

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) refuse("manifest_shape", "The manifest names no exported file.");
  const files: ReferenceDataManifestFile[] = [];
  for (const [index, entry] of manifest.files.entries()) {
    const member = record(entry, "manifest_shape", "A manifest file");
    if (Object.keys(member).length !== 3 || typeof member.name !== "string" || typeof member.digest !== "string" || !DIGEST.test(member.digest)) refuse("manifest_shape", "A manifest file is not {name,digest,encodedBytes}.");
    const bare = member.name.slice(member.name.lastIndexOf("/") + 1);
    if (referenceDataPartitionIndex(bare) !== index) refuse("manifest_file_order", `Manifest file ${index} is ${member.name}, not ${referenceDataPartitionName(index)}.`);
    files.push(Object.freeze({ name: bare, digest: member.digest, encodedBytes: whole(member.encodedBytes, `File ${member.name} size`) }));
  }
  if (files.length !== Math.ceil(rowCount / partitionRows)) refuse("manifest_file_order", `The manifest names ${files.length} file(s) for ${rowCount} row(s) of ${partitionRows}.`);

  if (!Array.isArray(manifest.schema) || manifest.schema.length !== REFERENCE_DATA_PARQUET_SCHEMA.length) refuse("manifest_schema", `The manifest declares ${Array.isArray(manifest.schema) ? manifest.schema.length : 0} column(s).`);
  const schema: ReferenceDataManifestField[] = [];
  for (const [index, entry] of manifest.schema.entries()) {
    const field = record(entry, "manifest_schema", "A manifest column");
    const declared = REFERENCE_DATA_PARQUET_SCHEMA[index] as (typeof REFERENCE_DATA_PARQUET_SCHEMA)[number];
    if (field.name !== declared.name || field.physicalType !== declared.physicalType || field.logicalType !== declared.logicalType || field.repetition !== declared.repetition) {
      refuse("manifest_schema", `Manifest column ${index} is not ${declared.name}:${declared.physicalType}/${declared.logicalType}/${declared.repetition}.`);
    }
    schema.push(Object.freeze({ name: declared.name, physicalType: declared.physicalType, logicalType: declared.logicalType, repetition: declared.repetition }));
  }

  return Object.freeze({
    schemaVersion: REFERENCE_DATA_MANIFEST_SCHEMA_VERSION,
    source: Object.freeze({ digest: source.digest, totalBytes: sourceBytes }),
    rowCount,
    totalAmountCents: manifest.totalAmountCents as string,
    categories: Object.freeze(categories),
    partitionRows,
    files: Object.freeze(files),
    schema: Object.freeze(schema),
    writerSettings: Object.freeze({ ...record(manifest.writerSettings, "manifest_shape", "The manifest writer settings") }),
  });
}
