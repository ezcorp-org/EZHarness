import { expect, test } from "bun:test";
import { notePreviewWsDenial } from "./preview-ws-diagnostics";

test("preview WebSocket diagnostics contain only a fixed stage and stay bounded", () => {
  const originalNow = Date.now;
  const originalWrite = process.stderr.write;
  const lines: string[] = [];
  const start = originalNow();
  Date.now = () => start;
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    for (let index = 0; index < 17; index++) notePreviewWsDenial("transport.handshake");
    expect(lines).toHaveLength(16);
    Date.now = () => start + 60_000;
    notePreviewWsDenial("connect");
    expect(lines).toHaveLength(17);
    for (const [index, line] of lines.entries()) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(entry).sort()).toEqual(["level", "msg", "stage", "subsystem", "ts"]);
      expect(entry.stage).toBe(index === 16 ? "connect" : "transport.handshake");
      expect(entry).not.toHaveProperty("error");
      expect(entry).not.toHaveProperty("request");
    }
  } finally {
    Date.now = originalNow;
    process.stderr.write = originalWrite;
  }
});
