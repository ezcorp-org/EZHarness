import { json } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import type { LifecycleActor } from "$server/extensions/v4/types";
import { extensionControlError } from "./control-errors";

export async function mcpControlRequest(locals: Parameters<typeof requireSessionAuth>[0], request: Request | null, action: (actor: LifecycleActor, body: unknown) => Promise<unknown>): Promise<Response> {
  const user = requireSessionAuth(locals);
  if (user instanceof Response) return user;
  if (user.role !== "admin") return json({ code: "forbidden", message: "Administrator session required" }, { status: 403 });
  try {
    let body: unknown = {};
    if (request) {
      if (!request.body) return json({ code: "invalid_input" }, { status: 400 });
      const reader = request.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "";
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 65_536) { await reader.cancel(); return json({ code: "body_limit" }, { status: 413 }); }
          try { text += decoder.decode(part.value, { stream: true }); }
          catch { throw new SyntaxError("Request body must be valid UTF-8"); }
        }
        try { text += decoder.decode(); }
        catch { throw new SyntaxError("Request body must be valid UTF-8"); }
      } finally { reader.releaseLock(); }
      body = JSON.parse(text);
    }
    return json(await action({ principalId: user.id, scope: "global", kind: "human" }, body), { status: 202 });
  } catch (error) { return extensionControlError(error); }
}
