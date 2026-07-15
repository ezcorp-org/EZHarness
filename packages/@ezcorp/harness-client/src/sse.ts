/**
 * Minimal SSE frame decoder. Bun/Node have no global `EventSource`, so the
 * client reads the `/api/runtime-events` response body as a byte stream and
 * feeds it here. Buffers across chunk boundaries, splits on the SSE
 * record separator (`\n\n`), and returns the joined `data:` payload of each
 * record (skipping `:`-prefixed comments / heartbeats and field-only records).
 */
export class SseDataBuffer {
  private buf = "";

  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const record = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const dataLines = record
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice("data:".length).replace(/^ /, ""));
      if (dataLines.length > 0) out.push(dataLines.join("\n"));
    }
    return out;
  }
}
