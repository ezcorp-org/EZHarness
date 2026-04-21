import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./types";

/**
 * JSON-RPC transport over newline-delimited stdio.
 * Handles buffer fragmentation and message framing.
 */
export class JsonRpcTransport {
  private buffer = "";
  private responseCallbacks = new Map<number | string, {
    resolve: (response: JsonRpcResponse) => void;
    reject: (error: Error) => void;
  }>();
  private reading = false;

  /** Callback for incoming requests from the subprocess (reverse RPC). */
  onRequest?: (req: JsonRpcRequest) => void;
  /** Callback for incoming notifications from the subprocess (fire-and-forget, no id). */
  onNotification?: (notification: JsonRpcNotification) => void;

  constructor(
    private stdin: { write(data: string | Uint8Array): number; flush?(): void },
    private stdout: ReadableStream<Uint8Array>,
  ) {}

  /** Start reading responses from stdout. Call once after construction. */
  startReading(): void {
    if (this.reading) return;
    this.reading = true;
    this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const reader = this.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.buffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch {
      // Stream closed or errored
    } finally {
      reader.releaseLock();
      this.reading = false;
      // Reject all pending callbacks
      for (const [id, cb] of this.responseCallbacks) {
        cb.reject(new Error("Transport closed"));
        this.responseCallbacks.delete(id);
      }
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.method && msg.id != null) {
          // Incoming request from subprocess (has method + id)
          this.onRequest?.(msg as JsonRpcRequest);
        } else if (msg.method && msg.id == null) {
          // JSON-RPC notification (fire-and-forget, no response expected)
          this.onNotification?.(msg as JsonRpcNotification);
        } else if (msg.id != null) {
          // Response to a previously sent request
          const cb = this.responseCallbacks.get(msg.id);
          if (cb) {
            this.responseCallbacks.delete(msg.id);
            cb.resolve(msg as JsonRpcResponse);
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  /** Send a JSON-RPC request and return a promise for the response. */
  send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      this.responseCallbacks.set(request.id, { resolve, reject });
      const data = JSON.stringify(request) + "\n";
      this.stdin.write(data);
      if (this.stdin.flush) this.stdin.flush();
    });
  }

  /** Cancel all pending requests. */
  close(): void {
    for (const [_id, cb] of this.responseCallbacks) {
      cb.reject(new Error("Transport closed"));
    }
    this.responseCallbacks.clear();
  }

  /** Encode a request to a newline-delimited JSON string. */
  static encode(request: JsonRpcRequest): string {
    return JSON.stringify(request) + "\n";
  }

  /** Decode a newline-delimited JSON string to a response. */
  static decode(line: string): JsonRpcResponse {
    return JSON.parse(line.trim());
  }
}
