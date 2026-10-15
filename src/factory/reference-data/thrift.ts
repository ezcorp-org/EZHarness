/**
 * Just enough of the Thrift compact protocol to read a Parquet footer.
 *
 * The reconciliation validator must read the exported Parquet without the
 * library that wrote it, otherwise a transform that mis-serialises agrees with
 * itself and the protected claim proves nothing. Apache's compact protocol is
 * a published wire format, so reading it is a decoding job, not a guess.
 *
 * Every read is bounds-checked against the buffer and every varint is bounded
 * to its declared width, so a corrupt or hostile footer ends as one refusal
 * rather than an out-of-range read or an unbounded loop.
 *
 * Reference: Apache Thrift compact protocol specification.
 */

/** Compact-protocol field types, as they appear in a field header's low nibble. */
export const THRIFT_TYPE = Object.freeze({
  stop: 0x00,
  booleanTrue: 0x01,
  booleanFalse: 0x02,
  byte: 0x03,
  i16: 0x04,
  i32: 0x05,
  i64: 0x06,
  double: 0x07,
  binary: 0x08,
  list: 0x09,
  set: 0x0a,
  map: 0x0b,
  struct: 0x0c,
});

export class ThriftReadError extends Error {
  constructor(readonly code: "thrift_truncated" | "thrift_varint" | "thrift_type" | "thrift_depth" | "thrift_text", message: string) {
    super(message);
    this.name = "ThriftReadError";
  }
}

/** Bounds the recursion a nested skip may reach, so a cyclic-looking footer cannot exhaust the stack. */
const MAX_DEPTH = 32;

/** One field header: its id and its compact type. `type` is `stop` at the end of a struct. */
export interface ThriftField {
  readonly id: number;
  readonly type: number;
}

/**
 * A forward-only cursor over one buffer. It is deliberately not an iterator:
 * a Parquet footer is read by seeking between structures, and the caller owns
 * the position.
 */
export class ThriftReader {
  private at = 0;
  private readonly stack: number[] = [];
  private field = 0;
  /** Set by `readField` when it reads a boolean, whose value lives in the field header. */
  private booleanValue: boolean | undefined;

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.at;
  }

  seek(offset: number): void {
    if (offset < 0 || offset > this.bytes.byteLength) throw new ThriftReadError("thrift_truncated", "Thrift cursor left its buffer.");
    this.at = offset;
  }

  private take(count: number): Uint8Array {
    if (count < 0 || this.at + count > this.bytes.byteLength) throw new ThriftReadError("thrift_truncated", "Thrift buffer ended inside a value.");
    const slice = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return slice;
  }

  private byte(): number {
    if (this.at >= this.bytes.byteLength) throw new ThriftReadError("thrift_truncated", "Thrift buffer ended inside a header.");
    const value = this.bytes[this.at] as number;
    this.at += 1;
    return value;
  }

  /** An unsigned LEB128 varint, bounded to ten bytes so a run of continuation bits cannot loop. */
  varint(): bigint {
    let value = 0n;
    for (let shift = 0n, read = 0; read < 10; shift += 7n, read += 1) {
      const byte = this.byte();
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new ThriftReadError("thrift_varint", "Thrift varint exceeds its declared width.");
  }

  /** Zigzag decoding: the compact protocol writes every signed integer this way. */
  zigzag(): bigint {
    const raw = this.varint();
    return (raw >> 1n) ^ -(raw & 1n);
  }

  number(): number {
    const value = this.zigzag();
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new ThriftReadError("thrift_varint", "Thrift integer leaves the safe range.");
    return Number(value);
  }

  binary(): Uint8Array {
    const length = this.varint();
    if (length > BigInt(this.bytes.byteLength)) throw new ThriftReadError("thrift_truncated", "Thrift binary declares more bytes than the buffer holds.");
    return this.take(Number(length));
  }

  /**
   * A Thrift string field, decoded strictly.
   *
   * The failure is wrapped rather than allowed to escape: a corrupt footer
   * reaches this with arbitrary bytes, and `TextDecoder` raises a bare
   * `TypeError` that no caller could tell apart from a programming fault.
   */
  text(): string {
    const raw = this.binary();
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new ThriftReadError("thrift_text", "Thrift string field is not valid UTF-8.");
    }
  }

  /** Enters a struct. Field ids are deltas from the previous field, so the cursor tracks them. */
  enter(): void {
    if (this.stack.length >= MAX_DEPTH) throw new ThriftReadError("thrift_depth", "Thrift struct nesting exceeds its bound.");
    this.stack.push(this.field);
    this.field = 0;
  }

  leave(): void {
    this.field = this.stack.pop() ?? 0;
  }

  /** The next field header, or `type: stop` at the end of the current struct. */
  readField(): ThriftField {
    this.booleanValue = undefined;
    const header = this.byte();
    if (header === THRIFT_TYPE.stop) return { id: 0, type: THRIFT_TYPE.stop };
    const type = header & 0x0f;
    const delta = (header & 0xf0) >> 4;
    const id = delta === 0 ? Number(this.zigzag()) : this.field + delta;
    this.field = id;
    if (type === THRIFT_TYPE.booleanTrue) this.booleanValue = true;
    if (type === THRIFT_TYPE.booleanFalse) this.booleanValue = false;
    return { id, type };
  }

  /** The boolean the last field header carried. */
  boolean(): boolean {
    if (this.booleanValue === undefined) throw new ThriftReadError("thrift_type", "Thrift field is not a boolean.");
    return this.booleanValue;
  }

  /** A list header: its element count and element type. */
  listHeader(): { readonly size: number; readonly type: number } {
    const header = this.byte();
    const type = header & 0x0f;
    const short = (header & 0xf0) >> 4;
    const size = short === 0x0f ? Number(this.varint()) : short;
    if (size < 0 || size > this.bytes.byteLength) throw new ThriftReadError("thrift_truncated", "Thrift list declares more elements than the buffer could hold.");
    return { size, type };
  }

  /** Advances past one value of the given type without interpreting it. */
  skip(type: number, depth = 0): void {
    if (depth >= MAX_DEPTH) throw new ThriftReadError("thrift_depth", "Thrift skip nesting exceeds its bound.");
    switch (type) {
      case THRIFT_TYPE.booleanTrue:
      case THRIFT_TYPE.booleanFalse:
        return;
      case THRIFT_TYPE.byte:
        this.byte();
        return;
      case THRIFT_TYPE.i16:
      case THRIFT_TYPE.i32:
      case THRIFT_TYPE.i64:
        this.varint();
        return;
      case THRIFT_TYPE.double:
        this.take(8);
        return;
      case THRIFT_TYPE.binary:
        this.binary();
        return;
      case THRIFT_TYPE.list:
      case THRIFT_TYPE.set: {
        const header = this.listHeader();
        for (let index = 0; index < header.size; index += 1) this.skip(header.type, depth + 1);
        return;
      }
      case THRIFT_TYPE.map: {
        const size = Number(this.varint());
        if (size > 0) {
          const kinds = this.byte();
          for (let index = 0; index < size; index += 1) {
            this.skip((kinds & 0xf0) >> 4, depth + 1);
            this.skip(kinds & 0x0f, depth + 1);
          }
        }
        return;
      }
      case THRIFT_TYPE.struct: {
        this.enter();
        for (let field = this.readField(); field.type !== THRIFT_TYPE.stop; field = this.readField()) this.skip(field.type, depth + 1);
        this.leave();
        return;
      }
      default:
        throw new ThriftReadError("thrift_type", `Thrift compact type ${type} is not part of this format.`);
    }
  }
}
