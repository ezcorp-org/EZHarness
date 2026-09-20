import { createHash } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import type { ProviderCall, ProviderReceipt } from "@ezcorp/extension-contract";

type Pending = { version: 1; state: "pending"; call: ProviderCall };
type Complete<T> = { version: 1; state: "complete"; call: ProviderCall; result: T };
type RecordValue<T> = Pending | Complete<T>;
export type JournalBegin<T> = { kind: "new" } | { kind: "replay"; result: T } | { kind: "unknown"; receipt: ProviderReceipt };

function key(call: ProviderCall): string {
  return createHash("sha256").update(`${call.scope.projectId}\0${call.scope.bindingId}\0${call.scope.generation}\0${call.idempotencyKey}`).digest("hex");
}
function same(a: ProviderCall, b: ProviderCall): boolean { return a.requestDigest === b.requestDigest && a.operationId === b.operationId; }

export class DurableOperationJournal {
  constructor(private readonly root: string) {}
  private path(call: ProviderCall): string { return `${this.root}/${key(call)}.json`; }
  private async publish(path: string, value: unknown, exclusive: boolean): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${crypto.randomUUID()}.new`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync();
      if (exclusive) await link(temporary, path); else await rename(temporary, path);
      const directory = await open(this.root, "r"); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await file.close(); await rm(temporary, { force: true }); }
  }
  async begin<T>(call: ProviderCall): Promise<JournalBegin<T>> {
    const path = this.path(call);
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as RecordValue<T>;
      if (!same(record.call, call)) throw new Error("idempotency key conflicts with another request");
      if (record.state === "complete") return { kind: "replay", result: record.result };
      return { kind: "unknown", receipt: { operationId: call.operationId, idempotencyKey: call.idempotencyKey, requestDigest: call.requestDigest, outcome: "unknown", error: { code: "operation_outcome_unknown", message: "The prior effect may have started before recovery.", retryable: true } } };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    try { await this.publish(path, { version: 1, state: "pending", call } satisfies Pending, true); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") return this.begin(call); throw error; }
    return { kind: "new" };
  }
  async complete<T>(call: ProviderCall, result: T): Promise<void> {
    const path = this.path(call); let current: RecordValue<T>;
    try { current = JSON.parse(await readFile(path, "utf8")) as RecordValue<T>; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error("operation was not begun"); throw error; }
    if (!same(current.call, call)) throw new Error("idempotency key conflicts with another request");
    if (current.state === "complete") { if (JSON.stringify(current.result) !== JSON.stringify(result)) throw new Error("operation already has a different result"); return; }
    await this.publish(path, { version: 1, state: "complete", call, result } satisfies Complete<T>, false);
  }
}
