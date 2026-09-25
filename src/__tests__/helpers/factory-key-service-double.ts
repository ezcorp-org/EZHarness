import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FakeCloudKms } from "./factory-kms-doubles.ts";

/**
 * One local key service that speaks both wire protocols a factory installation
 * can select: the AWS KMS JSON protocol (`x-amz-target: TrentService.*`) and
 * the Vault/OpenBao transit HTTP API (`/v1/<mount>/<encrypt|decrypt>/<key>`).
 * The restore tests, the orchestrator's Node tests, and the full-stack harness
 * all use this same double, so every process proves the same service contract.
 * Keys never leave it; the transit token is checked on every call.
 */
export interface FactoryKeyServiceDouble {
  /** The base URL both protocols are served on. */
  readonly endpoint: string;
  /** Every call, in order: `kms:<operation>:<keyId>` or `transit:<operation>:<mount>/<key>`. */
  readonly calls: string[];
  stop(): Promise<void>;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function reply(response: ServerResponse, status: number, value: unknown, type = "application/json"): void {
  response.writeHead(status, { "content-type": type });
  response.end(JSON.stringify(value));
}

export async function startFactoryKeyServiceDouble(options: { readonly transitToken: string }): Promise<FactoryKeyServiceDouble> {
  const kms = new FakeCloudKms();
  const transitKeys = new Map<string, Buffer>();
  const calls: string[] = [];
  const transitKey = (name: string) => { if (!transitKeys.has(name)) transitKeys.set(name, randomBytes(32)); return transitKeys.get(name)!; };
  const server = createServer((request, response) => {
    void (async () => {
      const input = await body(request);
      const target = request.headers["x-amz-target"];
      if (typeof target === "string") {
        const operation = target === "TrentService.Encrypt" ? "encrypt" : "decrypt";
        calls.push(`kms:${operation}:${String(input.KeyId)}`);
        const context = input.EncryptionContext as Record<string, string>;
        if (operation === "encrypt") {
          const out = await kms.encrypt({ KeyId: String(input.KeyId), Plaintext: Buffer.from(String(input.Plaintext), "base64"), EncryptionContext: context });
          return reply(response, 200, { CiphertextBlob: Buffer.from(out.CiphertextBlob!).toString("base64"), KeyId: input.KeyId }, "application/x-amz-json-1.1");
        }
        try {
          const out = await kms.decrypt({ KeyId: String(input.KeyId), CiphertextBlob: Buffer.from(String(input.CiphertextBlob), "base64"), EncryptionContext: context });
          return reply(response, 200, { Plaintext: Buffer.from(out.Plaintext!).toString("base64"), KeyId: input.KeyId }, "application/x-amz-json-1.1");
        } catch {
          return reply(response, 400, { __type: "InvalidCiphertextException", message: "the ciphertext does not open under this key" }, "application/x-amz-json-1.1");
        }
      }
      const match = /^\/v1\/(.+)\/(encrypt|decrypt)\/([^/]+)$/.exec(request.url ?? "");
      if (!match || request.method !== "POST") return reply(response, 404, { errors: ["no such route"] });
      if (request.headers["x-vault-token"] !== options.transitToken) return reply(response, 403, { errors: ["permission denied"] });
      const [, mount, operation, name] = match as unknown as [string, string, "encrypt" | "decrypt", string];
      calls.push(`transit:${operation}:${mount}/${name}`);
      const key = transitKey(`${mount}/${name}`);
      if (operation === "encrypt") {
        const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
        const sealed = Buffer.concat([cipher.update(Buffer.from(String(input.plaintext), "base64")), cipher.final()]);
        return reply(response, 200, { data: { ciphertext: `vault:v1:${Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64")}` } });
      }
      try {
        const blob = Buffer.from(String(input.ciphertext).replace(/^vault:v1:/, ""), "base64");
        const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
        decipher.setAuthTag(blob.subarray(12, 28));
        return reply(response, 200, { data: { plaintext: Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("base64") } });
      } catch {
        return reply(response, 400, { errors: ["cipher: message authentication failed"] });
      }
    })().catch(() => reply(response, 500, { errors: ["double failed"] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    calls,
    stop: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
