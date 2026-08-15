/**
 * Minimal SSE frame decoder. Bun/Node have no global `EventSource`, so the
 * client reads the `/api/runtime-events` response body as a byte stream and
 * feeds it here. Buffers across chunk boundaries, splits on the SSE
 * record separator (`\n\n`), and returns the joined `data:` payload of each
 * record (skipping `:`-prefixed comments / heartbeats and field-only records).
 */
export class SseDataBuffer {
  private buf = "";
  private _lastEventId = "";

  /**
   * The most recent `id:` the server sent, or `""` before the first one.
   *
   * Kept so a reconnecting consumer can send `Last-Event-ID` and be replayed
   * from the server's resume ring. This used to be dropped on the floor
   * (`push` filtered for `data:` and discarded every other field), which made
   * reconnection unconditionally lossy. Per the SSE spec the id PERSISTS
   * across records until the server sends a new one, so it is tracked as
   * buffer state rather than returned per record — and a record that carries
   * no `id:` deliberately leaves it unchanged.
   *
   * Best-effort by nature: the server ring is 500 GLOBAL entries including
   * every `run:token`, so a busy instance can turn it over in seconds. A
   * consumer that must not miss anything re-drains an authoritative endpoint
   * on reconnect and treats replay as an optimisation.
   */
  get lastEventId(): string {
    return this._lastEventId;
  }

  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const record = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const lines = record.split("\n");
      for (const line of lines) {
        if (line.startsWith("id:")) this._lastEventId = line.slice("id:".length).replace(/^ /, "");
      }
      const dataLines = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice("data:".length).replace(/^ /, ""));
      if (dataLines.length > 0) out.push(dataLines.join("\n"));
    }
    return out;
  }
}
