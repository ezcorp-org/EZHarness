import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayFactoryCommandQueue } from "../../../packages/@ezcorp/factory-orchestrator/src/queue-client.ts";

const input = JSON.parse(readFileSync(0, "utf8"));
const directory = await mkdtemp(join(tmpdir(), "factory-node-queue-"));
try {
  const tls = {};
  for (const [field, content] of Object.entries({ caPath: input.ca, certificatePath: input.cert, privateKeyPath: input.key, serviceTokenPath: input.token })) {
    tls[field] = join(directory, field);
    await writeFile(tls[field], content, { mode: 0o600 });
  }
  const queue = await createGatewayFactoryCommandQueue({ baseUrl: input.url, tls, serverName: "localhost", requestTimeoutMs: 5000 });
  const claimed = await queue.claim();
  if (!claimed) throw new Error("Expected the stored command.");
  const confirmed = await queue.confirmInboxIdentity(claimed.command);
  await queue.settle(claimed, "delivered");
  console.log(JSON.stringify({ command: claimed.command, confirmed, empty: await queue.claim() }));
} finally { await rm(directory, { recursive: true, force: true }); }
