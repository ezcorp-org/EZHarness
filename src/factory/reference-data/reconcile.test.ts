import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FactoryValidatorClaimReport, FactoryValidatorVerdict } from "@ezcorp/factory-sdk";
import { validateFactoryValidatorClaimReport } from "@ezcorp/factory-sdk";
import { REFERENCE_DATA_HEADER, REFERENCE_DATA_LIMITS } from "./csv";
import { referenceDataPartitionName } from "./manifest";
import { reconcileReferenceData, REFERENCE_DATA_CLAIM_IDS, type ReferenceDataClaimId, type ReferenceDataExportPart } from "./reconcile";

/**
 * The protected reconciliation, against the real exported bytes.
 *
 * Every negative here is a file PyArrow actually wrote, so a claim that passes
 * passes against an export and not against a mock of one. The cases follow
 * C10's own list: the golden three rows, then duplicate, missing partition,
 * changed value, overflow, malformed, and the domain boundary.
 */

const FIXTURES = join(import.meta.dir, "fixtures/parquet");
const GOLDEN_CSV = `${REFERENCE_DATA_HEADER}\na,alpha,100\nb,beta,250\nc,alpha,50\n`;
const MEASURED_AT = 1_700_000_000_000;

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(FIXTURES, `${name}.parquet`)));
}

function part(name: string, bytes: Uint8Array): ReferenceDataExportPart {
  return { name, read: async () => bytes };
}

function digest(fill: string): string {
  return `sha256:${fill.repeat(64).slice(0, 64)}`;
}

interface ManifestShape {
  rowCount: number;
  totalAmountCents: string;
  categories: Array<{ category: string; count: number; sumCents: string }>;
  files: string[];
}

function manifestBytes(shape: Partial<ManifestShape> = {}): Uint8Array {
  const document = {
    schemaVersion: "factory.reference-data-manifest.v1",
    source: { digest: digest("a"), totalBytes: GOLDEN_CSV.length },
    rowCount: shape.rowCount ?? 3,
    totalAmountCents: shape.totalAmountCents ?? "400",
    categories: shape.categories ?? [
      { category: "alpha", count: 2, sumCents: "150" },
      { category: "beta", count: 1, sumCents: "250" },
    ],
    partitionRows: REFERENCE_DATA_LIMITS.partitionRows,
    files: (shape.files ?? [referenceDataPartitionName(0)]).map(name => ({ name, digest: digest("b"), encodedBytes: 1 })),
    schema: [
      { name: "record_id", physicalType: "BYTE_ARRAY", logicalType: "STRING", repetition: "REQUIRED" },
      { name: "category", physicalType: "BYTE_ARRAY", logicalType: "STRING", repetition: "REQUIRED" },
      { name: "amount_cents", physicalType: "INT64", logicalType: "NONE", repetition: "REQUIRED" },
    ],
    writerSettings: { compression: "none", use_dictionary: false },
  };
  return new TextEncoder().encode(JSON.stringify(document));
}

/**
 * A self-consistent manifest for a two-partition export. `partitionRows` is
 * C10's pinned ten thousand, so anything with more than one partition declares
 * at least that many rows and its categories must add up to them.
 */
function twoPartitions(): Partial<ManifestShape> {
  return {
    rowCount: 20_000,
    totalAmountCents: "20000",
    categories: [{ category: "alpha", count: 20_000, sumCents: "20000" }],
    files: [referenceDataPartitionName(0), referenceDataPartitionName(1)],
  };
}

async function* source(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

async function reconcile(csv: string, manifest: Uint8Array, parts: readonly ReferenceDataExportPart[]): Promise<FactoryValidatorClaimReport> {
  const report = await reconcileReferenceData({ source: () => source(csv), manifest, parts, measuredAtMs: MEASURED_AT });
  // Whatever the verdicts, the report itself must be one the host would admit.
  const issues = validateFactoryValidatorClaimReport(report);
  expect(issues.ok).toBe(true);
  expect(report.claims.map(claim => claim.id)).toEqual([...REFERENCE_DATA_CLAIM_IDS]);
  for (const claim of report.claims) {
    expect(claim.measuredAtMs).toBe(MEASURED_AT);
    expect(claim.reasonCode.length).toBeGreaterThan(0);
    expect(claim.summary.length).toBeGreaterThan(0);
  }
  return report;
}

function verdicts(report: FactoryValidatorClaimReport): Record<ReferenceDataClaimId, FactoryValidatorVerdict> {
  return Object.fromEntries(report.claims.map(claim => [claim.id, claim.verdict])) as Record<ReferenceDataClaimId, FactoryValidatorVerdict>;
}

function reasons(report: FactoryValidatorClaimReport, id: ReferenceDataClaimId): string {
  return report.claims.find(claim => claim.id === id)?.reasonCode ?? "";
}

test("the golden export reconciles exactly with the immutable input, and every claim passes", async () => {
  const report = await reconcile(GOLDEN_CSV, manifestBytes(), [part("part-00000.parquet", await fixture("golden"))]);
  expect(verdicts(report)).toEqual({
    "output-schema": "PASS",
    "row-count-unique-ids": "PASS",
    "source-row-values": "PASS",
    "category-and-global-totals": "PASS",
    "no-null-negative-overflow": "PASS",
    "partition-sequence-complete": "PASS",
  });
  for (const claim of report.claims) expect(claim.decisive).toBe(true);
});

test("a changed value fails against the input even when the manifest agrees with the export", async () => {
  // This is the transform-self-certification case: a defective transform that
  // also wrote a matching manifest. The manifest comparison passes and the
  // input comparison does not, which is why both are made.
  const agreeing = manifestBytes({ totalAmountCents: "401", categories: [{ category: "alpha", count: 2, sumCents: "150" }, { category: "beta", count: 1, sumCents: "251" }] });
  const report = await reconcile(GOLDEN_CSV, agreeing, [part("part-00000.parquet", await fixture("changed-value"))]);
  expect(verdicts(report)["source-row-values"]).toBe("FAIL");
  expect(verdicts(report)["category-and-global-totals"]).toBe("FAIL");
  expect(reasons(report, "category-and-global-totals")).toBe("total_source");
  expect(reasons(report, "source-row-values")).toBe("row_changed");
});

test("a changed value also fails against a manifest that still states the input's totals", async () => {
  const report = await reconcile(GOLDEN_CSV, manifestBytes(), [part("part-00000.parquet", await fixture("changed-value"))]);
  expect(verdicts(report)["category-and-global-totals"]).toBe("FAIL");
  expect(verdicts(report)["source-row-values"]).toBe("FAIL");
});

test("a dropped row is named as a dropped row, not as a smaller but consistent export", async () => {
  const report = await reconcile(GOLDEN_CSV, manifestBytes(), [part("part-00000.parquet", await fixture("dropped-row"))]);
  expect(verdicts(report)["source-row-values"]).toBe("FAIL");
  expect(verdicts(report)["row-count-unique-ids"]).toBe("FAIL");
  expect(verdicts(report)["category-and-global-totals"]).toBe("FAIL");
  expect(reasons(report, "source-row-values")).toBe("row_changed");
});

test("rows in a different order fail, because order is part of the claim", async () => {
  const report = await reconcile(GOLDEN_CSV, manifestBytes(), [part("part-00000.parquet", await fixture("reordered"))]);
  expect(verdicts(report)["source-row-values"]).toBe("FAIL");
  // Every total still adds up, which is exactly why order is checked separately.
  expect(verdicts(report)["category-and-global-totals"]).toBe("PASS");
  expect(verdicts(report)["row-count-unique-ids"]).toBe("PASS");
});

test("a repeated record_id fails the uniqueness claim", async () => {
  const report = await reconcile(`${REFERENCE_DATA_HEADER}\na,alpha,100\nb,beta,250\nc,alpha,50\n`, manifestBytes(), [part("part-00000.parquet", await fixture("duplicate-id"))]);
  expect(verdicts(report)["row-count-unique-ids"]).toBe("FAIL");
  expect(reasons(report, "row-count-unique-ids")).toBe("record_id_duplicate");
});

test("a changed category fails both the row claim and the per-category totals", async () => {
  const report = await reconcile(GOLDEN_CSV, manifestBytes(), [part("part-00000.parquet", await fixture("changed-category"))]);
  expect(verdicts(report)["source-row-values"]).toBe("FAIL");
  expect(verdicts(report)["category-and-global-totals"]).toBe("FAIL");
});

test("a negative amount fails the value-domain claim", async () => {
  const csv = `${REFERENCE_DATA_HEADER}\na,alpha,100\nb,beta,1\n`;
  const report = await reconcile(csv, manifestBytes({ rowCount: 2, totalAmountCents: "101", categories: [{ category: "alpha", count: 1, sumCents: "100" }, { category: "beta", count: 1, sumCents: "1" }] }), [part("part-00000.parquet", await fixture("negative-amount"))]);
  expect(verdicts(report)["no-null-negative-overflow"]).toBe("FAIL");
  expect(reasons(report, "no-null-negative-overflow")).toBe("amount_negative");
});

test("the domain boundary reconciles exactly, with no rounding anywhere", async () => {
  const limit = REFERENCE_DATA_LIMITS.maxAmountCents;
  const csv = `${REFERENCE_DATA_HEADER}\nzero,alpha,0\nbig,beta,${limit}\n`;
  const manifest = manifestBytes({
    rowCount: 2,
    totalAmountCents: String(limit),
    categories: [{ category: "alpha", count: 1, sumCents: "0" }, { category: "beta", count: 1, sumCents: String(limit) }],
  });
  const report = await reconcile(csv, manifest, [part("part-00000.parquet", await fixture("boundary"))]);
  expect(verdicts(report)["category-and-global-totals"]).toBe("PASS");
  expect(verdicts(report)["source-row-values"]).toBe("PASS");
  expect(verdicts(report)["no-null-negative-overflow"]).toBe("PASS");
});

test("an export the pinned settings forbid fails the schema claim and leaves the rest unmeasured", async () => {
  const report = await reconcile(GOLDEN_CSV, manifestBytes(), [part("part-00000.parquet", await fixture("nullable"))]);
  expect(verdicts(report)["output-schema"]).toBe("FAIL");
  expect(reasons(report, "output-schema")).toBe("parquet_repetition");
  for (const id of ["row-count-unique-ids", "source-row-values", "category-and-global-totals", "no-null-negative-overflow"] as const) {
    expect([id, verdicts(report)[id]]).toEqual([id, "INCONCLUSIVE"]);
    expect(report.claims.find(claim => claim.id === id)?.decisive).toBe(false);
  }
});

test("an unreadable manifest fails the schema claim and measures nothing else", async () => {
  for (const manifest of [new Uint8Array([0xff, 0xfe]), new TextEncoder().encode("not json"), new TextEncoder().encode("{}")]) {
    const report = await reconcile(GOLDEN_CSV, manifest, [part("part-00000.parquet", await fixture("golden"))]);
    expect(verdicts(report)["output-schema"]).toBe("FAIL");
    for (const id of REFERENCE_DATA_CLAIM_IDS) if (id !== "output-schema") expect([id, verdicts(report)[id]]).toEqual([id, "INCONCLUSIVE"]);
  }
});

test("a missing partition is named, not closed over", async () => {
  const manifest = manifestBytes(twoPartitions());
  const report = await reconcile(GOLDEN_CSV, manifest, [part("part-00000.parquet", await fixture("golden"))]);
  expect(verdicts(report)["partition-sequence-complete"]).toBe("FAIL");
  expect(reasons(report, "partition-sequence-complete")).toBe("partition_missing");
});

test("an unexpected partition and a partition out of order are both refused", async () => {
  const golden = await fixture("golden");
  const unexpected = await reconcile(GOLDEN_CSV, manifestBytes(), [part("part-00000.parquet", golden), part("part-00001.parquet", golden)]);
  expect(reasons(unexpected, "partition-sequence-complete")).toBe("partition_unexpected");
  const outOfOrder = await reconcile(GOLDEN_CSV, manifestBytes(twoPartitions()), [part("part-00001.parquet", golden), part("part-00000.parquet", golden)]);
  expect(reasons(outOfOrder, "partition-sequence-complete")).toBe("partition_out_of_order");
});

test("a partition shorter than the declared size is refused unless it is the last one", async () => {
  const golden = await fixture("golden");
  const report = await reconcile(`${GOLDEN_CSV}d,beta,1\n`, manifestBytes(twoPartitions()), [part("part-00000.parquet", golden), part("part-00001.parquet", golden)]);
  expect(verdicts(report)["partition-sequence-complete"]).toBe("FAIL");
  expect(reasons(report, "partition-sequence-complete")).toBe("partition_short");
});

test("an input the strict grammar refuses leaves the comparison unmeasurable rather than passed", async () => {
  const overflowing = `${REFERENCE_DATA_HEADER}\na,alpha,100\nb,beta,250\nc,alpha,${REFERENCE_DATA_LIMITS.maxAmountCents + 1n}\n`;
  const report = await reconcile(overflowing, manifestBytes(), [part("part-00000.parquet", await fixture("golden"))]);
  expect(verdicts(report)["source-row-values"]).toBe("FAIL");
  expect(reasons(report, "source-row-values")).toBe("source_refused");
  expect(verdicts(report)["category-and-global-totals"]).toBe("INCONCLUSIVE");
  expect(verdicts(report)["row-count-unique-ids"]).toBe("INCONCLUSIVE");
});

test("an export with more rows than the input names the unmatched row", async () => {
  const report = await reconcile(`${REFERENCE_DATA_HEADER}\na,alpha,100\n`, manifestBytes({ rowCount: 1, totalAmountCents: "100", categories: [{ category: "alpha", count: 1, sumCents: "100" }] }), [part("part-00000.parquet", await fixture("golden"))]);
  expect(verdicts(report)["source-row-values"]).toBe("FAIL");
  expect(reasons(report, "source-row-values")).toBe("row_unmatched");
});

test("a manifest naming a category the export does not hold fails the totals claim", async () => {
  const manifest = manifestBytes({ categories: [{ category: "alpha", count: 2, sumCents: "150" }, { category: "gamma", count: 1, sumCents: "250" }] });
  const report = await reconcile(GOLDEN_CSV, manifest, [part("part-00000.parquet", await fixture("golden"))]);
  expect(verdicts(report)["category-and-global-totals"]).toBe("FAIL");
  expect(reasons(report, "category-and-global-totals")).toBe("category_absent_in_manifest");
});
