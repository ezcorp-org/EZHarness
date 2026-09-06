import { strict as assert } from "node:assert";
import { productionLifecycleClient, readStoppedProductionDatabase, command, required } from "./lib/production-lifecycle-client";
import { releaseAllShippingEffects, releaseShippingEffect, shippingEffectState, startShippingEffectCallback, waitForShippingState } from "./lib/shipping-effect-client";

const CALLBACK_PORT = 7071;
function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function fixture(name: string): Record<string, string> {
  const event = `${name}:act`;
  const manifest = {
    schemaVersion: 4, name, version: "1.0.0", description: "Production delivery crash fixture", author: { name: "EZCorp shipping" }, entrypoint: "./extension.ts",
    pages: [{ id: "race", title: "Delivery race", icon: "Activity", description: "Owned crash proof page" }],
    methods: [{ name: `ezcorp/event/${event}`, inputSchema: { type: "object" }, outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false } }],
    permissions: { network: ["127.0.0.1"], eventSubscriptions: [event] },
  };
  return {
    "ezcorp.config.ts": `import { validateManifest } from "@ezcorp/sdk/v4";\nexport default validateManifest(${JSON.stringify(manifest, null, 2)});\n`,
    "extension.ts": `import { defineExtension, serve, type ExtensionContext } from "@ezcorp/sdk/v4";\nimport manifest from "./ezcorp.config";\n\ntype EventInput = { payload?: { key?: unknown; phase?: unknown } };\ntype CallbackFetch = (url: string, init?: RequestInit) => Promise<Response>;\nfunction value(input: EventInput, field: "key" | "phase"): string { const item = input.payload?.[field]; if (typeof item !== "string" || !item) throw new Error(\`Missing \${field}\`); return item; }\nasync function post(send: CallbackFetch, path: string, body: Record<string, unknown>): Promise<void> { const response = await send(\`http://127.0.0.1:${CALLBACK_PORT}\${path}\`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(\`Callback failed: \${response.status}\`); }\nexport async function handleEvent(input: EventInput, context: ExtensionContext, send: CallbackFetch = fetch): Promise<{ ok: true }> {\n  const key = value(input, "key"); const phase = value(input, "phase");\n  if (!(["before", "after", "success"] as string[]).includes(phase)) throw new Error("Invalid phase");\n  const body = { key, workerId: context.invocation.workerId, stage: phase };\n  if (phase === "before") { await post(send, "/hold", body); await post(send, "/effect", { ...body, stage: "after-before-barrier" }); }\n  else await post(send, "/effect", { ...body, ...(phase === "after" ? { hold: true } : {}) });\n  return { ok: true };\n}\nexport const extension = defineExtension({ manifest, methods: { ${JSON.stringify(`ezcorp/event/${event}`)}: { inputSchema: {}, outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false }, handle: handleEvent } } });\nif (import.meta.main) await serve(extension);\n`,
    "extension.test.ts": `import { expect, test } from "bun:test";\nimport { handleEvent } from "./extension";\ntest("event handler sends its invocation worker to the owned callback", async () => { let call: { url: string; init?: RequestInit } | undefined; await expect(handleEvent({ payload: { key: "fixture", phase: "success" } }, { invocation: { invocationId: "invocation", workerId: "worker", releaseId: "release", principalId: "owner", scopeId: "global", token: "token", deadline: Date.now() + 1000 }, signal: new AbortController().signal, call: async () => null }, async (url, init) => { call = { url: String(url), init }; return new Response(null, { status: 200 }); })).resolves.toEqual({ ok: true }); expect(call?.url).toBe("http://127.0.0.1:${CALLBACK_PORT}/effect"); expect(JSON.parse(String(call?.init?.body))).toMatchObject({ key: "fixture", workerId: "worker", stage: "success" }); });\n`,
  };
}

async function waitFor<T>(description: string, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const result = await probe();
    if (result !== null) return result;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(25);
  }
}

async function killObservedWorker(workerId: string): Promise<void> {
  const store = required("EZ_EXTENSION_RUNNER_STORE");
  const storeHash = hash(store);
  const name = `ez-v4-${hash(`${store}:${workerId}`).slice(0, 32)}`;
  const inspect = JSON.parse(await command("podman", ["inspect", name])) as Array<{ Name: string; Config: { Labels?: Record<string, string> } }>;
  assert.equal(inspect.length, 1, "Observed worker must identify one rootless runner container");
  assert.equal(inspect[0]?.Name, name);
  assert.equal(inspect[0]?.Config.Labels?.["io.ezcorp.runner"], storeHash, "Worker container must have the exact owned runner label");
  await command("podman", ["kill", name]);
}

async function inspectStoppedDelivery(installationId: string, key: string): Promise<{ id: string; state: string }> {
  const { ExtensionDeliveryQueue } = await import("../src/extensions/v4/deliveries");
  const { drizzle } = await import("drizzle-orm/pglite");
  return readStoppedProductionDatabase(async database => {
    const result = await database.query("SELECT id FROM extension_release_deliveries WHERE installation_id = $1 AND payload LIKE $2 ORDER BY available_at DESC LIMIT 1", [installationId, `%${key}%`]);
    const id = (result.rows[0] as { id?: unknown } | undefined)?.id;
    assert.equal(typeof id, "string", "The Hub request must leave a durable delivery row");
    const delivery = await new ExtensionDeliveryQueue(drizzle(database)).inspect(installationId, id);
    assert(delivery, "The durable delivery must be inspectable after an app stop");
    return { id, state: delivery.state };
  });
}

async function waitHealth(origin: string): Promise<void> {
  await waitFor("restarted app health", async () => {
    try { return (await fetch(`${origin}/api/health`)).ok ? true : null; } catch { return null; }
  });
}

async function main(): Promise<void> {
  const lifecycle = await productionLifecycleClient();
  const container = required("EZ_PRODUCTION_CONTAINER");
  const name = `shipping-delivery-${Date.now().toString(36)}`;
  const created = await lifecycle.createBuild(name, fixture(name));
  await lifecycle.approveAndActivate(created.installation.id, created.release.id, null);
  await startShippingEffectCallback(container);

  const fire = (key: string, phase: "before" | "after" | "success") => fetch(`${lifecycle.origin}/api/extensions/${name}/events/act`, { method: "POST", headers: { cookie: lifecycle.cookie, origin: lifecycle.origin, "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ source: "hub", pageId: "race", payload: { key, phase } }), signal: AbortSignal.timeout(120_000) });
  async function proveBeforePositive(): Promise<void> {
    const key = `before-positive-${crypto.randomUUID()}`;
    const request = fire(key, "before");
    await waitForShippingState("before-effect positive barrier", async () => {
      const state = await shippingEffectState(container);
      return state.pending.includes(key) ? state.arrivals.find(arrival => arrival.key === key) ?? null : null;
    });
    await releaseShippingEffect(container, key);
    assert.equal((await request).status, 200, "A released before-effect handler must reach its following effect");
    assert.equal((await shippingEffectState(container)).effects.filter(effect => effect.key === key).length, 1, "The before-effect positive control must record its actual effect");
  }
  async function proveKilledDelivery(phase: "before" | "after"): Promise<void> {
    const key = `${phase}-${crypto.randomUUID()}`;
    const request = fire(key, phase);
    const arrived = await waitForShippingState(`${phase} causal callback barrier`, async () => {
      const state = await shippingEffectState(container);
      return state.arrivals.find(arrival => arrival.key === key) ?? null;
    });
    assert.equal(arrived.stage, phase);
    await killObservedWorker(arrived.workerId);
    await releaseShippingEffect(container, key);
    const response = await request;
    assert.equal(response.status, 500, `Killed ${phase}-effect delivery must have a terminal public failure`);
    assert.match(await response.text(), /Extension is unavailable/i);
    const state = await shippingEffectState(container);
    assert.equal(state.effects.filter(effect => effect.key === key).length, phase === "before" ? 0 : 1, `${phase} barrier must prove its exact external-effect boundary`);

    await command("docker", ["stop", container]);
    const durable = await inspectStoppedDelivery(created.installation.id, key);
    assert.equal(durable.state, "outcome_unknown", "A killed worker delivery must remain terminally uncertain");
    await command("docker", ["start", container]);
    await waitHealth(lifecycle.origin);
    await startShippingEffectCallback(container);
    const retried = await fire(key, phase);
    assert.equal(retried.status, 500, "Retrying the same Idempotency-Key must expose the retained uncertain outcome");
    const afterRetry = await shippingEffectState(container);
    assert.equal(afterRetry.effects.filter(effect => effect.key === key).length, phase === "before" ? 0 : 1, "A retained uncertain delivery must never repeat its effect");
  }

  try {
    await proveBeforePositive();
    await proveKilledDelivery("before");
    await proveKilledDelivery("after");
    const freshKey = `fresh-${crypto.randomUUID()}`;
    const fresh = await fire(freshKey, "success");
    assert.equal(fresh.status, 200, "A distinct delivery after uncertain history must succeed");
    const state = await shippingEffectState(container);
    assert.equal(state.effects.filter(effect => effect.key === freshKey).length, 1);
    console.log(JSON.stringify({ passed: true, checks: ["before-effect-positive-control", "real-worker-sigkill-before-effect", "real-worker-sigkill-after-effect", "durable-outcome-unknown", "same-key-no-repeat-after-restart", "fresh-distinct-delivery"] }));
  } finally {
    // A killed worker can leave the app-side HTTP callback pending. Releasing
    // every recorded barrier keeps the owned production container tear-down bounded.
    try { await releaseAllShippingEffects(container); } catch { /* app may already be stopped */ }
  }
}

await main();
