import { createHash } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import type { ProviderCall, ProviderReceipt } from "@ezcorp/extension-contract";

type Pending<Recovery = unknown> = { version: 1; state: "pending"; call: ProviderCall; recovery?: Recovery };
type Complete<T> = { version: 1; state: "complete"; call: ProviderCall; result: T };
type RecordValue<T, Recovery = unknown> = Pending<Recovery> | Complete<T>;
type Destroyed<T> = { version: 1; state: "destroyed"; resourceId: string; scope: ProviderCall["scope"]; result: T };
export type JournalBegin<T> = { kind: "new" } | { kind: "replay"; result: T } | { kind: "unknown"; receipt: ProviderReceipt };
export type RecoverableJournalBegin<T> = { kind: "new" | "recover" } | { kind: "replay"; result: T };
export type RecoverableMutationBegin<T, Recovery> = { kind: "new" | "recover"; recovery: Recovery } | { kind: "replay"; result: T };

function key(call: ProviderCall): string {
  return createHash("sha256").update(`${call.scope.projectId}\0${call.scope.bindingId}\0${call.scope.generation}\0${call.idempotencyKey}`).digest("hex");
}
function same(a: ProviderCall, b: ProviderCall): boolean { return a.requestDigest === b.requestDigest && a.operationId === b.operationId; }

export class DurableOperationJournal {
  constructor(private readonly root: string) {}
  private path(call: ProviderCall): string { return `${this.root}/${key(call)}.json`; }
  private destroyedPath(resourceId: string): string { return `${this.root}/destroyed-${createHash("sha256").update(resourceId).digest("hex")}.json`; }
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
  async beginRecoverable<T>(call: ProviderCall): Promise<RecoverableJournalBegin<T>> {
    const begun = await this.begin<T>(call);
    if (begun.kind === "unknown") return { kind: "recover" };
    return begun;
  }
  async beginRecoverableMutation<T, Recovery>(call: ProviderCall, prepare: () => Promise<Recovery>): Promise<RecoverableMutationBegin<T, Recovery>> {
    const path = this.path(call);
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as RecordValue<T, Recovery>;
      if (!same(record.call, call)) throw new Error("idempotency key conflicts with another request");
      if (record.state === "complete") return { kind: "replay", result: record.result };
      if (!("recovery" in record)) throw new Error("pending mutation has no recovery record");
      return { kind: "recover", recovery: record.recovery as Recovery };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const recovery = await prepare();
    try { await this.publish(path, { version: 1, state: "pending", call, recovery } satisfies Pending<Recovery>, true); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") return this.beginRecoverableMutation(call, prepare); throw error; }
    return { kind: "new", recovery };
  }
  async completed<T>(call: ProviderCall): Promise<T | undefined> {
    let record: RecordValue<T>;
    try { record = JSON.parse(await readFile(this.path(call), "utf8")) as RecordValue<T>; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
    if (!same(record.call, call)) throw new Error("idempotency key conflicts with another request");
    return record.state === "complete" ? record.result : undefined;
  }
  async destroyed<T>(resourceId: string, scope: ProviderCall["scope"]): Promise<T | undefined> {
    let record: Destroyed<T>;
    try { record = JSON.parse(await readFile(this.destroyedPath(resourceId), "utf8")) as Destroyed<T>; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
    if (record.version !== 1 || record.state !== "destroyed" || record.resourceId !== resourceId || JSON.stringify(record.scope) !== JSON.stringify(scope)) throw new Error("destroyed resource scope mismatch");
    return record.result;
  }
  async recordDestroyed<T>(resourceId: string, call: ProviderCall, result: T): Promise<void> {
    const path = this.destroyedPath(resourceId);
    try { await this.publish(path, { version: 1, state: "destroyed", resourceId, scope: call.scope, result } satisfies Destroyed<T>, true); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const existing = await this.destroyed<T>(resourceId, call.scope); if (JSON.stringify(existing) !== JSON.stringify(result)) throw new Error("destroyed resource already has a different result");
    }
  }
  async complete<T>(call: ProviderCall, result: T): Promise<void> {
    const path = this.path(call); let current: RecordValue<T>;
    try { current = JSON.parse(await readFile(path, "utf8")) as RecordValue<T>; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error("operation was not begun"); throw error; }
    if (!same(current.call, call)) throw new Error("idempotency key conflicts with another request");
    if (current.state === "complete") { if (JSON.stringify(current.result) !== JSON.stringify(result)) throw new Error("operation already has a different result"); return; }
    await this.publish(path, { version: 1, state: "complete", call, result } satisfies Complete<T>, false);
  }
}
