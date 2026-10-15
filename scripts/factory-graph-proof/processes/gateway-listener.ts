/**
 * A real mutual-TLS listener on the execution gateway's port, so the product's
 * gateway readiness probe has a peer. Ported from the W09b real-server harness.
 *
 * Env: W19A_REPO, W19A_ROOT (the stack root holding secrets/), W19A_GATEWAY_PORT.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repo = process.env.W19A_REPO!;
const root = process.env.W19A_ROOT!;
const { startFactoryPrivateHttps } = await import(join(repo, "src/factory/private-https.ts"));
startFactoryPrivateHttps({
  tls: {
    key: readFileSync(join(root, "secrets", "server.key"), "utf8"),
    cert: readFileSync(join(root, "secrets", "server.pem"), "utf8"),
    ca: readFileSync(join(root, "secrets", "ca.pem"), "utf8"),
  },
  hostname: "127.0.0.1",
  port: Number(process.env.W19A_GATEWAY_PORT),
  async handle() { return { status: 200, body: Buffer.from(JSON.stringify({ schemaVersion: "factory.execution-gateway.v1" })), contentType: "application/json" as const }; },
});
await new Promise(() => {});
