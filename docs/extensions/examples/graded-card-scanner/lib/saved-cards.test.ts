import { afterEach, expect, spyOn, test } from "bun:test";
import { __resetChannelForTests, getChannel, type HostChannel } from "@ezcorp/sdk/runtime";
import { tools } from "../index";
import { mockCard } from "../app/lib/mock-card.js";

afterEach(__resetChannelForTests);

function card(cert = "49392223") {
  return { cert, status: "done", record: mockCard(cert), scans: ["2026-09-05T00:00:00.000Z"], savedAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z" };
}

function fixture() {
  const stored = new Map<string, unknown>([["psa-token", "not-a-card"]]);
  const requests: Record<string, unknown>[] = [];
  const spy = spyOn(getChannel(), "request").mockImplementation((async (method: string, params: Record<string, unknown>) => {
    expect(method).toBe("ezcorp/storage");
    expect(params.scope).toBe("user");
    requests.push(params);
    const key = String(params.key);
    switch (params.action) {
      case "get": return { exists: stored.has(key), value: stored.get(key) ?? null };
      case "set": stored.set(key, structuredClone(params.value)); return { ok: true, sizeBytes: 1 };
      case "delete": return { deleted: stored.delete(key) };
      case "list": return { keys: [...stored.keys()].filter(value => value.startsWith(String(params.prefix))).sort() };
      case "batch": return (params.operations as Array<{ key: string }>).map(operation => ({ deleted: stored.delete(operation.key) }));
      default: throw new Error("Unexpected storage operation");
    }
  }) as HostChannel["request"]);
  const invoke = async (name: string, input: Record<string, unknown> = {}) => {
    const result = await tools[name]!(input, {} as never);
    if (result.isError) throw new Error(String(result.content[0]));
    const text = result.content[0];
    if (text?.type !== "text") throw new Error("Missing tool JSON output");
    return JSON.parse(text.text);
  };
  return { stored, requests, invoke, close: () => spy.mockRestore() };
}

test("saved cards use user storage only and clear never reads or deletes the PSA token", async () => {
  const context = fixture();
  try {
    const row = card();
    expect(await context.invoke("scanner_saved_get", { cert: row.cert })).toBeNull();
    expect(await context.invoke("scanner_saved_upsert", { card: row })).toEqual({ saved: true });
    expect(await context.invoke("scanner_saved_get", { cert: row.cert })).toEqual(row);
    expect(await context.invoke("scanner_saved_list")).toEqual({ cards: [row], nextCursor: null });
    expect(await context.invoke("scanner_saved_delete", { cert: row.cert })).toEqual({ deleted: true });
    await context.invoke("scanner_saved_upsert", { card: row });
    expect(await context.invoke("scanner_saved_clear")).toEqual({ deleted: 1 });
    expect([...context.stored]).toEqual([["psa-token", "not-a-card"]]);
    expect(context.requests.every(request => !Object.hasOwn(request, "userId") && request.scope === "user")).toBe(true);
  } finally { context.close(); }
});

test("saved cards reject extra authority, malformed records, mismatched certs, and oversized data before storage", async () => {
  const context = fixture();
  try {
    for (const input of [
      { card: card(), userId: "foreign" },
      { card: { ...card(), extra: "unknown" } },
      { card: { ...card(), cert: "../psa-token" } },
      { card: { ...card(), scans: ["not-a-date"] } },
      { card: { ...card(), record: mockCard("11111111") } },
      { card: { ...card(), scans: Array(1000).fill("2026-09-05T00:00:00.000Z") } },
    ]) await expect(context.invoke("scanner_saved_upsert", input)).rejects.toThrow();
    await expect(context.invoke("scanner_saved_get", { cert: "psa-token" })).rejects.toThrow();
    expect(context.requests).toEqual([]);
  } finally { context.close(); }
});

test("saved-card pages have a bounded cursor and the capacity limit does not prevent updates", async () => {
  const context = fixture();
  try {
    for (let index = 0; index < 500; index += 1) context.stored.set("scanner-card:" + (10000000 + index), card(String(10000000 + index)));
    const first = await context.invoke("scanner_saved_list");
    expect(first.cards).toHaveLength(25);
    expect(first.nextCursor).toBe("10000024");
    const last = await context.invoke("scanner_saved_list", { cursor: "10000474" });
    expect(last.cards).toHaveLength(25);
    expect(last.nextCursor).toBeNull();
    await expect(context.invoke("scanner_saved_upsert", { card: card("99999999") })).rejects.toThrow("limit reached");
    expect(await context.invoke("scanner_saved_upsert", { card: card("10000000") })).toEqual({ saved: true });
  } finally { context.close(); }
});
