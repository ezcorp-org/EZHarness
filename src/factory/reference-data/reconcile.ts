import type { FactoryValidatorClaimOutcome, FactoryValidatorClaimReport, FactoryValidatorVerdict } from "@ezcorp/factory-sdk";
import { digestBytes } from "../../extensions/v4/blobs";
import { REFERENCE_DATA_LIMITS, referenceDataPartitions, type ReferenceDataRow } from "./csv";
import {
  assertReferenceDataManifest,
  referenceDataPartitionIndex,
  referenceDataPartitionName,
  ReferenceDataManifestError,
  type ReferenceDataManifest,
} from "./manifest";
import { readReferenceDataParquet, REFERENCE_DATA_PARQUET_SCHEMA, ReferenceDataParquetError } from "./parquet";

/**
 * The protected reconciliation of `reference.data.v1`.
 *
 * C10: "A separate validator recomputes these claims from the snapshotted
 * input and exported Parquet, not the transform's self-reported counters."
 * That is the whole design of this module. It reads the immutable input with
 * the strict grammar, decodes the export with this pack's own Parquet reader,
 * and compares them. The manifest's numbers are CHECKED here; they are never
 * an input to the recomputation, and neither is any counter the transform
 * reported.
 *
 * Order is part of the claim. C10 requires the export to hold "exactly the
 * validated input rows, in input order", so rows are compared position by
 * position and never as sets.
 */

/** The six claims the compiled definition binds to this validator. */
export const REFERENCE_DATA_CLAIM_IDS = Object.freeze([
  "output-schema",
  "row-count-unique-ids",
  "source-row-values",
  "category-and-global-totals",
  "no-null-negative-overflow",
  "partition-sequence-complete",
] as const);
export type ReferenceDataClaimId = (typeof REFERENCE_DATA_CLAIM_IDS)[number];

/** One exported Parquet member, in export order. */
export interface ReferenceDataExportPart {
  /** The member name inside the export directory, which carries its partition index. */
  readonly name: string;
  /** Read once, by the validator, from the published bytes. */
  read(): Promise<Uint8Array>;
}

export interface ReferenceDataReconciliationInput {
  /** The immutable input snapshot, opened fresh for this reconciliation. */
  source(): AsyncIterable<Uint8Array>;
  /** The exported `manifest.json` bytes. */
  readonly manifest: Uint8Array;
  /** Every exported Parquet member, in export order. */
  readonly parts: readonly ReferenceDataExportPart[];
  /** When the measurement was taken. Supplied, never read from a clock here. */
  readonly measuredAtMs: number;
}

interface Finding {
  readonly claim: ReferenceDataClaimId;
  readonly reasonCode: string;
  readonly detail: string;
}

/** The accounting one side of the comparison contributes. */
class Accounting {
  rowCount = 0;
  total = 0n;
  readonly categories = new Map<string, { count: number; sum: bigint }>();
  add(category: string, amount: bigint): void {
    this.rowCount += 1;
    this.total += amount;
    const bucket = this.categories.get(category);
    if (bucket) {
      bucket.count += 1;
      bucket.sum += amount;
    } else this.categories.set(category, { count: 1, sum: amount });
  }
}

/**
 * A bounded index of what the export has already used as a record identifier.
 *
 * It holds a 128-bit digest per identifier rather than the identifier, because
 * a million identifiers at their declared byte bound would not fit beside the
 * rest of the reconciliation. A collision can only cause a REFUSAL, so the
 * index fails closed; at 128 bits the chance of one over a million rows is
 * about 1.5e-27. The Python guest's parse step uses the same argument.
 */
class IdentifierIndex {
  private readonly seen = new Set<string>();
  private readonly encoder = new TextEncoder();
  add(recordId: string): boolean {
    const marker = digestBytes(this.encoder.encode(recordId)).slice(0, 32);
    if (this.seen.has(marker)) return false;
    this.seen.add(marker);
    return true;
  }
  get size(): number {
    return this.seen.size;
  }
}

/** Pulls the immutable input one row at a time, so a 256 MiB source is never held whole. */
class SourceRows {
  private readonly partitions: AsyncGenerator<{ rows: readonly ReferenceDataRow[] }, unknown>;
  private buffered: readonly ReferenceDataRow[] = [];
  private at = 0;
  private ended = false;
  /** Set when the input itself is refused, which is a different finding from a mismatch. */
  failure: Error | undefined;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.partitions = referenceDataPartitions(source) as AsyncGenerator<{ rows: readonly ReferenceDataRow[] }, unknown>;
  }

  async next(): Promise<ReferenceDataRow | undefined> {
    for (;;) {
      if (this.at < this.buffered.length) return this.buffered[this.at++];
      if (this.ended) return undefined;
      let step: IteratorResult<{ rows: readonly ReferenceDataRow[] }, unknown>;
      try {
        step = await this.partitions.next();
      } catch (error) {
        this.ended = true;
        this.failure = error instanceof Error ? error : new Error(String(error));
        return undefined;
      }
      if (step.done) {
        this.ended = true;
        return undefined;
      }
      this.buffered = step.value.rows;
      this.at = 0;
    }
  }

  /**
   * Reads whatever the export did not, so the input's own accounting is
   * complete even when the export stopped early. Returns how many rows were
   * left over, which is a dropped-row count.
   */
  async drain(into: Accounting): Promise<number> {
    let remaining = 0;
    for (let row = await this.next(); row !== undefined; row = await this.next()) {
      into.add(row.category, row.amountCents);
      remaining += 1;
    }
    return remaining;
  }
}

function outcome(id: ReferenceDataClaimId, verdict: FactoryValidatorVerdict, reasonCode: string, summary: string, measuredAtMs: number): FactoryValidatorClaimOutcome {
  return Object.freeze({
    id,
    verdict,
    decisive: verdict === "PASS" || verdict === "FAIL",
    summary: summary.slice(0, 2048),
    reasonCode: reasonCode.slice(0, 128),
    evidence: Object.freeze([]),
    measuredAtMs,
  });
}

function describe(bucket: Map<string, { count: number; sum: bigint }>): string {
  return [...bucket.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([name, total]) => `${name}=${total.count}/${total.sum}`).join(" ");
}

/** How a reconciliation step records one defect against one claim. */
type Fail = (claim: ReferenceDataClaimId, reasonCode: string, detail: string) => void;

/** The running state one pass over the exported partitions accumulates. */
interface ExportPass {
  readonly source: SourceRows;
  readonly exported: Accounting;
  readonly inputTotals: Accounting;
  readonly identifiers: IdentifierIndex;
  /** The next row's index in export order, counted across every member. */
  position: number;
  /** The schema is the export's, so it is read from the first member only. */
  schemaChecked: boolean;
  decodedEvery: boolean;
}

/**
 * Which members exist, before any of them is decoded.
 *
 * The manifest names its members; the export supplies them. A disagreement
 * about WHICH files exist is a partition-sequence failure, and it is checked
 * before anything is decoded so a missing member is named rather than
 * discovered as a short row count.
 */
function checkPartitionSequence(input: ReferenceDataReconciliationInput, manifest: ReferenceDataManifest, fail: Fail): void {
  const supplied = input.parts.map(part => part.name.slice(part.name.lastIndexOf("/") + 1));
  const declared = manifest.files.map(file => file.name);
  for (const [index, name] of supplied.entries()) {
    if (referenceDataPartitionIndex(name) !== index) fail("partition-sequence-complete", "partition_out_of_order", `Exported member ${index} is ${name}, not ${referenceDataPartitionName(index)}.`);
  }
  for (const name of declared) if (!supplied.includes(name)) fail("partition-sequence-complete", "partition_missing", `The manifest names ${name} and the export does not hold it.`);
  for (const name of supplied) if (!declared.includes(name)) fail("partition-sequence-complete", "partition_unexpected", `The export holds ${name} and the manifest does not name it.`);
}

/** The decoded columns, against the one schema the definition fixes. */
function checkPartitionSchema(partName: string, schema: ReturnType<typeof readReferenceDataParquet>["schema"], fail: Fail): void {
  for (const [column, field] of schema.entries()) {
    const expected = REFERENCE_DATA_PARQUET_SCHEMA[column] as (typeof REFERENCE_DATA_PARQUET_SCHEMA)[number];
    if (field.name !== expected.name || field.physicalType !== expected.physicalType || field.logicalType !== expected.logicalType || field.repetition !== expected.repetition) {
      fail("output-schema", "schema_mismatch", `${partName} column ${column} is ${field.name}:${field.physicalType}/${field.logicalType}/${field.repetition}.`);
    }
  }
}

/**
 * One member's rows, compared position by position with the immutable input.
 *
 * Order is part of the claim, so the input is pulled one row per exported row
 * and never matched as a set.
 */
async function accountPartitionRows(partName: string, rows: ReturnType<typeof readReferenceDataParquet>["rows"], pass: ExportPass, fail: Fail): Promise<void> {
  for (const row of rows) {
    const position = pass.position;
    if (row.amountCents < 0n) fail("no-null-negative-overflow", "amount_negative", `${partName} row ${position} holds ${row.amountCents}.`);
    else if (row.amountCents > REFERENCE_DATA_LIMITS.maxAmountCents) fail("no-null-negative-overflow", "amount_overflow", `${partName} row ${position} holds ${row.amountCents}, past the declared domain.`);
    if (row.recordId.length === 0 || row.category.length === 0) fail("no-null-negative-overflow", "value_empty", `${partName} row ${position} holds an empty identifier or category.`);
    if (!pass.identifiers.add(row.recordId)) fail("row-count-unique-ids", "record_id_duplicate", `${partName} row ${position} repeats record_id ${row.recordId}.`);
    const expected = await pass.source.next();
    if (!expected) {
      // A refused INPUT is reported once, by the caller, as its own reason.
      // Saying "the export holds a row the input does not" about an input that
      // was never readable would name the wrong side of the comparison.
      if (!pass.source.failure) fail("source-row-values", "row_unmatched", `The export holds row ${position} and the input does not.`);
    } else {
      pass.inputTotals.add(expected.category, expected.amountCents);
      if (expected.recordId !== row.recordId || expected.category !== row.category || expected.amountCents !== row.amountCents) {
        fail("source-row-values", "row_changed", `Row ${position} is ${row.recordId},${row.category},${row.amountCents} in the export and ${expected.recordId},${expected.category},${expected.amountCents} in the input.`);
      }
    }
    pass.exported.add(row.category, row.amountCents);
    pass.position += 1;
  }
}

/** Decodes one exported member and folds it into the running accounting. */
async function accountPartition(part: ReferenceDataExportPart, index: number, partCount: number, manifest: ReferenceDataManifest, pass: ExportPass, fail: Fail): Promise<void> {
  let decoded: ReturnType<typeof readReferenceDataParquet>;
  try {
    decoded = readReferenceDataParquet(await part.read());
  } catch (error) {
    pass.decodedEvery = false;
    const reason = error instanceof ReferenceDataParquetError ? error.code : "parquet_unreadable";
    fail("output-schema", reason, `${part.name} is not readable as the declared Parquet: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!pass.schemaChecked) {
    pass.schemaChecked = true;
    checkPartitionSchema(part.name, decoded.schema, fail);
  }
  const last = index === partCount - 1;
  if (!last && decoded.rowCount !== manifest.partitionRows) fail("partition-sequence-complete", "partition_short", `${part.name} holds ${decoded.rowCount} row(s) and only the last partition may hold fewer than ${manifest.partitionRows}.`);
  if (decoded.rowCount === 0 || decoded.rowCount > manifest.partitionRows) fail("partition-sequence-complete", "partition_size", `${part.name} holds ${decoded.rowCount} row(s), outside 1..${manifest.partitionRows}.`);

  await accountPartitionRows(part.name, decoded.rows, pass, fail);
}

/**
 * The recomputed accounting against both other sides of the claim.
 *
 * Both comparisons are made, and the INPUT one is what stops a transform
 * certifying itself: a defect that also wrote a matching manifest agrees with
 * itself and still disagrees with the immutable source.
 */
function checkRecomputedTotals(manifest: ReferenceDataManifest, pass: ExportPass, fail: Fail): void {
  const { exported, inputTotals, identifiers } = pass;
  if (exported.rowCount !== manifest.rowCount) fail("row-count-unique-ids", "row_count_manifest", `The export holds ${exported.rowCount} row(s) and the manifest declares ${manifest.rowCount}.`);
  if (exported.rowCount !== inputTotals.rowCount) fail("row-count-unique-ids", "row_count_source", `The export holds ${exported.rowCount} row(s) and the immutable input holds ${inputTotals.rowCount}.`);
  if (identifiers.size !== exported.rowCount) fail("row-count-unique-ids", "record_id_not_unique", `The export holds ${exported.rowCount} row(s) with ${identifiers.size} distinct record_id(s).`);
  compare(exported, inputTotals, "source", fail);
  compare(exported, manifestAccounting(manifest), "manifest", fail);
}

/**
 * Recomputes every mandatory claim from the immutable input and the exported
 * bytes, and reports one strict claim report.
 *
 * A claim that could not be measured is `INCONCLUSIVE`, never a pass: C10's
 * decision rule treats only `PASS` as satisfying a required claim, and a
 * reconciliation that could not read the export has not agreed with it.
 *
 * The phases run in the order the claims depend on each other: the manifest is
 * parsed, the member list is checked, every member is decoded and accounted,
 * and only then are the recomputed totals compared.
 */
export async function reconcileReferenceData(input: ReferenceDataReconciliationInput): Promise<FactoryValidatorClaimReport> {
  const measured = input.measuredAtMs;
  const findings: Finding[] = [];
  const unmeasured = new Set<ReferenceDataClaimId>();
  const fail: Fail = (claim, reasonCode, detail) => findings.push({ claim, reasonCode, detail });

  let manifest: ReferenceDataManifest | undefined;
  try {
    manifest = assertReferenceDataManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.manifest)) as unknown);
  } catch (error) {
    const reason = error instanceof ReferenceDataManifestError ? error.code : "manifest_unreadable";
    fail("output-schema", reason, `The exported manifest is not the declared shape: ${error instanceof Error ? error.message : String(error)}`);
    for (const claim of REFERENCE_DATA_CLAIM_IDS) if (claim !== "output-schema") unmeasured.add(claim);
    return report(findings, unmeasured, measured);
  }

  checkPartitionSequence(input, manifest, fail);

  const pass: ExportPass = {
    source: new SourceRows(input.source()),
    exported: new Accounting(),
    inputTotals: new Accounting(),
    identifiers: new IdentifierIndex(),
    position: 0,
    schemaChecked: false,
    decodedEvery: true,
  };

  for (const [index, part] of input.parts.entries()) {
    await accountPartition(part, index, input.parts.length, manifest, pass, fail);
  }

  const leftOver = await pass.source.drain(pass.inputTotals);
  if (pass.source.failure) {
    // The input itself is refused. That is not an export defect, so every claim
    // that rests on comparing the two is unmeasurable rather than failed.
    fail("source-row-values", "source_refused", `The immutable input is refused by the strict grammar: ${pass.source.failure.message}`);
    unmeasured.add("category-and-global-totals");
    unmeasured.add("row-count-unique-ids");
  } else if (leftOver > 0 && pass.decodedEvery) {
    fail("source-row-values", "row_dropped", `The input holds ${leftOver} row(s) the export's ${pass.position} do not.`);
  }

  if (!pass.decodedEvery) {
    for (const claim of ["row-count-unique-ids", "source-row-values", "category-and-global-totals", "no-null-negative-overflow"] as const) unmeasured.add(claim);
  } else if (!unmeasured.has("category-and-global-totals")) {
    checkRecomputedTotals(manifest, pass, fail);
  }

  return report(findings, unmeasured, measured, describe(pass.exported.categories), pass.exported.rowCount, pass.exported.total);
}

/** The accounting the manifest states, so both comparisons run through one routine. */
function manifestAccounting(manifest: ReferenceDataManifest): Accounting {
  const stated = new Accounting();
  stated.rowCount = manifest.rowCount;
  stated.total = BigInt(manifest.totalAmountCents);
  for (const entry of manifest.categories) stated.categories.set(entry.category, { count: entry.count, sum: BigInt(entry.sumCents) });
  return stated;
}

/** Compares the export's recomputed accounting with one other side of the claim. */
function compare(exported: Accounting, other: Accounting, side: "source" | "manifest", fail: Fail): void {
  if (exported.total !== other.total) fail("category-and-global-totals", `total_${side}`, `The export totals ${exported.total} and the ${side} says ${other.total}.`);
  for (const [name, totals] of exported.categories) {
    const stated = other.categories.get(name);
    if (!stated) fail("category-and-global-totals", `category_absent_in_${side}`, `The export holds category ${name} and the ${side} does not.`);
    else if (stated.count !== totals.count || stated.sum !== totals.sum) fail("category-and-global-totals", `category_${side}`, `Category ${name} is ${totals.count}/${totals.sum} in the export and ${stated.count}/${stated.sum} in the ${side}.`);
  }
  for (const name of other.categories.keys()) if (!exported.categories.has(name)) fail("category-and-global-totals", `category_absent_in_export_${side}`, `The ${side} names category ${name} and the export holds no such row.`);
}

function report(findings: readonly Finding[], unmeasured: ReadonlySet<ReferenceDataClaimId>, measured: number, categories = "", rowCount = 0, total = 0n): FactoryValidatorClaimReport {
  const claims = REFERENCE_DATA_CLAIM_IDS.map(id => {
    const failures = findings.filter(finding => finding.claim === id);
    if (failures.length > 0) {
      const first = failures[0] as Finding;
      const extra = failures.length > 1 ? ` (and ${failures.length - 1} more)` : "";
      return outcome(id, "FAIL", first.reasonCode, `${first.detail}${extra}`, measured);
    }
    if (unmeasured.has(id)) return outcome(id, "INCONCLUSIVE", "claim_unmeasured", "The export could not be read, so this claim was not measured; it is not a pass.", measured);
    return outcome(id, "PASS", `${id.replaceAll("-", "_")}_recomputed`, passSummary(id, categories, rowCount, total), measured);
  });
  return Object.freeze({ schemaVersion: "factory.validator-claims.v1", claims: Object.freeze(claims) });
}

function passSummary(id: ReferenceDataClaimId, categories: string, rowCount: number, total: bigint): string {
  switch (id) {
    case "output-schema":
      return `Every exported file declares exactly ${REFERENCE_DATA_PARQUET_SCHEMA.map(field => `${field.name}:${field.physicalType}`).join(", ")}, all REQUIRED.`;
    case "row-count-unique-ids":
      return `${rowCount} exported row(s), every record_id distinct, matching the manifest.`;
    case "source-row-values":
      return `Every exported row equals its input row at the same position, recomputed from the immutable input.`;
    case "category-and-global-totals":
      return `Exported total ${total}; per category ${categories || "none"}; both match the manifest exactly.`;
    case "no-null-negative-overflow":
      return `No null, negative, or out-of-domain amount in ${rowCount} exported row(s).`;
    default:
      return `Every partition index appears once, in order, with no gap.`;
  }
}
