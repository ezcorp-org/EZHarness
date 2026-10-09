import { expect, test } from "bun:test";
import { encodeMaskedPreviewFrame, MAX_PREVIEW_FRAME_BYTES, readUnmaskedPreviewFrame } from "./preview-websocket-codec";

function reader(wire: Buffer) {
  let offset = 0;
  return { async read(length: number) {
    if (offset + length > wire.length) throw new Error("truncated frame");
    const result = wire.subarray(offset, offset + length);
    offset += length;
    return result;
  } };
}

test("shared preview codec masks bounded client text and binary frames", () => {
  for (const length of [0, 125, 126, 65_535, 65_536, MAX_PREVIEW_FRAME_BYTES]) {
    const payload = Buffer.alloc(length, 0x5a);
    const wire = encodeMaskedPreviewFrame(2, payload);
    expect(wire[0]).toBe(0x82);
    expect((wire[1]! & 0x80) !== 0).toBe(true);
    const code = wire[1]! & 127;
    const offset = code === 126 ? 4 : code === 127 ? 10 : 2;
    const mask = wire.subarray(offset, offset + 4);
    const decoded = Buffer.from(wire.subarray(offset + 4).map((byte, index) => byte ^ mask[index % 4]!));
    expect(decoded).toEqual(payload);
  }
  expect(() => encodeMaskedPreviewFrame(1, Buffer.alloc(MAX_PREVIEW_FRAME_BYTES + 1))).toThrow("too large");
  expect(() => encodeMaskedPreviewFrame(9, Buffer.alloc(126))).toThrow("too large");
});

test("shared preview codec reads server frame lengths and denies malformed wire", async () => {
  expect(await readUnmaskedPreviewFrame(reader(Buffer.from([0x81, 5, ...Buffer.from("hello")])))).toEqual({
    opcode: 1, data: Buffer.from("hello"), final: true,
  });
  const medium = Buffer.concat([Buffer.from([0x82, 126, 0, 126]), Buffer.alloc(126, 0x42)]);
  expect((await readUnmaskedPreviewFrame(reader(medium))).data.length).toBe(126);
  const long = Buffer.alloc(10);
  long[0] = 0x82;
  long[1] = 127;
  long.writeBigUInt64BE(65_536n, 2);
  expect((await readUnmaskedPreviewFrame(reader(Buffer.concat([long, Buffer.alloc(65_536)])))).data.length).toBe(65_536);
  await expect(readUnmaskedPreviewFrame(reader(Buffer.from([0x81, 0x80])))).rejects.toThrow("Invalid preview");
  await expect(readUnmaskedPreviewFrame(reader(Buffer.from([0xC1, 0])))).rejects.toThrow("Invalid preview");
  await expect(readUnmaskedPreviewFrame(reader(Buffer.from([0x09, 0])))).rejects.toThrow("Invalid preview");
  await expect(readUnmaskedPreviewFrame(reader(Buffer.from([0x83, 0])))).rejects.toThrow("Invalid preview");
  const oversized = Buffer.from(long);
  oversized.writeBigUInt64BE(BigInt(MAX_PREVIEW_FRAME_BYTES + 1), 2);
  await expect(readUnmaskedPreviewFrame(reader(oversized))).rejects.toThrow("too large");
});
