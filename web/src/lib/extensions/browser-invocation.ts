type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type BrowserIdentity = { binding: string; conversationId: string };

export class BrowserCancellationUnconfirmed extends Error {
  constructor() { super("Cancellation could not be confirmed. The tool may still finish an action already in progress."); }
}

export class BrowserAuthorityChanged extends Error {
  constructor() { super("Preview access changed. Reload before continuing."); }
}

export async function invokeBrowserTool(fetcher: Fetcher, endpoint: string, identity: BrowserIdentity, tool: { toolName: string; input: Record<string, unknown> }, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const post = (body: Record<string, unknown>, options: RequestInit = {}) => fetcher(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...identity, ...body }), ...options });
  const prepared = await post({ method: "prepare", ...tool }, { signal: AbortSignal.timeout(10000) });
  if (prepared.status === 403 || prepared.status === 404) throw new BrowserAuthorityChanged();
  if (!prepared.ok) throw new Error("Preview request could not be prepared");
  const ticket: unknown = await prepared.json();
  if (!ticket || typeof ticket !== "object" || !("requestId" in ticket) || typeof ticket.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(ticket.requestId) || !("installationId" in ticket) || typeof ticket.installationId !== "string" || !ticket.installationId || ticket.installationId.length > 128) throw new Error("Invalid preview request ticket");
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= post({ method: "cancel", requestId: ticket.requestId, installationId: ticket.installationId }, { keepalive: true, signal: AbortSignal.timeout(5000) }).then(async response => {
      if (!response.ok) throw new BrowserCancellationUnconfirmed();
      const result = await response.json();
      if (!result || !["cancel_requested", "cancelled", "finished", "outcome_unknown"].includes(result.state)) throw new BrowserCancellationUnconfirmed();
    }).catch(() => { throw new BrowserCancellationUnconfirmed(); });
    return cancellation;
  };
  const abort = () => { void cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const response = await post({ method: "tool.invoke", requestId: ticket.requestId, ...tool }, { signal });
    if (response.status === 403 || response.status === 404) throw new BrowserAuthorityChanged();
    if (!response.ok) throw new Error("Preview request failed");
    return await response.json();
  } finally {
    signal.removeEventListener("abort", abort);
    if (signal.aborted) await cancel();
  }
}
