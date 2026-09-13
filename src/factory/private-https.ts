import { STATUS_CODES } from "node:http";

export interface FactoryPrivateRequest {
  readonly peerIdentity: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export interface FactoryPrivateResponse {
  readonly status: number;
  readonly body: Uint8Array;
  readonly contentType?: "application/json" | "application/octet-stream";
}

export interface FactoryPrivateHttpsOptions {
  readonly tls: { readonly key: string; readonly cert: string; readonly ca: string };
  readonly hostname?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
  handle(request: FactoryPrivateRequest): Promise<FactoryPrivateResponse>;
}

type Connection = {
  input: Buffer; peerIdentity?: string; processing: boolean; closed: boolean;
  output?: Buffer; offset: number; timer?: ReturnType<typeof setTimeout>;
};
const MAX_HEADER_BYTES = 16 * 1024;

/** One bounded request per private mTLS connection; peer identity comes only from TLS. */
export function startFactoryPrivateHttps(options: FactoryPrivateHttpsOptions): { url: string; stop(): void } {
  const maxBody = options.maxBodyBytes ?? 64 * 1024;
  const maxResponse = options.maxResponseBytes ?? 64 * 1024;
  const timeout = options.requestTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(maxBody) || maxBody < 1 || maxBody > 1024 * 1024 || !Number.isSafeInteger(maxResponse) || maxResponse < 1 || maxResponse > 1024 * 1024 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error("Invalid private HTTPS limits.");
  function flush(socket: Bun.Socket<Connection>): void {
    const state = socket.data;
    if (state.closed || !state.output) return;
    const written = socket.write(state.output.subarray(state.offset));
    if (written > 0) state.offset += written;
    if (state.offset === state.output.byteLength) { state.closed = true; clearTimeout(state.timer); socket.end(); }
  }
  function respond(socket: Bun.Socket<Connection>, response: FactoryPrivateResponse): void {
    const state = socket.data;
    if (state.closed || state.output) return;
    clearTimeout(state.timer);
    if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status > 599 || response.body.byteLength > maxResponse || (response.contentType !== undefined && response.contentType !== "application/json" && response.contentType !== "application/octet-stream")) {
      response = { status: 500, body: Buffer.from('{"error":"invalid_response"}') };
    }
    const header = `HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? "Result"}\r\ncontent-type: ${response.contentType ?? "application/json"}\r\ncontent-length: ${response.body.byteLength}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n`;
    state.output = Buffer.concat([Buffer.from(header), response.body]);
    state.timer = setTimeout(() => { state.closed = true; socket.terminate(); }, timeout);
    flush(socket);
  }
  const fail = (socket: Bun.Socket<Connection>, status: number, code: string) => respond(socket, { status, body: Buffer.from(JSON.stringify({ error: code })) });
  const listener = Bun.listen<Connection>({
    hostname: options.hostname ?? "127.0.0.1", port: options.port ?? 0,
    tls: { ...options.tls, requestCert: true, rejectUnauthorized: true },
    socket: {
      open(socket) { socket.data = { input: Buffer.alloc(0), processing: false, closed: false, offset: 0, timer: setTimeout(() => fail(socket, 400, "request_timeout"), timeout) }; },
      handshake(socket, authorized) { const name = socket.getPeerCertificate()?.subject?.CN; if (authorized && typeof name === "string" && name.length > 0) socket.data.peerIdentity = name; },
      async data(socket, chunk) {
        const state = socket.data;
        if (state.closed || state.output) return;
        if (state.processing) { state.closed = true; clearTimeout(state.timer); socket.terminate(); return; }
        state.input = Buffer.concat([state.input, Buffer.from(chunk)]);
        if (state.input.byteLength > MAX_HEADER_BYTES + maxBody + 4) return fail(socket, 413, "request_too_large");
        const split = state.input.indexOf("\r\n\r\n");
        if (split > MAX_HEADER_BYTES || (split < 0 && state.input.byteLength > MAX_HEADER_BYTES)) return fail(socket, 413, "header_too_large");
        if (split < 0) return;
        try {
          const [first, ...lines] = state.input.subarray(0, split).toString("latin1").split("\r\n");
          const requestLine = /^([A-Z]+) (\/[!-~]*) HTTP\/1\.1$/.exec(first!);
          if (!requestLine || requestLine[2]!.startsWith("//")) throw new Error("Invalid request line.");
          const headers: Record<string, string> = Object.create(null);
          for (const line of lines) {
            const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([\t\x20-\x7E\x80-\xFF]*)$/.exec(line);
            if (!match) throw new Error("Invalid header.");
            const name = match[1]!.toLowerCase();
            if (Object.hasOwn(headers, name)) throw new Error("Duplicate header.");
            headers[name] = match[2]!.trim();
          }
          const rawLength = headers["content-length"] ?? "0";
          if (!/^\d+$/.test(rawLength) || headers["transfer-encoding"] !== undefined) throw new Error("Invalid framing.");
          const length = Number(rawLength);
          if (!Number.isSafeInteger(length) || length > maxBody) return fail(socket, 413, "request_too_large");
          if (state.input.byteLength < split + 4 + length) return;
          if (state.input.byteLength !== split + 4 + length) throw new Error("Pipelining is unsupported.");
          if (!state.peerIdentity) return fail(socket, 401, "unauthorized");
          state.processing = true;
          clearTimeout(state.timer);
          try { respond(socket, await options.handle({ peerIdentity: state.peerIdentity, method: requestLine[1]!, path: requestLine[2]!, headers: Object.freeze(headers), body: state.input.subarray(split + 4) })); }
          catch { fail(socket, 500, "handler_failed"); }
        } catch { fail(socket, 400, "invalid_request"); }
      },
      drain: flush,
      close(socket) { socket.data.closed = true; clearTimeout(socket.data.timer); },
      error(socket) { socket.data.closed = true; clearTimeout(socket.data.timer); },
    },
  });
  return { url: `https://${options.hostname ?? "127.0.0.1"}:${listener.port}`, stop: () => listener.stop(true) };
}
