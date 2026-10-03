import { join } from "node:path";
import { makeFsRpcHandler } from "@ezcorp/sdk/test";
import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";

interface Message { id: string; role: string; content: string }

/** Host-side RPC fixture for both real sample-loop subprocess tests. */
export function sampleLoopHost(root: string, summary: string, model: string, messages: Message[]) {
  const kv = new Map<string, unknown>();
  const index = Promise.withResolvers<void>();
  const artifact = Promise.withResolvers<void>();
  const whenComplete = Promise.all([index.promise, artifact.promise]);
  const summariesDir = join(root, ".ezcorp", "extension-data", "summarize", "summaries");
  const fsHandler = makeFsRpcHandler(root);
  const ok = (id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

  const handleRequest = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    if (req.method === "ezcorp/storage") {
      const key = params.key as string;
      if (params.action === "get") return ok(req.id, kv.has(key) ? { value: kv.get(key), exists: true } : { value: null, exists: false });
      if (params.action === "set") {
        kv.set(key, JSON.parse(JSON.stringify(params.value)));
        if (key === "loop:summarize:index" && Array.isArray(kv.get(key)) && (kv.get(key) as unknown[]).length > 0) index.resolve();
        return ok(req.id, { ok: true, sizeBytes: 0 });
      }
      if (params.action === "delete") return ok(req.id, { deleted: kv.delete(key) });
      if (params.action === "list") return ok(req.id, { keys: [...kv.keys()].filter((item) => item.startsWith((params.prefix as string) ?? "")) });
      return ok(req.id, { ok: true });
    }
    if (req.method === "ezcorp/llm-complete") {
      return ok(req.id, { content: summary, blocks: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop", model });
    }
    if (req.method === "ezcorp/invoke") {
      if (params.tool === "runtime.conversations.getMessages") return ok(req.id, { messages, projectId: "p1" });
      if (params.tool === "runtime.settings.getMine") return ok(req.id, { enabled: true });
      return ok(req.id, {});
    }
    const fsResult = fsHandler(req);
    if (fsResult) {
      if (req.method === "ezcorp/fs.write" && typeof params.path === "string" && params.path.startsWith(`${summariesDir}/`)) {
        if (fsResult.error) artifact.reject(new Error(fsResult.error.message));
        else artifact.resolve();
      }
      return fsResult;
    }
    return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no: ${req.method}` } };
  };

  return { kv, handleRequest, whenComplete };
}
