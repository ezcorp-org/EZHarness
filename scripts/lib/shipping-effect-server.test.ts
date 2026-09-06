import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { startShippingEffectServer } from "./shipping-effect-server";

test("real held requests publish a durable barrier before release and serialize concurrent effects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shipping-effect-server-"));
  const effect = await startShippingEffectServer({ port: 0, ledgerPath: join(directory, "ledger.json") });
  const origin = `http://127.0.0.1:${effect.port}`;
  const post = (path: string, body: unknown) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const held = post("/hold", { key: "before", workerId: "worker-before", stage: "before-effect" });
    const visible = await (await fetch(`${origin}/state`)).json() as { pending: string[]; arrivals: Array<{ key: string }> };
    assert.deepEqual(visible.pending, ["before"]);
    assert.deepEqual(visible.arrivals.map(value => value.key), ["before"]);
    assert.equal((await post("/release", { key: "before" })).status, 200);
    assert.equal((await held).status, 200);

    await Promise.all(["one", "two"].map(key => post("/effect", { key, workerId: `worker-${key}`, stage: "effect" })));
    const state = await (await fetch(`${origin}/state`)).json() as { effects: Array<{ key: string; count: number }> };
    assert.deepEqual(state.effects.map(effect => effect.key).sort(), ["one", "two"]);
    assert.deepEqual(state.effects.map(effect => effect.count).sort(), [1, 1]);
    assert.equal((await post("/unknown", { key: "unknown" })).status, 404);
  } finally {
    await effect.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
