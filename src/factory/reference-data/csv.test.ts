import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseReferenceDataAmount,
  parseReferenceDataLine,
  readReferenceDataSource,
  REFERENCE_DATA_HEADER,
  REFERENCE_DATA_LIMITS,
  referenceDataPartitions,
  ReferenceDataParseError,
  type ReferenceDataPartition,
  type ReferenceDataRow,
} from "./csv";

/**
 * The strict grammar, case by case.
 *
 * Every refusal asserts its exact code. "It threw" is not evidence that the
 * grammar refused for the reason C10 states, and every one of these codes is a
 * distinct kind of silent coercion that C10 forbids.
 */

const GOLDEN = `${REFERENCE_DATA_HEADER}\na,alpha,100\nb,beta,250\nc,alpha,50\n`;
const MAX = REFERENCE_DATA_LIMITS.maxAmountCents;

async function* bytes(text: string, split = text.length): AsyncGenerator<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  for (let at = 0; at < encoded.byteLength; at += split) yield encoded.subarray(at, at + split);
}

async function* raw(...blocks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const block of blocks) yield block;
}

async function read(text: string, split?: number): Promise<{ rows: ReferenceDataRow[]; summary: Awaited<ReturnType<typeof readReferenceDataSource>> }> {
  const rows: ReferenceDataRow[] = [];
  const summary = await readReferenceDataSource(bytes(text, split), row => rows.push(row));
  return { rows, summary };
}

async function refusal(source: AsyncIterable<Uint8Array>): Promise<ReferenceDataParseError> {
  try {
    await readReferenceDataSource(source);
  } catch (error) {
    if (error instanceof ReferenceDataParseError) return error;
    throw error;
  }
  throw new Error("the grammar accepted an input it must refuse");
}

test("the golden three-row input yields C10's exact expected accounting", async () => {
  const { rows, summary } = await read(GOLDEN);
  expect(rows.map(row => row.recordId)).toEqual(["a", "b", "c"]);
  expect(rows.map(row => row.index)).toEqual([0, 1, 2]);
  expect(summary.rowCount).toBe(3);
  expect(summary.totalAmountCents).toBe(400n);
  expect(summary.partitionCount).toBe(1);
  expect(summary.totalBytes).toBe(66);
  expect([...summary.categories].map(([name, total]) => [name, total.count, total.sumCents])).toEqual([
    ["alpha", 2, 150n],
    ["beta", 1, 250n],
  ]);
});

test("a chunk boundary inside a row, a field, and a multi-byte character changes nothing", async () => {
  const unicode = `${REFERENCE_DATA_HEADER}\na,café,100\nb,\u{1f600}beta,250\n`;
  for (const split of [1, 2, 3, 7, 11, 64]) {
    const { rows } = await read(unicode, split);
    expect(rows.map(row => `${row.recordId}/${row.category}/${row.amountCents}`)).toEqual(["a/café/100", "b/\u{1f600}beta/250"]);
  }
});

test("the whole declared amount domain is carried exactly, and one past it is refused", async () => {
  const { rows } = await read(`${REFERENCE_DATA_HEADER}\nzero,alpha,0\nbig,beta,${MAX}\n`);
  expect(rows.map(row => row.amountCents)).toEqual([0n, MAX]);
  expect(MAX).toBe(9_223_372_036_854_775_807n);
  expect((await refusal(bytes(`${REFERENCE_DATA_HEADER}\na,alpha,${MAX + 1n}\n`))).code).toBe("amount_overflow");
});

test("a total that leaves the signed-64-bit domain is still exact, because the sum is a bigint", async () => {
  const { summary } = await read(`${REFERENCE_DATA_HEADER}\na,alpha,${MAX}\nb,alpha,${MAX}\n`);
  expect(summary.totalAmountCents).toBe(MAX * 2n);
  expect(summary.categories.get("alpha")?.sumCents).toBe(MAX * 2n);
});

test("every amount shape BigInt would have silently accepted is refused by name", async () => {
  for (const [field, code] of [
    ["", "amount_empty"],
    ["007", "amount_leading_zero"],
    ["00", "amount_leading_zero"],
    ["+5", "amount_charset"],
    ["-1", "amount_charset"],
    [" 5", "amount_charset"],
    ["5 ", "amount_charset"],
    ["5.0", "amount_charset"],
    ["1e3", "amount_charset"],
    ["0x10", "amount_charset"],
    ["٥", "amount_charset"],
  ] as const) {
    expect(() => parseReferenceDataAmount(field, 2)).toThrow(ReferenceDataParseError);
    try {
      parseReferenceDataAmount(field, 2);
    } catch (error) {
      expect((error as ReferenceDataParseError).code).toBe(code);
      expect((error as ReferenceDataParseError).line).toBe(2);
    }
  }
});

test("a line is exactly three fields, both identifiers are nonempty, and both are bounded in bytes", () => {
  const row = parseReferenceDataLine("a,alpha,7", 4, 9);
  expect([row.index, row.recordId, row.category, row.amountCents]).toEqual([4, "a", "alpha", 7n]);
  const wide = "\u{1f600}".repeat(REFERENCE_DATA_LIMITS.maxRecordIdBytes / 4);
  expect(parseReferenceDataLine(`${wide},alpha,1`, 0, 2).recordId).toBe(wide);
  for (const [text, code] of [
    ["", "row_blank_line"],
    ["a,alpha", "row_field_count"],
    ["a", "row_field_count"],
    ["a,alpha,1,extra", "row_field_count"],
    [",alpha,1", "record_id_empty"],
    ["a,,1", "category_empty"],
    [`${"x".repeat(REFERENCE_DATA_LIMITS.maxRecordIdBytes + 1)},alpha,1`, "record_id_bytes"],
    [`${wide}\u{1f600},alpha,1`, "record_id_bytes"],
    [`a,${"y".repeat(REFERENCE_DATA_LIMITS.maxCategoryBytes + 1)},1`, "category_bytes"],
  ] as const) {
    try {
      parseReferenceDataLine(text, 0, 2);
      throw new Error(`the grammar accepted ${text}`);
    } catch (error) {
      expect((error as ReferenceDataParseError).code).toBe(code);
    }
  }
});

test("every structural refusal names its reason and its one-based source line", async () => {
  for (const [text, code, line] of [
    ["", "header_missing", 1],
    ["\n", "header_mismatch", 1],
    ["record_id,category,amount\na,alpha,1\n", "header_mismatch", 1],
    [`${REFERENCE_DATA_HEADER}\n`, "row_empty", 1],
    [`${REFERENCE_DATA_HEADER}\r\na,alpha,1\r\n`, "row_carriage_return", 1],
    [`${REFERENCE_DATA_HEADER}\na,alpha,1\n\nb,beta,2\n`, "row_blank_line", 3],
    [`${REFERENCE_DATA_HEADER}\na,alpha,1\na,beta,2\n`, "record_id_duplicate", 3],
  ] as const) {
    const error = await refusal(bytes(text));
    expect([text.slice(0, 12), error.code, error.line]).toEqual([text.slice(0, 12), code, line]);
  }
});

test("bytes that are not UTF-8 are refused rather than replaced", async () => {
  const head = new TextEncoder().encode(`${REFERENCE_DATA_HEADER}\na,`);
  const tail = new TextEncoder().encode(",1\n");
  expect((await refusal(raw(head, new Uint8Array([0xff, 0xfe]), tail))).code).toBe("encoding_invalid");
  // A truncated multi-byte sequence at end of input is refused too, not flushed
  // as a replacement character.
  expect((await refusal(raw(new TextEncoder().encode(`${REFERENCE_DATA_HEADER}\na,alpha,1\nb,`), new Uint8Array([0xe2, 0x82])))).code).toBe("encoding_invalid");
});

test("an input that does not end with a newline still holds a complete last row", async () => {
  const { rows, summary } = await read(GOLDEN.slice(0, -1));
  expect(rows).toHaveLength(3);
  expect(summary.rowCount).toBe(3);
});

test("partitions are cut at ten thousand rows, in order, each one a valid input on its own", async () => {
  const body = Array.from({ length: 25_000 }, (_, index) => `id${index},c${index % 3},${index}`).join("\n");
  const produced: ReferenceDataPartition[] = [];
  const generator = referenceDataPartitions(bytes(`${REFERENCE_DATA_HEADER}\n${body}\n`));
  let step = await generator.next();
  while (!step.done) {
    produced.push(step.value);
    step = await generator.next();
  }
  expect(produced.map(partition => partition.rowCount)).toEqual([10_000, 10_000, 5_000]);
  expect(produced.map(partition => partition.index)).toEqual([0, 1, 2]);
  expect(produced.map(partition => partition.firstRowIndex)).toEqual([0, 10_000, 20_000]);
  expect(step.value.partitionCount).toBe(3);
  expect(step.value.rowCount).toBe(25_000);
  for (const partition of produced) {
    expect(partition.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const text = new TextDecoder().decode(partition.bytes);
    expect(text.startsWith(`${REFERENCE_DATA_HEADER}\n`)).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    // Re-reading one partition through the same grammar yields its own rows,
    // which is what lets the transform run with no view of the whole file.
    const reread = await readReferenceDataSource(bytes(text));
    expect(reread.rowCount).toBe(partition.rowCount);
  }
});

test("the byte bound and the row bound are refusals, not clamps", async () => {
  const encoder = new TextEncoder();
  const oversized = new Uint8Array(REFERENCE_DATA_LIMITS.maxBytes + 1);
  oversized.set(encoder.encode(`${REFERENCE_DATA_HEADER}\n`), 0);
  expect((await refusal(raw(oversized))).code).toBe("byte_limit");
  // The row bound needs one row past a million, which is proved against the
  // same guard by exhausting it with the real constant rather than a fixture
  // of that size: the partitioner refuses at the row that crosses it.
  const rows = [`${REFERENCE_DATA_HEADER}`];
  for (let index = 0; index <= REFERENCE_DATA_LIMITS.maxRows; index += 1) rows.push(`id${index},alpha,1`);
  const error = await refusal(bytes(`${rows.join("\n")}\n`));
  expect(error.code).toBe("row_limit");
  expect(error.line).toBe(REFERENCE_DATA_LIMITS.maxRows + 2);
}, 300_000);

test("every committed grammar vector gets the verdict the Python guest also gives it", async () => {
  const document = JSON.parse(await readFile(join(import.meta.dir, "fixtures/grammar.json"), "utf8")) as {
    partitions: Array<{ name: string; csv: string; accepts: boolean; recordIds: string[]; amounts: string[]; code: string }>;
  };
  expect(document.partitions.length).toBeGreaterThan(20);
  for (const vector of document.partitions) {
    if (vector.accepts) {
      const { rows } = await read(vector.csv);
      expect([vector.name, rows.map(row => row.recordId)]).toEqual([vector.name, vector.recordIds]);
      expect([vector.name, rows.map(row => String(row.amountCents))]).toEqual([vector.name, vector.amounts]);
    } else {
      expect([vector.name, (await refusal(bytes(vector.csv))).code]).toEqual([vector.name, vector.code]);
    }
  }
});
