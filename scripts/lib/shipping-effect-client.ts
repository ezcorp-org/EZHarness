import { command } from "./production-lifecycle-client";
import type { ShippingEffectState } from "./shipping-effect-server";

export const SHIPPING_EFFECT_ORIGIN = "http://127.0.0.1:7071";

export async function waitForShippingState<T>(description: string, probe: () => Promise<T | null>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result !== null) return result;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(25);
  }
}

async function callback(container: string, path: string, body?: unknown): Promise<string> {
  const options = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  return command("docker", ["exec", container, "bun", "-e", `const response = await fetch(${JSON.stringify(SHIPPING_EFFECT_ORIGIN + path)}, ${JSON.stringify(options)}); if (!response.ok) throw new Error(await response.text()); console.log(await response.text());`]);
}

export async function shippingEffectState(container: string): Promise<ShippingEffectState> {
  return JSON.parse(await callback(container, "/state")) as ShippingEffectState;
}

export async function startShippingEffectCallback(container: string): Promise<void> {
  const file = "/tmp/shipping-effect-server.ts";
  await command("docker", ["cp", "scripts/lib/shipping-effect-server.ts", `${container}:${file}`]);
  await command("docker", ["exec", "-d", container, "env", "EZ_SHIPPING_EFFECT_PORT=7071", "EZ_SHIPPING_EFFECT_LEDGER=/tmp/shipping-effect-ledger.json", "bun", file]);
  await waitForShippingState("owned callback health", async () => {
    try { return await shippingEffectState(container); } catch { return null; }
  });
}

export async function releaseShippingEffect(container: string, key: string): Promise<void> {
  await callback(container, "/release", { key });
}

export async function releaseAllShippingEffects(container: string): Promise<void> {
  for (const key of (await shippingEffectState(container)).pending) await releaseShippingEffect(container, key);
}
