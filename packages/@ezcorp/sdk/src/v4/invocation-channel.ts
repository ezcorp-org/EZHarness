import { AsyncLocalStorage } from "node:async_hooks";
import { posix } from "node:path";
import { ContractError } from "@ezcorp/extension-contract";
import type { HostChannel } from "../runtime/channel";
import { withToolContext } from "../runtime/tool-context";
import type { ExtensionContext } from "./index";

const active = new AsyncLocalStorage<HostChannel>();
export function getInvocationChannel(): HostChannel | undefined { return active.getStore(); }

export async function withInvocationChannel<Result>(name: string, context: ExtensionContext, toolName: string | undefined, action: (context: ExtensionContext) => Result | Promise<Result>): Promise<Result> {
  const pending: Array<{ operation: Promise<unknown>; propagateFailure: boolean }> = [];
  let open = true;
  function check(): void {
    if (!open) throw new ContractError("NO_INVOCATION", "Host capabilities require an active invocation");
    context.signal.throwIfAborted();
  }
  function admit(method: string, params: unknown, propagateFailure = false): Promise<unknown> {
    check();
    const operation = context.call(method, params);
    pending.push({ operation, propagateFailure });
    void operation.catch(() => {});
    return operation;
  }
  const invocationContext: ExtensionContext = Object.freeze({
    ...context,
    call: async (method: string, params: unknown) => await admit(method, params),
  });
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
      return invocationContext.call(method, params) as Promise<Value>;
    },
    notify: (method, params) => {
      void admit(method, params, true);
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
    result = await active.run(channel, () => withToolContext({ invocation: context.invocation, extensionName: name, callId: context.invocation.token, conversationId: typeof conversationId === "string" ? conversationId : "", projectRoot: "/project", ...(toolName ? { toolName } : {}) }, () => action(invocationContext)));
  } catch (error) {
    actionFailed = true;
    actionError = error;
  } finally { open = false; }
  const settled = await Promise.allSettled(pending.map(entry => entry.operation));
  if (actionFailed) throw actionError;
  const failedNotification = settled.find((outcome, index): outcome is PromiseRejectedResult =>
    pending[index]?.propagateFailure === true && outcome.status === "rejected");
  if (failedNotification) throw failedNotification.reason;
  return result as Result;
}
