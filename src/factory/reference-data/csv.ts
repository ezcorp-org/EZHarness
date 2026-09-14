import { digestBytes } from "../../extensions/v4/blobs";

/**
 * The pinned strict grammar of `reference.data.v1`'s immutable input.
 *
 * C10 fixes the header, the row bounds, and the value domain; everything else
 * here is the part of the grammar C10 leaves to the pack, written down once so
 * the Bun parser, the Python transform, and the independent reconciliation all
 * mean the same thing by "a valid row". Every bound is a refusal, never a
 * clamp: this module has no code path that drops a row, truncates a field, or
 * reinterprets a value.
 */
export const REFERENCE_DATA_LIMITS = Object.freeze({
  /** C10: at most one million rows. */
  maxRows: 1_000_000,
  /** C10: at most 256 MiB of input. */
  maxBytes: 256 * 1024 * 1024,
  /** C10: ordered partitions of ten thousand rows. */
  partitionRows: 10_000,
  /** `maxRows / partitionRows`, and the graph's `maxItems` on the map node. */
  maxPartitions: 100,
  /** Pack-chosen, so a duplicate index and a partition buffer are both bounded. */
  maxRecordIdBytes: 256,
  /** Pack-chosen, so the per-category map is bounded by the row bound. */
  maxCategoryBytes: 128,
  /** C10: the declared signed-64-bit domain, nonnegative half. */
  maxAmountCents: 2n ** 63n - 1n,
});

/** C10's exact header line. A file whose first line differs is refused whole. */
export const REFERENCE_DATA_HEADER = "record_id,category,amount_cents";

/** The media type the immutable snapshot and every partition carry. */
export const REFERENCE_DATA_CSV_MEDIA_TYPE = "text/csv";

/**
 * Every way the strict grammar refuses an input. The set is closed: a refusal
 * always names one of these, so a fixture can assert the exact reason rather
 * than "it threw".
 */
export type ReferenceDataIssueCode =
  | "encoding_invalid"
  | "header_missing"
  | "header_mismatch"
  | "byte_limit"
  | "row_limit"
  | "row_empty"
  | "row_blank_line"
  | "row_field_count"
  | "row_carriage_return"
  | "record_id_empty"
  | "record_id_bytes"
  | "record_id_duplicate"
  | "category_empty"
  | "category_bytes"
  | "amount_empty"
  | "amount_charset"
  | "amount_leading_zero"
  | "amount_overflow";

/**
 * A refusal. It carries the one-based source line so an operator can open the
 * immutable snapshot at the byte that caused it.
 */
export class ReferenceDataParseError extends Error {
  constructor(
    readonly code: ReferenceDataIssueCode,
    /** One-based line in the source, counting the header as line 1. `0` when no line is implicated. */
    readonly line: number,
    message: string,
  ) {
    super(message);
    this.name = "ReferenceDataParseError";
  }
}

/** One validated row. `amountCents` is a `bigint` because the domain exceeds `Number.MAX_SAFE_INTEGER`. */
export interface ReferenceDataRow {
  /** Zero-based position in the input, which is also the output order. */
  readonly index: number;
  readonly recordId: string;
  readonly category: string;
  readonly amountCents: bigint;
}

/** The exact accounting a category contributes. Counts are row counts; sums are exact integers. */
export interface ReferenceDataCategoryTotal {
  readonly count: number;
  readonly sumCents: bigint;
}

/**
 * Everything the immutable input says about itself, recomputed from its bytes.
 * The manifest is built from this and the reconciliation recomputes this again
 * from the same bytes, so no transform-reported number ever enters it.
 */
export interface ReferenceDataSourceSummary {
  readonly rowCount: number;
  readonly totalBytes: number;
  readonly partitionCount: number;
  readonly totalAmountCents: bigint;
  /** Insertion-ordered by first appearance, so the manifest is deterministic before sorting. */
  readonly categories: ReadonlyMap<string, ReferenceDataCategoryTotal>;
}

/**
 * One partition's exact, self-contained CSV bytes: C10's header followed by its
 * ten thousand rows (fewer only for the last partition). Every partition is a
 * valid input to the same parser, which is what lets the transform run in an
 * isolated guest with no knowledge of the whole file.
 */
export interface ReferenceDataPartition {
  readonly index: number;
  /** Zero-based index of this partition's first row in the whole input. */
  readonly firstRowIndex: number;
  readonly rowCount: number;
  readonly bytes: Uint8Array;
  /** `sha256:` over `bytes`. */
  readonly digest: string;
  readonly rows: readonly ReferenceDataRow[];
}

const AMOUNT = /^(?:0|[1-9][0-9]*)$/;
const COMMA = 0x2c;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

function refuse(code: ReferenceDataIssueCode, line: number, message: string): never {
  throw new ReferenceDataParseError(code, line, message);
}

/**
 * Reads one `amount_cents` field under the pinned grammar.
 *
 * `BigInt("٠")`, `BigInt(" 5")`, `BigInt("+5")` and `BigInt("")` all succeed in
 * ECMAScript, and every one of them would be a silent reinterpretation of the
 * source bytes, so the ASCII shape is checked before the conversion rather
 * than after it. A leading zero is refused for the same reason: two byte
 * sequences that denote one value would make "every row matches its source
 * value" ambiguous.
 */
export function parseReferenceDataAmount(field: string, line: number): bigint {
  if (field.length === 0) refuse("amount_empty", line, "amount_cents is empty");
  if (!AMOUNT.test(field)) {
    if (/^0[0-9]+$/.test(field)) refuse("amount_leading_zero", line, "amount_cents carries a leading zero");
    refuse("amount_charset", line, "amount_cents is not a nonnegative ASCII decimal integer");
  }
  const value = BigInt(field);
  if (value > REFERENCE_DATA_LIMITS.maxAmountCents) refuse("amount_overflow", line, "amount_cents leaves the declared signed-64-bit domain");
  return value;
}

/**
 * Reads one already-decoded data line. `line` is one-based over the whole
 * source. Duplicate detection belongs to the caller, because a partition read
 * in isolation cannot see the rest of the file.
 */
export function parseReferenceDataLine(text: string, index: number, line: number): ReferenceDataRow {
  if (text.length === 0) refuse("row_blank_line", line, "a blank line is not a row");
  const first = text.indexOf(",");
  const second = first === -1 ? -1 : text.indexOf(",", first + 1);
  if (first === -1 || second === -1 || text.indexOf(",", second + 1) !== -1) refuse("row_field_count", line, "a row must hold exactly three comma-separated fields");
  const recordId = text.slice(0, first);
  const category = text.slice(first + 1, second);
  const amount = text.slice(second + 1);
  if (recordId.length === 0) refuse("record_id_empty", line, "record_id is empty");
  if (Buffer.byteLength(recordId, "utf8") > REFERENCE_DATA_LIMITS.maxRecordIdBytes) refuse("record_id_bytes", line, "record_id exceeds its declared byte bound");
  if (category.length === 0) refuse("category_empty", line, "category is empty");
  if (Buffer.byteLength(category, "utf8") > REFERENCE_DATA_LIMITS.maxCategoryBytes) refuse("category_bytes", line, "category exceeds its declared byte bound");
  return Object.freeze({ index, recordId, category, amountCents: parseReferenceDataAmount(amount, line) });
}

/** Accumulates the exact accounting without ever holding a row it has already counted. */
class Totals {
  rowCount = 0;
  totalAmountCents = 0n;
  readonly categories = new Map<string, { count: number; sumCents: bigint }>();
  add(row: ReferenceDataRow): void {
    this.rowCount += 1;
    this.totalAmountCents += row.amountCents;
    const existing = this.categories.get(row.category);
    if (existing) {
      existing.count += 1;
      existing.sumCents += row.amountCents;
    } else this.categories.set(row.category, { count: 1, sumCents: row.amountCents });
  }
  summary(totalBytes: number, partitionCount: number): ReferenceDataSourceSummary {
    const categories = new Map<string, ReferenceDataCategoryTotal>();
    for (const [name, total] of this.categories) categories.set(name, Object.freeze({ count: total.count, sumCents: total.sumCents }));
    return Object.freeze({ rowCount: this.rowCount, totalBytes, partitionCount, totalAmountCents: this.totalAmountCents, categories });
  }
}

/**
 * Splits a byte stream into lines without ever decoding a partial code point.
 *
 * `TextDecoder` with `fatal: true` and `stream: true` is the only decoder here:
 * an invalid sequence is a refusal, never a replacement character, because a
 * replacement character is exactly the silent coercion C10 forbids. A carriage
 * return anywhere is refused rather than stripped, so one byte sequence denotes
 * one file.
 */
class LineReader {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private pending = "";
  private bytes = 0;
  private line = 0;

  feed(chunk: Uint8Array): string[] {
    this.bytes += chunk.byteLength;
    if (this.bytes > REFERENCE_DATA_LIMITS.maxBytes) refuse("byte_limit", this.line + 1, "input exceeds the declared 256 MiB bound");
    // `includes` is a native scan. Iterating the bytes in JavaScript is a
    // quarter of a billion interpreter steps at C10's 256 MiB bound.
    if (chunk.includes(CARRIAGE_RETURN)) refuse("row_carriage_return", this.line + 1, "a carriage return is not part of the pinned line grammar");
    let text: string;
    try {
      text = this.decoder.decode(chunk, { stream: true });
    } catch {
      refuse("encoding_invalid", this.line + 1, "input is not valid UTF-8");
    }
    return this.split(text);
  }

  finish(): string[] {
    let text: string;
    try {
      text = this.decoder.decode();
    } catch {
      refuse("encoding_invalid", this.line + 1, "input ends inside an incomplete UTF-8 sequence");
    }
    const lines = this.split(text);
    // A file that does not end with a newline still holds a complete last row;
    // a file that does leaves `pending` empty and adds nothing here.
    if (this.pending.length > 0) {
      lines.push(this.pending);
      this.pending = "";
      this.line += 1;
    }
    return lines;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  private split(text: string): string[] {
    const lines: string[] = [];
    let start = 0;
    const joined = this.pending + text;
    for (let at = joined.indexOf("\n"); at !== -1; at = joined.indexOf("\n", start)) {
      lines.push(joined.slice(start, at));
      this.line += 1;
      start = at + 1;
    }
    this.pending = joined.slice(start);
    return lines;
  }
}

const HEADER_BYTES = new TextEncoder().encode(`${REFERENCE_DATA_HEADER}\n`);

/** The exact bytes one partition carries: C10's header, then its rows, each LF terminated. */
function partitionBytes(lines: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = lines.map(line => encoder.encode(`${line}\n`));
  const total = HEADER_BYTES.byteLength + encoded.reduce((sum, line) => sum + line.byteLength, 0);
  const bytes = new Uint8Array(total);
  bytes.set(HEADER_BYTES, 0);
  let offset = HEADER_BYTES.byteLength;
  for (const line of encoded) {
    bytes.set(line, offset);
    offset += line.byteLength;
  }
  return bytes;
}

/**
 * Reads the immutable input once and yields its ordered partitions, returning
 * the exact accounting of everything it read.
 *
 * The generator holds at most one partition at a time, so a 256 MiB input is
 * read in `partitionRows`-sized working memory plus the duplicate index. The
 * first refusal ends the whole read: C10 forbids dropping a bad row and
 * continuing, so there is no "rejected rows" list to return.
 */
export async function* referenceDataPartitions(source: AsyncIterable<Uint8Array>): AsyncGenerator<ReferenceDataPartition, ReferenceDataSourceSummary> {
  const reader = new LineReader();
  const totals = new Totals();
  const seen = new Set<string>();
  let header = false;
  let rowIndex = 0;
  let partitionIndex = 0;
  let buffered: string[] = [];
  let bufferedRows: ReferenceDataRow[] = [];

  function consume(text: string, line: number): ReferenceDataPartition | undefined {
    if (!header) {
      if (text !== REFERENCE_DATA_HEADER) refuse("header_mismatch", line, "the first line is not the pinned header");
      header = true;
      return undefined;
    }
    if (rowIndex >= REFERENCE_DATA_LIMITS.maxRows) refuse("row_limit", line, "input exceeds the declared one-million-row bound");
    const row = parseReferenceDataLine(text, rowIndex, line);
    if (seen.has(row.recordId)) refuse("record_id_duplicate", line, "record_id repeats an earlier row");
    seen.add(row.recordId);
    totals.add(row);
    buffered.push(text);
    bufferedRows.push(row);
    rowIndex += 1;
    if (buffered.length < REFERENCE_DATA_LIMITS.partitionRows) return undefined;
    return seal();
  }

  function seal(): ReferenceDataPartition {
    const bytes = partitionBytes(buffered);
    const partition: ReferenceDataPartition = Object.freeze({
      index: partitionIndex,
      firstRowIndex: rowIndex - buffered.length,
      rowCount: buffered.length,
      bytes,
      digest: `sha256:${digestBytes(bytes)}`,
      rows: Object.freeze(bufferedRows),
    });
    partitionIndex += 1;
    buffered = [];
    bufferedRows = [];
    return partition;
  }

  let line = 0;
  for await (const chunk of source) {
    for (const text of reader.feed(chunk)) {
      line += 1;
      const partition = consume(text, line);
      if (partition) yield partition;
    }
  }
  for (const text of reader.finish()) {
    line += 1;
    const partition = consume(text, line);
    if (partition) yield partition;
  }
  if (!header) refuse("header_missing", 1, "input holds no header line");
  if (buffered.length > 0) yield seal();
  if (rowIndex === 0) refuse("row_empty", 1, "input holds a header and no rows");
  return totals.summary(reader.totalBytes, partitionIndex);
}

/**
 * The whole-input read, for callers that need the summary and not the bytes.
 * It exists so the reconciliation never writes a second reader that could
 * disagree with the partitioner about what the source says.
 */
export async function readReferenceDataSource(source: AsyncIterable<Uint8Array>, onRow?: (row: ReferenceDataRow) => void): Promise<ReferenceDataSourceSummary> {
  const partitions = referenceDataPartitions(source);
  for (;;) {
    const step = await partitions.next();
    if (step.done) return step.value;
    if (onRow) for (const row of step.value.rows) onRow(row);
  }
}
