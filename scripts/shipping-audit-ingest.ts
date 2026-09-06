/** Ingest owned-VM seccomp records through the production soak reader. */
import { readFileSync } from "node:fs";
import { mock } from "bun:test";
import { initDb, closeDb } from "../src/db/connection";

const logPath = process.argv[2];
if (!logPath) throw new Error("usage: bun scripts/shipping-audit-ingest.ts <vm-log>");
const lines = readFileSync(logPath, "utf8").split("\n");
const pid = lines.map((line) => /^VM_PROBE_PID=(\d+)$/.exec(line.trim())?.[1]).find(Boolean);
if (!pid) throw new Error("VM probe PID missing from serial log");
const kernelLines = lines.filter((line) => line.includes("audit: type=1326"));
if (kernelLines.length === 0) throw new Error("VM serial log has no type=1326 record");

// Import a query-string-isolated copy before registering the observer. The
// parser then receives the mock for its canonical module specifier, while the
// observer delegates every write to this real implementation.
const auditQuery = await import("../src/db/queries/audit-log.ts?shipping-audit-real");
const realInsertAuditEntry = auditQuery.insertAuditEntry;
const listAuditForExtension = auditQuery.listAuditForExtension;

const extensionId = `shipping-audit-vm-${pid}`;
const context = { userId: null, extensionId, extensionName: "shipping-audit-vm" };
const pendingWrites: Array<Promise<string>> = [];
mock.module("../src/db/queries/audit-log", () => ({
  insertAuditEntry: (...args: Parameters<typeof realInsertAuditEntry>) => {
    const write = realInsertAuditEntry(...args);
    pendingWrites.push(write);
    return write;
  },
}));
const { parseAndEmitSeccompViolations } = await import(
  "../src/extensions/runtime/seccomp-soak-reader.ts?shipping-audit-observer"
);
async function awaitWritesFrom(start: number): Promise<void> {
  await Promise.all(pendingWrites.slice(start));
}
await initDb();
try {
  const exactStart = pendingWrites.length;
  await parseAndEmitSeccompViolations(kernelLines, pid, context);
  await awaitWritesFrom(exactStart);
  const deadline = Date.now() + 5_000;
  let rows = await listAuditForExtension(extensionId);
  while (rows.length === 0 && Date.now() < deadline) {
    await Bun.sleep(25);
    rows = await listAuditForExtension(extensionId);
  }
  if (rows.length === 0 || rows.some((row) => (row.metadata as { pid?: string } | null)?.pid !== pid)) {
    throw new Error(`production reader did not persist exact PID ${pid}; observed writes=${pendingWrites.length}`);
  }

  const wrongExtensionId = `${extensionId}-wrong-pid`;
  const wrongStart = pendingWrites.length;
  await parseAndEmitSeccompViolations(kernelLines, String(Number(pid) + 1), {
    ...context,
    extensionId: wrongExtensionId,
  });
  await awaitWritesFrom(wrongStart);
  const wrongRows = await listAuditForExtension(wrongExtensionId);
  if (wrongRows.length !== 0) throw new Error("wrong-PID control persisted an audit row");

  console.log(JSON.stringify({
    status: "PASS",
    pid,
    sourceRecords: kernelLines.length,
    persistedRows: rows.length,
    wrongPidRows: wrongRows.length,
  }));
} finally {
  await closeDb();
}
