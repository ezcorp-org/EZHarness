import { expect, test } from "bun:test";
import { THRIFT_TYPE, ThriftReader, ThriftReadError } from "./thrift";

/**
 * The compact-protocol decoder, driven by hand-written frames.
 *
 * A Parquet footer is the only thing this reader ever sees in production, and
 * a real footer never exercises the corrupt paths. These frames do, because a
 * decoder that reads past its buffer or loops on a run of continuation bits is
 * a defect whether or not any writer produces one.
 */

const bytes = (...values: number[]) => new Uint8Array(values);

function field(id: number, type: number): number {
  return (id << 4) | type;
}

test("an unsigned varint and its zigzag reading agree with the specification", () => {
  const reader = new ThriftReader(bytes(0x00, 0x01, 0x02, 0x03, 0x04, 0xac, 0x02));
  expect(reader.varint()).toBe(0n);
  expect(reader.varint()).toBe(1n);
  reader.seek(1);
  expect(reader.zigzag()).toBe(-1n);
  expect(reader.zigzag()).toBe(1n);
  expect(reader.zigzag()).toBe(-2n);
  expect(reader.zigzag()).toBe(2n);
  expect(reader.zigzag()).toBe(150n);
  expect(reader.offset).toBe(7);
});

test("a varint longer than its declared width is refused rather than looped", () => {
  const reader = new ThriftReader(bytes(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01));
  expect(() => reader.varint()).toThrow(ThriftReadError);
  try {
    new ThriftReader(bytes(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01)).varint();
  } catch (error) {
    expect((error as ThriftReadError).code).toBe("thrift_varint");
  }
});

test("an integer outside the safe range is refused rather than rounded", () => {
  // Zigzag of 2**60, which is a safe bigint and an unsafe number.
  const value = 2n ** 60n;
  const encoded: number[] = [];
  let zigzag = value << 1n;
  while (zigzag > 0x7fn) {
    encoded.push(Number((zigzag & 0x7fn) | 0x80n));
    zigzag >>= 7n;
  }
  encoded.push(Number(zigzag));
  expect(new ThriftReader(bytes(...encoded)).zigzag()).toBe(value);
  expect(() => new ThriftReader(bytes(...encoded)).number()).toThrow(ThriftReadError);
  try {
    new ThriftReader(bytes(...encoded)).number();
  } catch (error) {
    expect((error as ThriftReadError).code).toBe("thrift_varint");
  }
});

test("every read is bounded by the buffer it was given", () => {
  for (const build of [
    () => new ThriftReader(bytes()).readField(),
    () => new ThriftReader(bytes(0x08, 0x04)).binary(),
    () => new ThriftReader(bytes(0x08, 0xff, 0xff, 0xff, 0x7f)).binary(),
    () => new ThriftReader(bytes(0x01)).skip(THRIFT_TYPE.double),
    () => new ThriftReader(bytes()).seek(5),
    () => new ThriftReader(bytes()).seek(-1),
  ]) {
    expect(build).toThrow(ThriftReadError);
  }
  try {
    new ThriftReader(bytes(0x08, 0x04)).binary();
  } catch (error) {
    expect((error as ThriftReadError).code).toBe("thrift_truncated");
  }
});

test("field headers read short deltas and long identifiers, and a boolean lives in its own header", () => {
  // A header whose delta nibble is zero carries its identifier as a following
  // zigzag varint; a header byte of 0x00 would be the struct's stop, not that.
  const reader = new ThriftReader(bytes(field(1, THRIFT_TYPE.booleanTrue), field(2, THRIFT_TYPE.booleanFalse), THRIFT_TYPE.i32, 0x2a, 0x00));
  reader.enter();
  const first = reader.readField();
  expect([first.id, first.type]).toEqual([1, THRIFT_TYPE.booleanTrue]);
  expect(reader.boolean()).toBe(true);
  const second = reader.readField();
  expect([second.id, second.type]).toEqual([3, THRIFT_TYPE.booleanFalse]);
  expect(reader.boolean()).toBe(false);
  // Delta zero means an explicit zigzag identifier follows.
  const third = reader.readField();
  expect(third.id).toBe(21);
  expect(() => reader.boolean()).toThrow(ThriftReadError);
  expect(reader.readField().type).toBe(THRIFT_TYPE.stop);
  reader.leave();
});

test("text is decoded strictly and a list header carries both short and long sizes", () => {
  const encoded = new TextEncoder().encode("category");
  expect(new ThriftReader(bytes(encoded.byteLength, ...encoded)).text()).toBe("category");
  expect(() => new ThriftReader(bytes(2, 0xff, 0xfe)).text()).toThrow(ThriftReadError);
  try {
    new ThriftReader(bytes(2, 0xff, 0xfe)).text();
  } catch (error) {
    // A corrupt footer reaches this with arbitrary bytes, so the failure must
    // be one of this reader's, never a bare TypeError from the decoder.
    expect((error as ThriftReadError).code).toBe("thrift_text");
  }
  const short = new ThriftReader(bytes((3 << 4) | THRIFT_TYPE.i32, 0x02, 0x04, 0x06)).listHeader();
  expect([short.size, short.type]).toEqual([3, THRIFT_TYPE.i32]);
  const long = new ThriftReader(bytes((0x0f << 4) | THRIFT_TYPE.binary, 0x11, ...new Array<number>(17).fill(0))).listHeader();
  expect([long.size, long.type]).toEqual([17, THRIFT_TYPE.binary]);
  expect(() => new ThriftReader(bytes((0x0f << 4) | THRIFT_TYPE.binary, 0xff, 0x7f)).listHeader()).toThrow(ThriftReadError);
});

test("skip advances past every compact type without interpreting it", () => {
  const text = new TextEncoder().encode("ab");
  const frame = bytes(
    THRIFT_TYPE.byte, 0x07,
    ...[0x02],
    ...[0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    text.byteLength, ...text,
    (2 << 4) | THRIFT_TYPE.i32, 0x02, 0x04,
    (1 << 4) | THRIFT_TYPE.i32, 0x06,
    0x01, (THRIFT_TYPE.binary << 4) | THRIFT_TYPE.i32, 0x01, 0x41, 0x08,
    field(1, THRIFT_TYPE.i32), 0x02, 0x00,
  );
  const reader = new ThriftReader(frame);
  reader.seek(1);
  reader.skip(THRIFT_TYPE.byte);
  reader.skip(THRIFT_TYPE.i16);
  reader.skip(THRIFT_TYPE.double);
  reader.skip(THRIFT_TYPE.binary);
  reader.skip(THRIFT_TYPE.list);
  reader.skip(THRIFT_TYPE.set);
  reader.skip(THRIFT_TYPE.map);
  reader.skip(THRIFT_TYPE.struct);
  reader.skip(THRIFT_TYPE.booleanTrue);
  expect(reader.offset).toBe(frame.byteLength);
  // An empty map writes no key-value type byte at all.
  const empty = new ThriftReader(bytes(0x00, 0x2a));
  empty.skip(THRIFT_TYPE.map);
  expect(empty.offset).toBe(1);
});

test("a compact type the format does not define is refused", () => {
  expect(() => new ThriftReader(bytes()).skip(0x0d)).toThrow(ThriftReadError);
  try {
    new ThriftReader(bytes()).skip(0x0d);
  } catch (error) {
    expect((error as ThriftReadError).code).toBe("thrift_type");
  }
});

test("nesting is bounded, so a footer shaped like a cycle ends as one refusal", () => {
  // Thirty-three nested single-field structs: one past the declared bound.
  const frame: number[] = [];
  for (let depth = 0; depth < 40; depth += 1) frame.push(field(1, THRIFT_TYPE.struct));
  for (let depth = 0; depth < 40; depth += 1) frame.push(0x00);
  const reader = new ThriftReader(bytes(...frame));
  expect(() => reader.skip(THRIFT_TYPE.struct)).toThrow(ThriftReadError);
  try {
    new ThriftReader(bytes(...frame)).skip(THRIFT_TYPE.struct);
  } catch (error) {
    expect((error as ThriftReadError).code).toBe("thrift_depth");
  }
  const deep = new ThriftReader(bytes(...frame));
  for (let depth = 0; depth < 32; depth += 1) {
    deep.enter();
    deep.readField();
  }
  expect(() => deep.enter()).toThrow(ThriftReadError);
});
