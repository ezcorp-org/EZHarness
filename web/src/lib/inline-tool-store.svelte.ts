export interface InlineToolCall {
  id: string;              // client-generated invocationId
  extensionName: string;
  toolName: string;
  input: Record<string, unknown>;
  status: 'pending' | 'running' | 'complete' | 'error';
  output?: string;
  error?: string;
  retryCount: number;
  startedAt?: number;
  duration?: number;
  conversationId: string;
  messageId?: string;
  cardType?: string;
  /** "inline" | "dock" — the chat UI's DockHost reads this to decide
   *  whether to auto-open a docked card on completion. NULL/undefined
   *  is treated as "inline" by `shouldRenderInDock` (utils.ts). */
  cardLayout?: 'inline' | 'dock';
  /**
   * Where this entry came from:
   *   'inline'    — user-initiated invocation from the client (default).
   *                 Renders as an unanchored card until a messageId arrives.
   *   'agent-run' — streamed from an agent-run tool event. NEVER renders as
   *                 an unanchored card — it's already shown inside its
   *                 streaming message bubble (via streamingToolCalls) and the
   *                 Diff Summary panel (via the conversationId bucket).
   *                 On hydration the persisted row replaces it.
   */
  source?: 'inline' | 'agent-run';
}

function stringifyError(value: unknown): string {
  if (typeof value === 'string') return value;
  // Handle ToolCallResult shape: { content: [{ type: "text", text: "..." }] }
  if (value && typeof value === 'object' && 'content' in value && Array.isArray((value as any).content)) {
    const texts = (value as any).content
      .filter((c: any) => c.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text);
    if (texts.length > 0) return texts.join('\n');
  }
  return JSON.stringify(value);
}

class InlineToolStore {
  calls = $state<InlineToolCall[]>([]);

  add(call: Omit<InlineToolCall, 'status' | 'retryCount'>): void {
    this.calls = [...this.calls, { ...call, status: 'pending', retryCount: 0 }];
  }

  updateFromEvent(invocationId: string, eventType: string, data: Record<string, unknown>): void {
    const idx = this.calls.findIndex(c => c.id === invocationId);
    if (idx < 0) return;

    const call = this.calls[idx]!;
    const updated = [...this.calls];

    switch (eventType) {
      case 'tool:start': {
        const startUpdate: Partial<InlineToolCall> = { status: 'running', startedAt: data.timestamp as number };
        if (data.cardType) startUpdate.cardType = data.cardType as string;
        if (data.cardLayout === 'dock' || data.cardLayout === 'inline') {
          startUpdate.cardLayout = data.cardLayout as 'inline' | 'dock';
        }
        updated[idx] = { ...call, ...startUpdate };
        break;
      }
      case 'tool:complete': {
        const completeUpdate: Partial<InlineToolCall> = {
          status: 'complete',
          output: stringifyError(data.output),
          duration: data.duration as number,
        };
        if (data.cardType) completeUpdate.cardType = data.cardType as string;
        if (data.cardLayout === 'dock' || data.cardLayout === 'inline') {
          completeUpdate.cardLayout = data.cardLayout as 'inline' | 'dock';
        }
        updated[idx] = { ...call, ...completeUpdate };
        break;
      }
      case 'tool:error':
        updated[idx] = {
          ...call,
          status: 'error',
          error: stringifyError(data.error),
          duration: data.duration as number,
          retryCount: call.retryCount + 1,
        };
        break;
    }

    this.calls = updated;
  }

  getByConversation(conversationId: string): InlineToolCall[] {
    return this.calls.filter(c => c.conversationId === conversationId);
  }

  getById(id: string): InlineToolCall | undefined {
    return this.calls.find(c => c.id === id);
  }

  getByMessage(messageId: string): InlineToolCall[] {
    return this.calls.filter(c => c.messageId === messageId);
  }

  remove(id: string): void {
    this.calls = this.calls.filter(c => c.id !== id);
  }

  /**
   * Insert-or-update a streaming tool call by id. Called from the SSE event
   * handler whenever a non-inline tool:start / :complete / :error arrives
   * with a stable invocationId — this keeps the Diff Summary panel in sync
   * live without needing an HTTP refetch. Fields passed in the partial merge
   * shallowly, so repeated calls can walk the status from running → complete.
   *
   * On a subsequent `hydrateToolCalls(convId, …)` (e.g. after page reload),
   * the DB replacement semantics win: any streamed entry is removed and the
   * persistent row takes over. Because the executor now persists tool_calls
   * with id = event.toolCallId, the DB row ends up with the same id as the
   * streamed entry — no duplicates.
   */
  upsertStreaming(entry: {
    id: string;
    conversationId: string;
    extensionName: string;
    toolName: string;
    /** Required on first insert (tool:start). Omit on subsequent updates so
     *  the entry's existing input is preserved when tool:complete arrives
     *  (the complete event doesn't carry input). */
    input?: Record<string, unknown>;
    status: InlineToolCall['status'];
    startedAt?: number;
    duration?: number;
    output?: string;
    error?: string;
    cardType?: string;
    cardLayout?: 'inline' | 'dock';
    messageId?: string;
    /** Defaults to 'agent-run' since this path is only called by the SSE
     *  event handler for non-inline tool events. */
    source?: InlineToolCall['source'];
  }): void {
    const idx = this.calls.findIndex(c => c.id === entry.id);
    if (idx < 0) {
      this.calls = [...this.calls, {
        retryCount: 0,
        input: entry.input ?? {},
        source: 'agent-run',
        ...entry,
      }];
      return;
    }
    const existing = this.calls[idx]!;
    const next = [...this.calls];
    // Spread existing first, then entry — but drop entry.input when it's
    // undefined so we don't clobber a previously-captured input.
    const { input: entryInput, ...entryRest } = entry;
    next[idx] = {
      ...existing,
      ...entryRest,
      ...(entryInput !== undefined ? { input: entryInput } : {}),
    };
    this.calls = next;
  }

  /**
   * Hydrate historical tool calls from API response.
   * Replaces any existing calls for this conversation with DB-backed state.
   */
  hydrateToolCalls(conversationId: string, toolCalls: Array<{
    id: string;
    extensionId: string;
    toolName: string;
    input: Record<string, unknown> | null;
    outputSummary: string | null;
    success: boolean;
    durationMs: number;
    status: "success" | "error" | "interrupted";
    messageId?: string;
    cardType?: string | null;
    cardLayout?: string | null;
    fullOutput?: string | null;
  }>): void {
    // Remove existing calls for this conversation (streaming ones get replaced by DB state)
    const otherCalls = this.calls.filter(c => c.conversationId !== conversationId);
    const hydrated: InlineToolCall[] = toolCalls.map(tc => ({
      id: tc.id,
      extensionName: tc.extensionId,
      toolName: tc.toolName,
      input: tc.input ?? {},
      status: tc.status === "interrupted" ? "error" as const
        : tc.status === "error" ? "error" as const
        : "complete" as const,
      output: tc.fullOutput ?? tc.outputSummary ?? undefined,
      error: tc.status === "interrupted" ? "interrupted"
        : tc.status === "error" ? "Error" : undefined,
      retryCount: 0,
      duration: tc.durationMs,
      conversationId,
      messageId: tc.messageId,
      cardType: tc.cardType ?? undefined,
      cardLayout: tc.cardLayout === 'dock' ? 'dock' as const : tc.cardLayout === 'inline' ? 'inline' as const : undefined,
    }));
    this.calls = [...otherCalls, ...hydrated];
  }
}

export const inlineToolStore = new InlineToolStore();
