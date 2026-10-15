import { THRIFT_TYPE, ThriftReader, ThriftReadError } from "./thrift";

/**
 * An independent reader for exactly the Parquet the pinned transform writes.
 *
 * C10 requires a separate validator to recompute every claim "from the
 * snapshotted input and exported Parquet, not the transform's self-reported
 * counters". A validator that decodes the export with the same library that
 * encoded it cannot do that: a serialisation defect would agree with itself.
 * This reader shares no code with PyArrow, so the two only agree when the
 * bytes really do carry the rows.
 *
 * It is strict by design. C10 pins the serialisation settings, so anything
 * outside them - a dictionary page, a compression codec, a nullable column, a
 * v2 data page - is refused by name instead of decoded. That is the difference
 * between "the export reconciles" and "some Parquet reader could open it".
 */

/** Parquet physical types, as the `Type` enum orders them. */
const PHYSICAL = Object.freeze(["BOOLEAN", "INT32", "INT64", "INT96", "FLOAT", "DOUBLE", "BYTE_ARRAY", "FIXED_LEN_BYTE_ARRAY"] as const);
/** `FieldRepetitionType`. */
const REPETITION = Object.freeze(["REQUIRED", "OPTIONAL", "REPEATED"] as const);
/** `PageType`. */
const PAGE_DATA_V1 = 0;
const PAGE_DICTIONARY = 2;
const PAGE_DATA_V2 = 3;
/** `Encoding.PLAIN`. */
const ENCODING_PLAIN = 0;
/** `Encoding.RLE`. A required column has a maximum level of zero, so the writer still names RLE for levels it never emits. */
const ENCODING_RLE = 3;
/** `CompressionCodec.UNCOMPRESSED`. */
const CODEC_UNCOMPRESSED = 0;
/** `ConvertedType.UTF8`. */
const CONVERTED_UTF8 = 0;
/** `LogicalType` union field 1 is `StringType`. */
const LOGICAL_STRING_FIELD = 1;

const MAGIC = Object.freeze([0x50, 0x41, 0x52, 0x31]);
const FOOTER_LENGTH_BYTES = 4;

export type ReferenceDataParquetIssueCode =
  | "parquet_magic"
  | "parquet_truncated"
  | "parquet_footer"
  | "parquet_schema"
  | "parquet_repetition"
  | "parquet_codec"
  | "parquet_encoding"
  | "parquet_dictionary"
  | "parquet_page_version"
  | "parquet_page_type"
  | "parquet_row_count"
  | "parquet_value_bytes"
  | "parquet_value_encoding";

export class ReferenceDataParquetError extends Error {
  constructor(
    readonly code: ReferenceDataParquetIssueCode,
    message: string,
  ) {
    super(message);
    this.name = "ReferenceDataParquetError";
  }
}

function refuse(code: ReferenceDataParquetIssueCode, message: string): never {
  throw new ReferenceDataParquetError(code, message);
}

/** One leaf column of the export, as the file itself declares it. */
export interface ReferenceDataParquetField {
  readonly name: string;
  readonly physicalType: (typeof PHYSICAL)[number];
  readonly repetition: (typeof REPETITION)[number];
  /** `"STRING"` when the file marks the column UTF-8, `"NONE"` otherwise. */
  readonly logicalType: "STRING" | "NONE";
}

/** The exact schema C10 declares for `reference.data.v1`, in column order. */
export const REFERENCE_DATA_PARQUET_SCHEMA: readonly ReferenceDataParquetField[] = Object.freeze([
  Object.freeze({ name: "record_id", physicalType: "BYTE_ARRAY", repetition: "REQUIRED", logicalType: "STRING" } as const),
  Object.freeze({ name: "category", physicalType: "BYTE_ARRAY", repetition: "REQUIRED", logicalType: "STRING" } as const),
  Object.freeze({ name: "amount_cents", physicalType: "INT64", repetition: "REQUIRED", logicalType: "NONE" } as const),
]);

/** One decoded row, in file order. `amountCents` stays a `bigint` for the whole signed-64-bit domain. */
export interface ReferenceDataParquetRow {
  readonly recordId: string;
  readonly category: string;
  readonly amountCents: bigint;
}

export interface ReferenceDataParquetFile {
  readonly schema: readonly ReferenceDataParquetField[];
  /** The row count the footer declares. It is checked against the rows actually decoded. */
  readonly rowCount: number;
  readonly rowGroupCount: number;
  readonly rows: readonly ReferenceDataParquetRow[];
  /** Whatever the writer recorded about itself, for the receipt. */
  readonly createdBy: string | undefined;
}

interface ColumnChunk {
  readonly path: readonly string[];
  readonly physicalType: number;
  readonly codec: number;
  readonly numValues: number;
  readonly dataPageOffset: number;
  readonly dictionaryPageOffset: number | undefined;
  readonly totalCompressedSize: number;
}

interface SchemaElement {
  readonly name: string;
  readonly type: number | undefined;
  readonly repetition: number | undefined;
  readonly numChildren: number;
  readonly convertedType: number | undefined;
  readonly logicalStringType: boolean;
}

function readSchemaElement(reader: ThriftReader): SchemaElement {
  let name = "";
  let type: number | undefined;
  let repetition: number | undefined;
  let numChildren = 0;
  let convertedType: number | undefined;
  let logicalStringType = false;
  reader.enter();
  for (let field = reader.readField(); field.type !== THRIFT_TYPE.stop; field = reader.readField()) {
    if (field.id === 1) type = reader.number();
    else if (field.id === 3) repetition = reader.number();
    else if (field.id === 4) name = reader.text();
    else if (field.id === 5) numChildren = reader.number();
    else if (field.id === 6) convertedType = reader.number();
    else if (field.id === 10) {
      reader.enter();
      const chosen = reader.readField();
      logicalStringType = chosen.id === LOGICAL_STRING_FIELD;
      if (chosen.type !== THRIFT_TYPE.stop) {
        reader.skip(chosen.type);
        for (let extra = reader.readField(); extra.type !== THRIFT_TYPE.stop; extra = reader.readField()) reader.skip(extra.type);
      }
      reader.leave();
    } else reader.skip(field.type);
  }
  reader.leave();
  return { name, type, repetition, numChildren, convertedType, logicalStringType };
}

function readColumnMetaData(reader: ThriftReader): ColumnChunk {
  let physicalType = -1;
  let codec = -1;
  let numValues = 0;
  let dataPageOffset = -1;
  let dictionaryPageOffset: number | undefined;
  let totalCompressedSize = 0;
  let path: string[] = [];
  const encodings: number[] = [];
  reader.enter();
  for (let field = reader.readField(); field.type !== THRIFT_TYPE.stop; field = reader.readField()) {
    if (field.id === 1) physicalType = reader.number();
    else if (field.id === 2) {
      const header = reader.listHeader();
      for (let index = 0; index < header.size; index += 1) encodings.push(reader.number());
    } else if (field.id === 3) {
      const header = reader.listHeader();
      path = [];
      for (let index = 0; index < header.size; index += 1) path.push(reader.text());
    } else if (field.id === 4) codec = reader.number();
    else if (field.id === 5) numValues = Number(reader.zigzag());
    else if (field.id === 7) totalCompressedSize = Number(reader.zigzag());
    else if (field.id === 9) dataPageOffset = Number(reader.zigzag());
    else if (field.id === 11) dictionaryPageOffset = Number(reader.zigzag());
    else reader.skip(field.type);
  }
  reader.leave();
  // A chunk names RLE for the definition and repetition levels even when every
  // column is REQUIRED and no level is written, so RLE alone is not a value
  // encoding. Any other member means a dictionary or a delta encoding the
  // pinned settings disable.
  for (const encoding of encodings) if (encoding !== ENCODING_PLAIN && encoding !== ENCODING_RLE) refuse("parquet_encoding", `Column ${path.join(".")} declares encoding ${encoding}; the pinned settings write PLAIN values only.`);
  return { path, physicalType, codec, numValues, dataPageOffset, dictionaryPageOffset, totalCompressedSize };
}

function readColumnChunk(reader: ThriftReader): ColumnChunk {
  let chunk: ColumnChunk | undefined;
  reader.enter();
  for (let field = reader.readField(); field.type !== THRIFT_TYPE.stop; field = reader.readField()) {
    if (field.id === 3) chunk = readColumnMetaData(reader);
    else reader.skip(field.type);
  }
  reader.leave();
  if (!chunk) refuse("parquet_footer", "A column chunk carries no inline metadata; an external metadata file is outside the pinned settings.");
  return chunk;
}

interface RowGroup {
  readonly columns: readonly ColumnChunk[];
  readonly numRows: number;
}

function readRowGroup(reader: ThriftReader): RowGroup {
  const columns: ColumnChunk[] = [];
  let numRows = 0;
  reader.enter();
  for (let field = reader.readField(); field.type !== THRIFT_TYPE.stop; field = reader.readField()) {
    if (field.id === 1) {
      const header = reader.listHeader();
      for (let index = 0; index < header.size; index += 1) columns.push(readColumnChunk(reader));
    } else if (field.id === 3) numRows = Number(reader.zigzag());
    else reader.skip(field.type);
  }
  reader.leave();
  return { columns, numRows };
}

interface FileMetaData {
  readonly schema: readonly SchemaElement[];
  readonly numRows: number;
  readonly rowGroups: readonly RowGroup[];
  readonly createdBy: string | undefined;
}

function readFileMetaData(reader: ThriftReader): FileMetaData {
  const schema: SchemaElement[] = [];
  const rowGroups: RowGroup[] = [];
  let numRows = 0;
  let createdBy: string | undefined;
  reader.enter();
  for (let field = reader.readField(); field.type !== THRIFT_TYPE.stop; field = reader.readField()) {
    if (field.id === 2) {
      const header = reader.listHeader();
      for (let index = 0; index < header.size; index += 1) schema.push(readSchemaElement(reader));
    } else if (field.id === 3) numRows = Number(reader.zigzag());
    else if (field.id === 4) {
      const header = reader.listHeader();
      for (let index = 0; index < header.size; index += 1) rowGroups.push(readRowGroup(reader));
    } else if (field.id === 6) createdBy = reader.text();
    else reader.skip(field.type);
  }
  reader.leave();
  return { schema, numRows, rowGroups, createdBy };
}

interface PageHeader {
  readonly type: number;
  readonly uncompressedSize: number;
  readonly compressedSize: number;
  readonly numValues: number;
  readonly encoding: number;
}

function readPageHeader(reader: ThriftReader): PageHeader {
  let type = -1;
  let uncompressedSize = 0;
  let compressedSize = 0;
  let numValues = 0;
  let encoding = -1;
  reader.enter();
  for (let field = reader.readField(); field.type !== THRIFT_TYPE.stop; field = reader.readField()) {
    if (field.id === 1) type = reader.number();
    else if (field.id === 2) uncompressedSize = reader.number();
    else if (field.id === 3) compressedSize = reader.number();
    else if (field.id === 5) {
      reader.enter();
      for (let inner = reader.readField(); inner.type !== THRIFT_TYPE.stop; inner = reader.readField()) {
        if (inner.id === 1) numValues = reader.number();
        else if (inner.id === 2) encoding = reader.number();
        else reader.skip(inner.type);
      }
      reader.leave();
    } else reader.skip(field.type);
  }
  reader.leave();
  return { type, uncompressedSize, compressedSize, numValues, encoding };
}

/** PLAIN BYTE_ARRAY: a four-byte little-endian length, then that many bytes, repeated. */
function decodeByteArrays(page: Uint8Array, count: number, column: string): string[] {
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const values: string[] = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + 4 > page.byteLength) refuse("parquet_value_bytes", `Column ${column} ends inside a PLAIN length prefix.`);
    const length = view.getUint32(at, true);
    at += 4;
    if (at + length > page.byteLength) refuse("parquet_value_bytes", `Column ${column} declares a value longer than its page.`);
    try {
      values.push(decoder.decode(page.subarray(at, at + length)));
    } catch {
      refuse("parquet_value_encoding", `Column ${column} holds a value that is not valid UTF-8.`);
    }
    at += length;
  }
  if (at !== page.byteLength) refuse("parquet_value_bytes", `Column ${column} leaves ${page.byteLength - at} unread byte(s) in a data page.`);
  return values;
}

/** PLAIN INT64: eight little-endian bytes per value. */
function decodeInt64s(page: Uint8Array, count: number, column: string): bigint[] {
  if (page.byteLength !== count * 8) refuse("parquet_value_bytes", `Column ${column} holds ${page.byteLength} byte(s) for ${count} INT64 value(s).`);
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
  const values: bigint[] = [];
  for (let index = 0; index < count; index += 1) values.push(view.getBigInt64(index * 8, true));
  return values;
}

/**
 * Reads every value of one column chunk, page by page.
 *
 * Every column in the pinned schema is `REQUIRED` at the root, so its maximum
 * definition and repetition levels are zero and Parquet writes no level data:
 * a v1 data page is exactly its values. A file that needs levels is refused
 * above, at the repetition check, rather than mis-decoded here.
 */
function readColumnValues(bytes: Uint8Array, chunk: ColumnChunk): (string | bigint)[] {
  const column = chunk.path.join(".");
  if (chunk.codec !== CODEC_UNCOMPRESSED) refuse("parquet_codec", `Column ${column} declares compression codec ${chunk.codec}; the pinned settings write uncompressed pages.`);
  if (chunk.dictionaryPageOffset !== undefined) refuse("parquet_dictionary", `Column ${column} declares a dictionary page; the pinned settings disable dictionaries.`);
  const reader = new ThriftReader(bytes);
  const values: (string | bigint)[] = [];
  let at = chunk.dataPageOffset;
  const end = chunk.dataPageOffset + chunk.totalCompressedSize;
  if (at < 0 || end > bytes.byteLength) refuse("parquet_truncated", `Column ${column} points outside the file.`);
  while (values.length < chunk.numValues) {
    if (at >= end) refuse("parquet_truncated", `Column ${column} ran out of pages after ${values.length} of ${chunk.numValues} value(s).`);
    reader.seek(at);
    const header = readPageHeader(reader);
    const body = reader.offset;
    if (header.type === PAGE_DICTIONARY) refuse("parquet_dictionary", `Column ${column} holds a dictionary page.`);
    if (header.type === PAGE_DATA_V2) refuse("parquet_page_version", `Column ${column} holds a v2 data page; the pinned settings write v1.`);
    if (header.type !== PAGE_DATA_V1) refuse("parquet_page_type", `Column ${column} holds page type ${header.type}.`);
    if (header.encoding !== ENCODING_PLAIN) refuse("parquet_encoding", `Column ${column} holds a page encoded ${header.encoding}; the pinned settings write PLAIN.`);
    if (header.compressedSize !== header.uncompressedSize) refuse("parquet_codec", `Column ${column} holds a page whose compressed and uncompressed sizes differ.`);
    if (body + header.compressedSize > bytes.byteLength) refuse("parquet_truncated", `Column ${column} holds a page that ends past the file.`);
    const page = bytes.subarray(body, body + header.compressedSize);
    const remaining = chunk.numValues - values.length;
    if (header.numValues > remaining) refuse("parquet_row_count", `Column ${column} holds a page with more values than the chunk declares.`);
    if (chunk.physicalType === PHYSICAL.indexOf("BYTE_ARRAY")) values.push(...decodeByteArrays(page, header.numValues, column));
    else values.push(...decodeInt64s(page, header.numValues, column));
    at = body + header.compressedSize;
  }
  if (values.length !== chunk.numValues) refuse("parquet_row_count", `Column ${column} decoded ${values.length} value(s) against a declared ${chunk.numValues}.`);
  return values;
}

function describe(element: SchemaElement): ReferenceDataParquetField {
  const physical = element.type === undefined ? undefined : PHYSICAL[element.type];
  const repetition = element.repetition === undefined ? undefined : REPETITION[element.repetition];
  if (!physical || !repetition) refuse("parquet_schema", `Column ${element.name} does not declare a leaf physical type and repetition.`);
  return Object.freeze({
    name: element.name,
    physicalType: physical,
    repetition,
    logicalType: element.logicalStringType || element.convertedType === CONVERTED_UTF8 ? "STRING" : "NONE",
  });
}

/**
 * Decodes one exported Parquet file into its schema and its rows, in file
 * order. The order matters: C10 requires the export to hold "exactly the
 * validated input rows, in input order", so the reconciliation compares
 * position by position, never as sets.
 */
export function readReferenceDataParquet(bytes: Uint8Array): ReferenceDataParquetFile {
  try {
    return decode(bytes);
  } catch (error) {
    if (error instanceof ThriftReadError) refuse("parquet_footer", `The Parquet footer is not readable: ${error.message}`);
    throw error;
  }
}

function decode(bytes: Uint8Array): ReferenceDataParquetFile {
  if (bytes.byteLength < MAGIC.length * 2 + FOOTER_LENGTH_BYTES) refuse("parquet_truncated", "The file is shorter than an empty Parquet file.");
  for (const [index, byte] of MAGIC.entries()) {
    if (bytes[index] !== byte) refuse("parquet_magic", "The file does not begin with the Parquet magic.");
    if (bytes[bytes.byteLength - MAGIC.length + index] !== byte) refuse("parquet_magic", "The file does not end with the Parquet magic.");
  }
  const lengthAt = bytes.byteLength - MAGIC.length - FOOTER_LENGTH_BYTES;
  const footerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(lengthAt, true);
  if (footerLength > lengthAt - MAGIC.length) refuse("parquet_footer", "The declared footer length does not fit the file.");
  const reader = new ThriftReader(bytes);
  reader.seek(lengthAt - footerLength);
  const metadata = readFileMetaData(reader);

  const [root, ...leaves] = metadata.schema;
  if (!root || root.numChildren !== leaves.length || leaves.length !== REFERENCE_DATA_PARQUET_SCHEMA.length) {
    refuse("parquet_schema", `The export declares ${Math.max(metadata.schema.length - 1, 0)} column(s) against the declared ${REFERENCE_DATA_PARQUET_SCHEMA.length}.`);
  }
  const schema = leaves.map(describe);
  for (const [index, declared] of REFERENCE_DATA_PARQUET_SCHEMA.entries()) {
    const actual = schema[index] as ReferenceDataParquetField;
    if (actual.name !== declared.name || actual.physicalType !== declared.physicalType || actual.logicalType !== declared.logicalType) {
      refuse("parquet_schema", `Column ${index} is ${actual.name}:${actual.physicalType}/${actual.logicalType}, not ${declared.name}:${declared.physicalType}/${declared.logicalType}.`);
    }
    if (actual.repetition !== "REQUIRED") refuse("parquet_repetition", `Column ${actual.name} is ${actual.repetition}; every declared column is REQUIRED, so no row may hold a null.`);
  }

  const rows: ReferenceDataParquetRow[] = [];
  for (const group of metadata.rowGroups) {
    if (group.columns.length !== REFERENCE_DATA_PARQUET_SCHEMA.length) refuse("parquet_schema", `A row group holds ${group.columns.length} column chunk(s) against ${REFERENCE_DATA_PARQUET_SCHEMA.length} declared column(s).`);
    const decoded = group.columns.map(chunk => readColumnValues(bytes, chunk));
    for (const [index, chunk] of group.columns.entries()) {
      if (chunk.numValues !== group.numRows) refuse("parquet_row_count", `Column ${chunk.path.join(".")} holds ${chunk.numValues} value(s) in a row group of ${group.numRows} row(s).`);
      if ((chunk.path[0] ?? "") !== (REFERENCE_DATA_PARQUET_SCHEMA[index] as ReferenceDataParquetField).name) refuse("parquet_schema", `Row-group column ${index} is ${chunk.path.join(".")}, not ${(REFERENCE_DATA_PARQUET_SCHEMA[index] as ReferenceDataParquetField).name}.`);
    }
    const [ids, categories, amounts] = decoded as [string[], string[], bigint[]];
    for (let index = 0; index < group.numRows; index += 1) {
      rows.push(Object.freeze({ recordId: ids[index] as string, category: categories[index] as string, amountCents: amounts[index] as bigint }));
    }
  }
  if (rows.length !== metadata.numRows) refuse("parquet_row_count", `The footer declares ${metadata.numRows} row(s) and the pages hold ${rows.length}.`);
  return Object.freeze({ schema: Object.freeze(schema), rowCount: metadata.numRows, rowGroupCount: metadata.rowGroups.length, rows: Object.freeze(rows), createdBy: metadata.createdBy });
}
