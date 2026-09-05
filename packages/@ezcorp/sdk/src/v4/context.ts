import { AsyncLocalStorage } from "node:async_hooks";
import type { InvocationContext } from "@ezcorp/extension-contract";
import { ContractError } from "@ezcorp/extension-contract";
import type { ExtensionContext } from "./index";

const active = new AsyncLocalStorage<ExtensionContext>();
export function withExtensionContext<Result>(context: ExtensionContext, action: () => Result): Result { return active.run(context, action); }
export function getExtensionContext(): ExtensionContext | undefined { return active.getStore(); }
export function getInvocationContext(): Readonly<InvocationContext> | undefined { return active.getStore()?.invocation; }
export async function getGrantedEnv(name: string): Promise<string | null> {
  const context = active.getStore();
  if (!context) throw new ContractError("NO_INVOCATION", "Credentials require an active invocation");
  context.signal.throwIfAborted();
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) throw new ContractError("INVALID_ENV", "Invalid credential name");
  const value = await context.call("ezcorp/env.get", { name });
  if (value !== null && typeof value !== "string") throw new ContractError("INVALID_ENV", "Invalid credential response");
  return value;
}
