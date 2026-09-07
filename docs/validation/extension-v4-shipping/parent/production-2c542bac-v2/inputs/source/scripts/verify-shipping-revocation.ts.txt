/** Pause an installed handler before its next storage request, then revoke it. */
import { strict as assert } from "node:assert";
import { productionLifecycleClient, command, required, readStoppedProductionDatabase } from "./lib/production-lifecycle-client";
import { SHIPPING_EFFECT_ORIGIN, startShippingEffectCallback, shippingEffectState, waitForShippingState, releaseShippingEffect, releaseAllShippingEffects } from "./lib/shipping-effect-client";

function fixture(name: string): Record<string, string> {
  const manifest = {
    schemaVersion: 4, name, version: "1.0.0", entrypoint: "./extension.ts", description: "Live storage revocation proof", author: { name: "Shipping verification" },
    permissions: { storage: true, network: ["127.0.0.1"] },
    tools: [{ name: "write", description: "Write after an optional observed barrier", inputSchema: { type: "object", properties: { key: { type: "string" }, text: { type: "string" }, pause: { type: "boolean" } }, required: ["key", "text"], additionalProperties: false }, outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }],
    smokeTest: { tool: "write", input: { key: "smoke", text: "smoke-value" }, expect: { textIncludes: "stored:smoke-value" } },
  };
  return {
    "extension.ts": `import { defineExtension, serve, type ExtensionContext } from "@ezcorp/sdk/v4";
import { Storage } from "@ezcorp/sdk/runtime";
type Store = { set(key: string, value: string): Promise<unknown> };
type Input = { key: string; text: string; pause?: boolean };
export function createWrite(store: Store, barrier: (key: string, workerId: string) => Promise<void>) {
  return async (input: Input, context: ExtensionContext) => {
    if (input.pause) await barrier(input.key, context.invocation.workerId);
    await store.set(input.key, input.text);
    return { text: "stored:" + input.text };
  };
}
const barrier = async (key: string, workerId: string) => {
  const response = await fetch(${JSON.stringify(SHIPPING_EFFECT_ORIGIN + "/hold")}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, workerId, stage: "before-storage" }) });
  if (!response.ok) throw new Error("Owned barrier failed: " + response.status);
};
const extension = defineExtension({ manifest: ${JSON.stringify(manifest)}, tools: { write: createWrite(new Storage("global"), barrier) } });
if (import.meta.main) await serve(extension);
`,
    "extension.test.ts": `import { expect, test } from "bun:test";
import { createWrite } from "./extension";
test("the actual handler admits storage only after the observed barrier", async () => {
  const values = new Map<string, string>();
  let entered!: () => void; let release!: () => void;
  const observed = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const write = createWrite({ async set(key, value) { values.set(key, value); } }, async () => { entered(); await held; });
  const result = write({ key: "key", text: "feature-value", pause: true }, { invocation: { workerId: "worker" } } as any);
  await observed;
  expect(values.has("key")).toBe(false);
  release();
  expect(await result).toEqual({ text: "stored:feature-value" });
  expect(values.get("key")).toBe("feature-value");
});
`,
  };
}

function outputText(result: { success: boolean; output?: unknown; error?: string }): string {
  assert.equal(result.success, true, result.error ?? "Tool invocation failed");
  const output = typeof result.output === "string" ? JSON.parse(result.output) as unknown : result.output;
  assert(output && typeof output === "object" && "text" in output && typeof output.text === "string", "Tool must return its actual stored result");
  return output.text;
}

async function main(): Promise<void> {
  const lifecycle = await productionLifecycleClient();
  const container = required("EZ_PRODUCTION_CONTAINER");
  await startShippingEffectCallback(container);
  const records: Array<{ installationId: string; seedKey: string; seedValue: string; raceKey: string; expectedRaceValue: string | null; freshKey?: string }> = [];
  const outcomes: Array<Record<string, unknown>> = [];
  try {
    for (const action of ["control", "disable", "uninstall"] as const) {
      const name = `revoke-${action}-${Date.now().toString(36)}`;
      const created = await lifecycle.createBuild(name, fixture(name));
      const installationId = created.installation.id;
      await lifecycle.approveAndActivate(installationId, created.release.id, null);
      const before = await lifecycle.inspect(installationId);
      const conversation = await lifecycle.client.createConversation({ title: `Revocation ${action}` });
      assert((await lifecycle.client.wireExtensions(conversation.id, [name])).wired.includes(name));
      const invoke = (key: string, text: string, pause = false) => lifecycle.client.invokeExtensionTool(conversation.id, name, "write", { key, text, pause });
      const seedKey = `retained-${action}`;
      const seedValue = `retained-value-${crypto.randomUUID()}`;
      assert.equal(outputText(await invoke(seedKey, seedValue)), `stored:${seedValue}`);
      const raceKey = `race-${action}-${crypto.randomUUID()}`;
      const raceValue = `race-value-${action}`;
      const pending = invoke(raceKey, raceValue, true).then(result => ({ result }), error => ({ error: error instanceof Error ? error.message : String(error) }));
      const barrier = await waitForShippingState(`${action} handler before storage`, async () => {
        const state = await shippingEffectState(container);
        return state.pending.includes(raceKey) ? state.arrivals.find(arrival => arrival.key === raceKey) ?? null : null;
      });
      assert(barrier.workerId, "The actual handler must supply its invocation worker");
      if (action !== "control" && process.env.EZ_SHIPPING_REVOKE_FAULT !== "1") {
        await lifecycle.client.extensionControl("extensions_release", { action, installationId });
        const revoked = await lifecycle.inspect(installationId);
        assert.equal(revoked.installation.enabled, false);
        assert.equal(revoked.installation.uninstalled, action === "uninstall");
        assert.deepEqual(revoked.installation.grants, []);
        assert.equal(revoked.installation.ownerId, before.installation.ownerId);
        assert.equal(revoked.installation.activeReleaseId, created.release.id);
        assert.deepEqual(revoked.releases, before.releases, "Revocation must retain immutable release history");
      }
      await releaseShippingEffect(container, raceKey);
      const terminal = await pending;
      if (action === "control") {
        assert("result" in terminal);
        assert.equal(outputText(terminal.result), `stored:${raceValue}`);
      } else {
        assert("error" in terminal || terminal.result.success === false, `${action} must deny the paused handler's next storage effect`);
      }
      const record = { installationId, seedKey, seedValue, raceKey, expectedRaceValue: action === "control" ? raceValue : null, freshKey: undefined as string | undefined };
      if (action === "disable") {
        await lifecycle.approveAndActivate(installationId, created.release.id, created.release.id);
        record.freshKey = "fresh-approved";
        assert.equal(outputText(await invoke(record.freshKey, "fresh-approved-value")), "stored:fresh-approved-value");
      }
      records.push(record);
      outcomes.push({ action, installationId, workerId: barrier.workerId, terminal: "error" in terminal ? "request-failure" : terminal.result.success ? "success" : "tool-failure" });
    }
    await releaseAllShippingEffects(container);
    await command("docker", ["stop", container]);
    await readStoppedProductionDatabase(async database => {
      for (const record of records) {
        const rows = await database.query<{ key: string; value: unknown }>("SELECT key, value FROM extension_storage WHERE extension_id = $1 AND scope = 'global'", [record.installationId]);
        const values = new Map(rows.rows.map(row => [row.key, row.value]));
        assert.equal(values.get(record.seedKey), record.seedValue, "Revocation must retain pre-existing storage");
        if (record.expectedRaceValue === null) assert.equal(values.has(record.raceKey), false, "The denied invocation must leave no stored effect");
        else assert.equal(values.get(record.raceKey), record.expectedRaceValue);
        if (record.freshKey) assert.equal(values.get(record.freshKey), "fresh-approved-value");
      }
    });
    console.log(JSON.stringify({ passed: true, check: "R3", outcomes, retainedStorage: records.length, automaticReplay: "no denied storage effect after fresh invocation and app stop" }));
  } finally {
    try { await releaseAllShippingEffects(container); } catch { /* The database proof stops this owned app. */ }
  }
}

await main();
