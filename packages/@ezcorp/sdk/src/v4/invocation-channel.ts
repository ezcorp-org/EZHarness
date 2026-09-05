import { AsyncLocalStorage } from "node:async_hooks";
import { posix } from "node:path";
import { ContractError } from "@ezcorp/extension-contract";
import type { HostChannel } from "../runtime/channel";
import { withToolContext } from "../runtime/tool-context";
import type { ExtensionContext } from "./index";

const active = new AsyncLocalStorage<HostChannel>();
export function getInvocationChannel(): HostChannel | undefined { return active.getStore(); }

export async function withInvocationChannel<Result>(name: string, context: ExtensionContext, toolName: string | undefined, action: () => Result | Promise<Result>): Promise<Result> {
  const pending: Promise<unknown>[] = [];
  let open = true;
  function check(): void {
    if (!open) throw new ContractError("NO_INVOCATION", "Host capabilities require an active invocation");
    context.signal.throwIfAborted();
  }
  const channel: HostChannel = {
    request: async <Value>(method: string, params: unknown): Promise<Value> => {
      check();
      if (method.startsWith("ezcorp/fs.") && params && typeof params === "object" && "path" in params && typeof params.path === "string") {
        const path = params.path;
        if (path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) throw new ContractError("INVALID_PATH", "Invalid virtual filesystem path");
        const absolute = posix.resolve("/project", path);
        const ownData = `/project/.ezcorp/extension-data/${name}`;
        params = { ...params, path: absolute === ownData || absolute.startsWith(`${ownData}/`) ? `/data${absolute.slice(ownData.length)}` : absolute };
      }
      return context.call(method, params) as Promise<Value>;
    },
    notify: (method, params) => {
      check();
      const operation = context.call(method, params);
      pending.push(operation);
      void operation.catch(() => {});
    },
    onRequest: () => { throw new ContractError("REGISTRATION_CLOSED", "Handlers must be registered before serving"); },
    start: () => {},
    stop: () => {},
  };
  const conversationId = context.invocation.metadata?.ezConversationId;
  let result: Result | undefined;
  let actionFailed = false;
  let actionError: unknown;
  try {
    result = await active.run(channel, () => withToolContext({ invocation: context.invocation, extensionName: name, callId: context.invocation.token, conversationId: typeof conversationId === "string" ? conversationId : "", projectRoot: "/project", ...(toolName ? { toolName } : {}) }, action));
  } catch (error) {
    actionFailed = true;
    actionError = error;
  } finally { open = false; }
  const notifications = await Promise.allSettled(pending);
  if (actionFailed) throw actionError;
  const failed = notifications.find((notification): notification is PromiseRejectedResult => notification.status === "rejected");
  if (failed) throw failed.reason;
  return result as Result;
}
