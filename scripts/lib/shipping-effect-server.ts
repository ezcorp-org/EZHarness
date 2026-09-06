/**
 * Owned in-container callback used by shipping crash tests. It intentionally
 * exposes only barriers and an append-only effect ledger, never app state.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ShippingArrival = { key: string; workerId: string; stage: string; at: number };
export type ShippingEffect = ShippingArrival & { count: number };
export type ShippingEffectState = { arrivals: ShippingArrival[]; effects: ShippingEffect[]; pending: string[] };

type RequestBody = { key?: unknown; workerId?: unknown; stage?: unknown; hold?: unknown };

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.length > 512) throw new Error(`${field} must be a non-empty bounded string`);
  return value;
}

async function load(ledgerPath: string): Promise<ShippingEffectState> {
  try {
    const value = JSON.parse(await readFile(ledgerPath, "utf8")) as Partial<ShippingEffectState>;
    return { arrivals: Array.isArray(value.arrivals) ? value.arrivals : [], effects: Array.isArray(value.effects) ? value.effects : [], pending: Array.isArray(value.pending) ? value.pending : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { arrivals: [], effects: [], pending: [] };
    throw error;
  }
}

async function save(ledgerPath: string, state: ShippingEffectState): Promise<void> {
  await mkdir(dirname(ledgerPath), { recursive: true });
  const temporary = `${ledgerPath}.next`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, ledgerPath);
}

export async function startShippingEffectServer(options: { port: number; ledgerPath: string }): Promise<{ port: number; stop(): Promise<void> }> {
  const waiters = new Map<string, Array<() => void>>();
  let writes = Promise.resolve();
  const mutate = <Result>(change: (state: ShippingEffectState) => Result | Promise<Result>): Promise<Result> => {
    const task = writes.then(async () => {
      const state = await load(options.ledgerPath);
      const result = await change(state);
      await save(options.ledgerPath, state);
      return result;
    });
    writes = task.then(() => undefined, () => undefined);
    return task;
  };
  const state = async (): Promise<ShippingEffectState> => {
    await writes;
    return load(options.ledgerPath);
  };
  const hold = async (key: string): Promise<void> => new Promise(resolve => {
    const current = waiters.get(key) ?? [];
    current.push(resolve);
    waiters.set(key, current);
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 0,
    async fetch(request) {
      try {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/state") return Response.json(await state());
        if (request.method !== "POST") return new Response("Not found", { status: 404 });
        const body = await request.json() as RequestBody;
        const key = requiredString(body.key, "key");
        if (url.pathname === "/release") {
          const released = waiters.get(key) ?? [];
          waiters.delete(key);
          await mutate(current => { current.pending = current.pending.filter(value => value !== key); });
          for (const resolve of released) resolve();
          return Response.json({ released: released.length });
        }
        if (url.pathname !== "/hold" && url.pathname !== "/effect") return new Response("Not found", { status: 404 });
        const workerId = requiredString(body.workerId, "workerId");
        const stage = requiredString(body.stage, "stage");
        const arrival: ShippingArrival = { key, workerId, stage, at: Date.now() };
        const shouldHold = url.pathname === "/hold" || body.hold === true;
        const blocked = shouldHold ? hold(key) : undefined;
        await mutate(current => {
          current.arrivals.push(arrival);
          if (url.pathname === "/effect") current.effects.push({ ...arrival, count: current.effects.filter(effect => effect.key === key).length + 1 });
          if (shouldHold) current.pending.push(key);
        });
        if (blocked) await blocked;
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    },
  });
  if (server.port === undefined) throw new Error("Owned callback did not bind a TCP port");
  return { port: server.port, async stop() { server.stop(true); } };
}

if (import.meta.main) {
  const port = Number(process.env.EZ_SHIPPING_EFFECT_PORT ?? "7071");
  const ledgerPath = process.env.EZ_SHIPPING_EFFECT_LEDGER;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !ledgerPath) throw new Error("Set EZ_SHIPPING_EFFECT_PORT and EZ_SHIPPING_EFFECT_LEDGER");
  await startShippingEffectServer({ port, ledgerPath });
}
