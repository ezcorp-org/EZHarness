import { request as httpsRequest } from "node:https";
import type { Certificates } from "./factory-certificates";

export interface PrivateHttpsCallOptions {
  readonly method?: string;
  readonly body?: Buffer;
  readonly token?: string;
  readonly certificate?: "client" | "foreign" | "none";
  readonly headers?: Record<string, string>;
  readonly responseLimitBytes?: number;
}

export interface PrivateHttpsResult { readonly status: number; readonly headers: Record<string, string | string[] | undefined>; readonly body: Buffer }

/**
 * An in-process mutual-TLS client for bodies too large to hand a subprocess
 * through stdin. The Node subprocess fixture stays the interoperability proof.
 */
export function privateHttpsCall(url: string, certs: Certificates, options: PrivateHttpsCallOptions = {}): Promise<PrivateHttpsResult> {
  const certificate = options.certificate ?? "client";
  const body = options.body ?? Buffer.alloc(0);
  const limit = options.responseLimitBytes ?? 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const call = httpsRequest(url, {
      method: options.method ?? "GET",
      ca: certs.ca,
      ...(certificate === "none" ? {} : { cert: certificate === "client" ? certs.clientCert : certs.foreignCert, key: certificate === "client" ? certs.clientKey : certs.foreignKey }),
      rejectUnauthorized: true,
      servername: "localhost",
      headers: {
        "x-ezcorp-factory-version": "1",
        "content-length": body.byteLength,
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...options.headers,
      },
    }, response => {
      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > limit) response.destroy(new Error("private response exceeds its limit"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    call.on("error", reject);
    if (body.byteLength) call.write(body);
    call.end();
  });
}
