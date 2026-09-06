/** Ingest owned-VM seccomp records through the production soak reader. */
import { readFileSync } from "node:fs";
import { mock } from "bun:test";
import { initDb, closeDb } from "../src/db/connection";

const logPath = process.argv[2];
if (!logPath) throw new Error("usage: bun scripts/shipping-audit-ingest.ts <vm-log>");
if (!process.env.EZCORP_DB_PATH || process.env.EZCORP_DB_PATH === ":memory:") {
  throw new Error("EZCORP_DB_PATH must name an owned on-disk test database");
}
const lines = readFileSync(logPath, "utf8").split("\n");
const pid = lines.map((line) => /^VM_PROBE_PID=(\d+)$/.exec(line.trim())?.[1]).find(Boolean);
if (!pid) throw new Error("VM probe PID missing from serial log");
const kernelLines = lines.filter((line) => line.includes("audit: type=1326"));
if (kernelLines.length === 0) throw new Error("VM serial log has no type=1326 record");
const exactRecords = kernelLines.map((line) => {
  const match = /\bpid=(\d+)\b.*\barch=([0-9a-f]+)\b.*\bsyscall=(\d+)\b.*\bcode=(0x[0-9a-f]+)\b/i.exec(line);
  if (!match) throw new Error(`unparseable type=1326 row: ${line}`);
  return { pid: match[1]!, arch: match[2]!, syscall: Number(match[3]), code: match[4]!.toLowerCase() };
}).filter((record) => record.pid === pid);
if (exactRecords.length === 0) throw new Error(`no type=1326 record for VM probe PID ${pid}`);

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
  const actualRecords = rows.map((row) => {
    const metadata = row.metadata as { pid?: string; arch?: string; syscall?: number; code?: string } | null;
    return { action: row.action, pid: metadata?.pid, arch: metadata?.arch, syscall: metadata?.syscall, code: metadata?.code?.toLowerCase() };
  });
  const expected = exactRecords.map((record) => JSON.stringify({ action: "ext:mcp:seccomp-violation", ...record })).sort();
  const actual = actualRecords.map((record) => JSON.stringify(record)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
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
