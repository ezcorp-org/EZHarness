/** Ingest owned-VM seccomp records through the production soak reader. */
import { existsSync, readFileSync } from "node:fs";
import { mock } from "bun:test";
import { initDb, closeDb } from "../src/db/connection";

const logPath = process.argv[2];
if (!logPath) throw new Error("usage: bun scripts/shipping-audit-ingest.ts <vm-log>");
if (!process.env.EZCORP_DB_PATH || process.env.EZCORP_DB_PATH === ":memory:") {
  throw new Error("EZCORP_DB_PATH must name an owned on-disk test database");
}
if (process.env.DATABASE_URL) throw new Error("Audit proof must not connect to an external database");
if (existsSync(process.env.EZCORP_DB_PATH)) throw new Error("Audit proof requires a new database path; refusing to open existing state");
const lines = readFileSync(logPath, "utf8").split("\n");
const pid = lines.map((line) => /^VM_PROBE_PID=(\d+)$/.exec(line.trim())?.[1]).find(Boolean);
if (!pid) throw new Error("VM probe PID missing from serial log");
const kernelStart = lines.indexOf("VM_KERNEL_RECORDS_BEGIN");
const kernelEnd = lines.indexOf("VM_KERNEL_RECORDS_END");
if (kernelStart < 0 || kernelEnd <= kernelStart || !lines.includes(`VM_AUDIT_ASSERTION=PASS pid=${pid}`)) {
  throw new Error("Audit ingestion requires a complete, passing owned-VM kernel window");
}
if (!lines.includes(`VM_PROBE_REPORTED_PID=${pid}`)) throw new Error("Sandbox child attribution does not match the probe PID");
const kernelWindow = lines.slice(kernelStart + 1, kernelEnd);
const kernelLines = kernelWindow.filter((line) => line.includes("audit: type=1326"));
if (kernelLines.length === 0) throw new Error("VM serial log has no type=1326 record");
const exactRecords = kernelLines.map((line) => {
  const match = /\bpid=(\d+)\b.*\barch=([0-9a-f]+)\b.*\bsyscall=(\d+)\b.*\bcode=(0x[0-9a-f]+)\b/i.exec(line);
  if (!match) throw new Error(`unparseable type=1326 row: ${line}`);
  return { pid: match[1]!, arch: match[2]!, syscall: Number(match[3]), code: match[4]!.toLowerCase() };
}).filter((record) => record.pid === pid);
if (exactRecords.length === 0) throw new Error(`no type=1326 record for VM probe PID ${pid}`);
if (!exactRecords.some(record => record.arch === "c000003e" && record.syscall === 39 && record.code === "0x7ffc0000")) {
  throw new Error("The declared getpid LOG record is absent from the exact-PID kernel window");
}

// Import a query-string-isolated copy before registering the observer. The
// parser then receives the mock for its canonical module specifier, while the
// observer delegates every write to this real implementation.
const auditModule = "../src/db/queries/audit-log.ts?shipping-audit-real";
const auditQuery = await import(auditModule) as typeof import("../src/db/queries/audit-log");
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
const readerModule = "../src/extensions/runtime/seccomp-soak-reader.ts?shipping-audit-observer";
const { parseAndEmitSeccompViolations } = await import(readerModule) as typeof import("../src/extensions/runtime/seccomp-soak-reader");
async function awaitWritesFrom(start: number): Promise<void> {
  await Promise.all(pendingWrites.slice(start));
}
await initDb();
try {
  const exactStart = pendingWrites.length;
  await parseAndEmitSeccompViolations(kernelLines, pid, context);
  await awaitWritesFrom(exactStart);
  const rows = await listAuditForExtension(extensionId);
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
