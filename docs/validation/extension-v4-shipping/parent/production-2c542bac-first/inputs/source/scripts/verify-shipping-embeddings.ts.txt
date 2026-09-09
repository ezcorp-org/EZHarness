/** Verify the built server creates and stores a real memory embedding over HTTP. */
import { strict as assert } from "node:assert";
import { EMBEDDING_DIMENSIONS } from "../src/memory/types";
import type { HealthResponse } from "../src/health";
import { productionLifecycleClient } from "./lib/production-lifecycle-client";

const { sessionJson } = await productionLifecycleClient();
const content = `Shipping embedding check ${crypto.randomUUID()}: an extension can recall this saved note.`;
const started = Date.now();
const memory = await sessionJson<{ id: string; content: string }>("/api/memories", {
  body: { content, category: "technical", confidence: "high" },
});
assert.match(memory.id, /^[0-9a-f-]{36}$/);
try {
  assert.equal(memory.content, content);
  const deadline = started + 180_000;
  let vector: number[] | null = null;
  let polls = 0;
  while (Date.now() < deadline) {
    const stored = await sessionJson<{ id: string; content: string; embedding: number[] | null }>(`/api/memories/${memory.id}`);
    polls++;
    assert.equal(stored.id, memory.id);
    assert.equal(stored.content, content);
    if (stored.embedding !== null) {
      vector = stored.embedding;
      break;
    }
    await Bun.sleep(250);
  }
  assert(Array.isArray(vector), "The built server did not persist a memory embedding within three minutes");
  assert.equal(vector.length, EMBEDDING_DIMENSIONS);
  assert(vector.every(Number.isFinite), "The stored embedding contains a non-finite value");
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  assert(Math.abs(norm - 1) < 0.001, `The stored embedding has invalid norm ${norm}`);
  const health = await sessionJson<HealthResponse>("/api/health?detail=true");
  assert.equal(health.db?.status, "up");
  assert.equal(health.embeddings?.status, "ready");
  console.log(JSON.stringify({ proof: "production-memory-embedding", dimensions: vector.length, norm, polls, durationMs: Date.now() - started, status: "passed" }));
} finally {
  await sessionJson(`/api/memories/${memory.id}`, { method: "DELETE" });
}
