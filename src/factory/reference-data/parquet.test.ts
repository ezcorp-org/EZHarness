import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readReferenceDataParquet, REFERENCE_DATA_PARQUET_SCHEMA, ReferenceDataParquetError, type ReferenceDataParquetIssueCode } from "./parquet";

/**
 * The independent Parquet reader, against bytes the pinned PyArrow writer
 * really produced.
 *
 * Every fixture in `fixtures/parquet` came out of
 * `src/factory/runner/python/refdata/parquet.py` through real PyArrow 25.0.1,
 * so these are the exported bytes and not a hand-built approximation of them.
 * That is the point: the reconciliation is only independent if this decoder
 * never touched the encoder.
 */

const FIXTURES = join(import.meta.dir, "fixtures/parquet");

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(FIXTURES, `${name}.parquet`)));
}

function refused(bytes: Uint8Array): ReferenceDataParquetIssueCode {
  try {
    readReferenceDataParquet(bytes);
  } catch (error) {
    if (error instanceof ReferenceDataParquetError) return error.code;
    throw error;
  }
  throw new Error("the reader accepted a file it must refuse");
}

test("the golden export decodes to C10's exact three rows, in input order", async () => {
  const file = readReferenceDataParquet(await fixture("golden"));
  expect(file.rowCount).toBe(3);
  expect(file.rowGroupCount).toBe(1);
  expect(file.createdBy).toContain("parquet-cpp-arrow");
  expect(file.rows.map(row => `${row.recordId}/${row.category}/${row.amountCents}`)).toEqual(["a/alpha/100", "b/beta/250", "c/alpha/50"]);
  expect(file.schema).toEqual(REFERENCE_DATA_PARQUET_SCHEMA);
});

test("the whole signed-64-bit domain survives the round trip exactly", async () => {
  const file = readReferenceDataParquet(await fixture("boundary"));
  expect(file.rows.map(row => row.amountCents)).toEqual([0n, 9_223_372_036_854_775_807n]);
});

test("a negative amount is decoded faithfully, so the reconciliation can refuse it", async () => {
  const file = readReferenceDataParquet(await fixture("negative-amount"));
  expect(file.rows.map(row => row.amountCents)).toEqual([100n, -1n]);
});

test("row groups are concatenated in file order, never merged as a set", async () => {
  const file = readReferenceDataParquet(await fixture("two-row-groups"));
  expect(file.rowGroupCount).toBe(2);
  expect(file.rows.map(row => row.recordId)).toEqual(["a", "b", "c", "d"]);
  expect(file.rows.map(row => row.amountCents)).toEqual([1n, 2n, 3n, 4n]);
});

test("a defect in the data decodes faithfully rather than being smoothed over", async () => {
  expect(readReferenceDataParquet(await fixture("changed-value")).rows[1]?.amountCents).toBe(251n);
  expect(readReferenceDataParquet(await fixture("dropped-row")).rows.map(row => row.recordId)).toEqual(["a", "c"]);
  expect(readReferenceDataParquet(await fixture("reordered")).rows.map(row => row.recordId)).toEqual(["b", "a", "c"]);
  expect(readReferenceDataParquet(await fixture("duplicate-id")).rows.map(row => row.recordId)).toEqual(["a", "a", "c"]);
  expect(readReferenceDataParquet(await fixture("changed-category")).rows[1]?.category).toBe("gamma");
});

test("every serialisation outside the pinned settings is refused by name", async () => {
  expect(refused(await fixture("nullable"))).toBe("parquet_repetition");
  expect(refused(await fixture("dictionary"))).toBe("parquet_encoding");
  expect(refused(await fixture("compressed"))).toBe("parquet_codec");
  expect(refused(await fixture("data-page-v2"))).toBe("parquet_page_version");
  expect(refused(await fixture("extra-column"))).toBe("parquet_schema");
  expect(refused(await fixture("narrow-amount"))).toBe("parquet_schema");
  expect(refused(await fixture("renamed-column"))).toBe("parquet_schema");
});

test("footer statistics are ignored, because the claim is about values and not bytes", async () => {
  // C10 says acceptance checks values and manifests "rather than assuming all
  // Parquet writers emit the same bytes". Extra footer metadata changes the
  // bytes and not one value, so it is read, not refused.
  const file = readReferenceDataParquet(await fixture("statistics"));
  expect(file.rows.map(row => row.recordId)).toEqual(["a", "b", "c"]);
});

test("a file that is not this format is refused before anything is decoded", async () => {
  const golden = await fixture("golden");
  expect(refused(new Uint8Array(4))).toBe("parquet_truncated");
  expect(refused(golden.subarray(0, golden.byteLength - 8))).toBe("parquet_magic");
  const badHead = new Uint8Array(golden);
  badHead[0] = 0x00;
  expect(refused(badHead)).toBe("parquet_magic");
  const badTail = new Uint8Array(golden);
  badTail[golden.byteLength - 1] = 0x00;
  expect(refused(badTail)).toBe("parquet_magic");
});

test("a footer length that does not fit the file is refused rather than seeking outside it", async () => {
  const golden = await fixture("golden");
  const oversized = new Uint8Array(golden);
  new DataView(oversized.buffer).setUint32(golden.byteLength - 8, 0xffff, true);
  expect(refused(oversized)).toBe("parquet_footer");
});

test("a corrupt footer ends as one refusal, never an out-of-range read", async () => {
  const golden = await fixture("golden");
  const length = new DataView(golden.buffer, golden.byteOffset, golden.byteLength).getUint32(golden.byteLength - 8, true);
  const start = golden.byteLength - 8 - length;
  const codes = new Set<string>();
  for (let offset = start; offset < golden.byteLength - 8; offset += 1) {
    const corrupt = new Uint8Array(golden);
    corrupt[offset] = (corrupt[offset] as number) ^ 0xff;
    try {
      readReferenceDataParquet(corrupt);
    } catch (error) {
      expect(error).toBeInstanceOf(ReferenceDataParquetError);
      codes.add((error as ReferenceDataParquetError).code);
    }
  }
  // Not every flipped bit changes a decoded value, but no flipped bit may
  // escape as a thrown range error or an unbounded read.
  expect(codes.size).toBeGreaterThan(0);
});

test("a page that claims more values than its chunk, or fewer bytes than its values, is refused", async () => {
  const golden = await fixture("golden");
  const codes = new Set<string>();
  // The column chunks sit between the magic and the footer; flipping bytes
  // there is how a truncated or mis-sized page reaches the decoder.
  const length = new DataView(golden.buffer, golden.byteOffset, golden.byteLength).getUint32(golden.byteLength - 8, true);
  for (let offset = 4; offset < golden.byteLength - 8 - length; offset += 1) {
    const corrupt = new Uint8Array(golden);
    corrupt[offset] = (corrupt[offset] as number) ^ 0xff;
    try {
      readReferenceDataParquet(corrupt);
    } catch (error) {
      expect(error).toBeInstanceOf(ReferenceDataParquetError);
      codes.add((error as ReferenceDataParquetError).code);
    }
  }
  expect(codes.has("parquet_value_bytes") || codes.has("parquet_value_encoding") || codes.has("parquet_row_count")).toBe(true);
});
