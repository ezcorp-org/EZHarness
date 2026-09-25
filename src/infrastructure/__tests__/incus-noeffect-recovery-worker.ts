import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { applyNoEffectRecovery } from "../incus-create-noeffect-recovery";

const [directory, receiptPath, publicKeyPath] = process.argv.slice(2);
if (!directory || !receiptPath || !publicKeyPath) throw new Error("worker inputs required");
const client = new PGlite(directory);
try {
  await client.waitReady;
  const receipt = await Bun.file(receiptPath).json();
  const key = await Bun.file(publicKeyPath).text();
  const cleanupOperationId = await applyNoEffectRecovery(drizzle(client), receipt, key);
  process.stdout.write(cleanupOperationId + "\n");
} finally { await client.close(); }
