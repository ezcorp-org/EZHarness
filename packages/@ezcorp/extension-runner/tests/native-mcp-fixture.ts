import { createInterface } from "node:readline";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";
import { createHash } from "node:crypto";

const schema = { type: "object", properties: { destination: { type: "string" }, action: { type: "string", enum: ["direct", "tunnel", "http", "tls", "credential"] } }, required: ["destination", "action"], additionalProperties: false };
async function exchange(destination: string, action: string): Promise<string> {
  if (action === "credential") return createHash("sha256").update(process.env.OPENAI_API_KEY ?? "missing").digest("hex");
  const direct = action === "direct";
  const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : undefined;
  const target = direct ? new URL(`http://${destination}`) : proxy;
  if (!target) throw new Error("No invocation proxy");
  return new Promise((resolve, reject) => {
    const socket = connect({ host: target.hostname, port: Number(target.port) });
    let received = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Connection deadline")); }, 5000);
    const finish = (value: string) => { clearTimeout(timer); socket.destroy(); resolve(value); };
    socket.once("error", () => { clearTimeout(timer); socket.destroy(); if (direct) resolve("direct denied"); else reject(new Error("Proxy connection failed")); });
    const authorization = `Proxy-Authorization: Basic ${Buffer.from(`${target.username}:${target.password}`).toString("base64")}`;
    socket.once("connect", () => socket.write(direct ? "native payload" : action === "http" ? `GET http://${destination}/fixture HTTP/1.1\r\nHost: ${destination}\r\n${authorization}\r\nConnection: close\r\n\r\n` : `CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n${authorization}\r\n\r\n${action === "tls" ? "" : "native payload"}`));
    const receive = (bytes: Buffer) => {
      received += bytes.toString();
      if (action === "tls" && received.includes("\r\n\r\n")) {
        socket.off("data", receive);
        if (!received.startsWith("HTTP/1.1 200 ")) { clearTimeout(timer); socket.destroy(); reject(new Error("CONNECT denied")); return; }
        const secured = connectTls({ socket, servername: "localhost", rejectUnauthorized: false }, () => secured.write("GET /fixture HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
        let plaintext = "";
        secured.on("data", chunk => { plaintext += chunk.toString(); if (plaintext.includes("native payload")) { secured.destroy(); finish("TLS native payload"); } });
        secured.once("error", () => { clearTimeout(timer); socket.destroy(); reject(new Error("TLS fixture failed")); });
      } else if (received.includes("native payload")) finish(action === "http" ? "HTTP native payload" : received);
    };
    socket.on("data", receive);
  });
}

async function handle(method: string, params: { arguments?: { destination: string; action: string } }) {
  if (method === "initialize") return { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "native-network-fixture", version: "1.0.0" } };
  if (method === "tools/list") return { tools: [{ name: "exchange", description: "Test native network boundary", inputSchema: schema }] };
  if (method === "tools/call" && params.arguments) return { content: [{ type: "text", text: await exchange(params.arguments.destination, params.arguments.action) }], isError: false };
  throw new Error("Unsupported method");
}

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (!Object.hasOwn(request, "id")) continue;
  try { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: await handle(request.method, request.params ?? {}) })}\n`); }
  catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Native operation failed" } })}\n`); }
}
