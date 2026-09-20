import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertReferenceDataManifest,
  referenceDataManifestAmount,
  referenceDataPartitionIndex,
  referenceDataPartitionName,
  REFERENCE_DATA_MANIFEST_SCHEMA_VERSION,
  ReferenceDataManifestError,
  type ReferenceDataManifestIssueCode,
} from "./manifest";

/**
 * The manifest contract.
 *
 * The assertion below is a parse: a field that gets past it is a field the
 * reconciliation may trust the TYPE of, and never the VALUE of. These cases
 * fix which shapes get past it.
 */

const GOLDEN = JSON.parse(await readFile(join(import.meta.dir, "fixtures/parquet/golden-manifest.json"), "utf8")) as Record<string, unknown>;

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...structuredClone(GOLDEN), ...overrides };
}

function refused(value: unknown): ReferenceDataManifestIssueCode {
  try {
    assertReferenceDataManifest(value);
  } catch (error) {
    if (error instanceof ReferenceDataManifestError) return error.code;
    throw error;
  }
  throw new Error("the contract accepted a manifest it must refuse");
}

test("the golden manifest carries C10's expected totals, with sums as exact decimal strings", () => {
  const parsed = assertReferenceDataManifest(manifest());
  expect(parsed.schemaVersion).toBe(REFERENCE_DATA_MANIFEST_SCHEMA_VERSION);
  expect(parsed.rowCount).toBe(3);
  expect(parsed.totalAmountCents).toBe("400");
  expect(parsed.categories).toEqual([
    { category: "alpha", count: 2, sumCents: "150" },
    { category: "beta", count: 1, sumCents: "250" },
  ]);
  expect(parsed.files.map(file => file.name)).toEqual(["part-00000.parquet"]);
  expect(parsed.partitionRows).toBe(10_000);
  expect(parsed.schema.map(field => field.name)).toEqual(["record_id", "category", "amount_cents"]);
});

test("a sum written as a JSON number is refused, because the domain does not survive one", () => {
  expect(refused(manifest({ totalAmountCents: 400 }))).toBe("manifest_amount");
  expect(referenceDataManifestAmount("9223372036854775807", "x")).toBe(9_223_372_036_854_775_807n);
  // Reading the same digits as a JSON number loses the last three of them,
  // which is exactly what the decimal string exists to prevent.
  expect(BigInt(Number("9223372036854775807"))).toBe(9_223_372_036_854_775_808n);
  expect(BigInt(Number("9223372036854775807"))).not.toBe(9_223_372_036_854_775_807n);
  for (const bad of ["", "-1", "+1", "007", "1.0", "1e3", " 1"]) {
    expect(() => referenceDataManifestAmount(bad, "x")).toThrow(ReferenceDataManifestError);
  }
  expect(() => referenceDataManifestAmount("9".repeat(40), "x")).toThrow(ReferenceDataManifestError);
});

test("a manifest that contradicts itself is refused before anything compares it with the export", () => {
  expect(refused(manifest({ totalAmountCents: "401" }))).toBe("manifest_totals");
  expect(refused(manifest({ rowCount: 4 }))).toBe("manifest_totals");
  expect(refused(manifest({ rowCount: 0 }))).toBe("manifest_totals");
  expect(refused(manifest({ partitionRows: 5_000 }))).toBe("manifest_totals");
});

test("categories are strictly increasing, so one input always produces one manifest", () => {
  const reversed = manifest();
  reversed.categories = [...(GOLDEN.categories as unknown[])].reverse();
  expect(refused(reversed)).toBe("manifest_category_order");
  const repeated = manifest();
  repeated.categories = [{ category: "alpha", count: 2, sumCents: "150" }, { category: "alpha", count: 1, sumCents: "250" }];
  expect(refused(repeated)).toBe("manifest_category_order");
});

test("files are named and ordered by partition index, with one file per partition", () => {
  expect(referenceDataPartitionName(0)).toBe("part-00000.parquet");
  expect(referenceDataPartitionName(42)).toBe("part-00042.parquet");
  expect(referenceDataPartitionIndex("part-00042.parquet")).toBe(42);
  expect(referenceDataPartitionIndex("manifest.json")).toBeUndefined();
  expect(referenceDataPartitionIndex("part-42.parquet")).toBeUndefined();
  const renamed = manifest();
  renamed.files = [{ ...(GOLDEN.files as Array<Record<string, unknown>>)[0], name: "part-00001.parquet" }];
  expect(refused(renamed)).toBe("manifest_file_order");
  const extra = manifest();
  extra.files = [...(GOLDEN.files as unknown[]), { name: "part-00001.parquet", digest: `sha256:${"0".repeat(64)}`, encodedBytes: 1 }];
  expect(refused(extra)).toBe("manifest_file_order");
});

test("the declared schema is exactly C10's three required columns", () => {
  const renamed = manifest();
  renamed.schema = [{ name: "id", physicalType: "BYTE_ARRAY", logicalType: "STRING", repetition: "REQUIRED" }, ...(GOLDEN.schema as unknown[]).slice(1)];
  expect(refused(renamed)).toBe("manifest_schema");
  const nullable = manifest();
  nullable.schema = (GOLDEN.schema as Array<Record<string, unknown>>).map(field => ({ ...field, repetition: "OPTIONAL" }));
  expect(refused(nullable)).toBe("manifest_schema");
  expect(refused(manifest({ schema: [] }))).toBe("manifest_schema");
  expect(refused(manifest({ schema: "three columns" }))).toBe("manifest_schema");
  const malformed = manifest();
  malformed.schema = [null, ...(GOLDEN.schema as unknown[]).slice(1)];
  expect(refused(malformed)).toBe("manifest_schema");
});

test("anything outside the declared shape is refused rather than read past", () => {
  expect(refused(null)).toBe("manifest_shape");
  expect(refused([])).toBe("manifest_shape");
  expect(refused("{}")).toBe("manifest_shape");
  const extra = manifest();
  extra.extra = true;
  expect(refused(extra)).toBe("manifest_shape");
  const { writerSettings: _dropped, ...missing } = manifest();
  expect(refused(missing)).toBe("manifest_shape");
  expect(refused(manifest({ schemaVersion: "factory.reference-data-manifest.v2" }))).toBe("manifest_schema_version");
  expect(refused(manifest({ source: { digest: "nope", totalBytes: 1 } }))).toBe("manifest_shape");
  expect(refused(manifest({ source: { digest: (GOLDEN.source as Record<string, unknown>).digest, totalBytes: -1 } }))).toBe("manifest_shape");
  expect(refused(manifest({ source: 5 }))).toBe("manifest_shape");
  expect(refused(manifest({ rowCount: 1.5 }))).toBe("manifest_shape");
  expect(refused(manifest({ categories: [] }))).toBe("manifest_shape");
  expect(refused(manifest({ categories: [{ category: "alpha", count: 2 }] }))).toBe("manifest_shape");
  expect(refused(manifest({ categories: [{ category: "", count: 2, sumCents: "150" }] }))).toBe("manifest_shape");
  expect(refused(manifest({ files: [] }))).toBe("manifest_shape");
  expect(refused(manifest({ files: [{ name: "part-00000.parquet", digest: "nope", encodedBytes: 1 }] }))).toBe("manifest_shape");
  expect(refused(manifest({ files: "one" }))).toBe("manifest_shape");
  expect(refused(manifest({ writerSettings: [] }))).toBe("manifest_shape");
});
