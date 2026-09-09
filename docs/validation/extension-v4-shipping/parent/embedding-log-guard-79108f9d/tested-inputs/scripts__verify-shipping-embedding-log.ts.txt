import { assertEmbeddingLogHealthy } from "./lib/shipping-embedding-log-guard";

const [path] = process.argv.slice(2);
try {
  if (!path) throw new Error("usage: bun scripts/verify-shipping-embedding-log.ts <compose.log>");
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error("embedding compose log is unavailable");
  assertEmbeddingLogHealthy(await file.text());
} catch (error) {
  console.error(error instanceof Error ? error.message : "embedding compose log guard failed");
  process.exit(1);
}
