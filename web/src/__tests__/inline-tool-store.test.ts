import { describe, test, expect, beforeEach } from "bun:test";

// Re-implement the store logic without Svelte 5 runes for testability.
interface InlineToolCall {
  id: string;
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
}

class TestInlineToolStore {
  calls: InlineToolCall[] = [];

  add(call: Omit<InlineToolCall, 'status' | 'retryCount'>): void {
    this.calls = [...this.calls, { ...call, status: 'pending', retryCount: 0 }];
  }

  updateFromEvent(invocationId: string, eventType: string, data: Record<string, unknown>): void {
    const idx = this.calls.findIndex(c => c.id === invocationId);
    if (idx < 0) return;

    const call = this.calls[idx]!;
    const updated = [...this.calls];

    switch (eventType) {
      case 'tool:start':
        updated[idx] = { ...call, status: 'running', startedAt: data.timestamp as number };
        break;
      case 'tool:complete':
        updated[idx] = {
          ...call,
          status: 'complete',
          output: typeof data.output === 'string' ? data.output : JSON.stringify(data.output),
          duration: data.duration as number,
        };
        break;
      case 'tool:error':
        updated[idx] = {
          ...call,
          status: 'error',
          error: data.error as string,
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

  remove(id: string): void {
    this.calls = this.calls.filter(c => c.id !== id);
  }
}

function makeCall(overrides: Partial<Omit<InlineToolCall, 'status' | 'retryCount'>> = {}): Omit<InlineToolCall, 'status' | 'retryCount'> {
  return {
    id: overrides.id ?? 'inv-1',
    extensionName: overrides.extensionName ?? 'ext-a',
    toolName: overrides.toolName ?? 'doThing',
    input: overrides.input ?? { foo: 'bar' },
    conversationId: overrides.conversationId ?? 'conv-1',
    messageId: overrides.messageId,
  };
}

describe("inline tool store (IEXT-02)", () => {
  let store: TestInlineToolStore;

  beforeEach(() => {
    store = new TestInlineToolStore();
  });

  test("add() creates call with pending status and retryCount=0", () => {
    store.add(makeCall());
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]!.status).toBe('pending');
    expect(store.calls[0]!.retryCount).toBe(0);
    expect(store.calls[0]!.extensionName).toBe('ext-a');
  });

  test("add() preserves existing calls", () => {
    store.add(makeCall({ id: 'inv-1' }));
    store.add(makeCall({ id: 'inv-2' }));
    expect(store.calls).toHaveLength(2);
    expect(store.calls[0]!.id).toBe('inv-1');
    expect(store.calls[1]!.id).toBe('inv-2');
  });

  test("updateFromEvent() transitions pending->running on tool:start", () => {
    store.add(makeCall());
    store.updateFromEvent('inv-1', 'tool:start', { timestamp: 1000 });
    expect(store.calls[0]!.status).toBe('running');
    expect(store.calls[0]!.startedAt).toBe(1000);
  });

  test("updateFromEvent() transitions running->complete on tool:complete", () => {
    store.add(makeCall());
    store.updateFromEvent('inv-1', 'tool:start', { timestamp: 1000 });
    store.updateFromEvent('inv-1', 'tool:complete', { output: 'done', duration: 250 });
    expect(store.calls[0]!.status).toBe('complete');
    expect(store.calls[0]!.output).toBe('done');
    expect(store.calls[0]!.duration).toBe(250);
  });

  test("updateFromEvent() transitions running->error on tool:error", () => {
    store.add(makeCall());
    store.updateFromEvent('inv-1', 'tool:start', { timestamp: 1000 });
    store.updateFromEvent('inv-1', 'tool:error', { error: 'boom', duration: 100 });
    expect(store.calls[0]!.status).toBe('error');
    expect(store.calls[0]!.error).toBe('boom');
    expect(store.calls[0]!.duration).toBe(100);
    expect(store.calls[0]!.retryCount).toBe(1);
  });

  test("updateFromEvent() is no-op for unknown invocationId", () => {
    store.add(makeCall());
    store.updateFromEvent('unknown-id', 'tool:start', { timestamp: 1000 });
    expect(store.calls[0]!.status).toBe('pending');
  });

  test("updateFromEvent() handles object output by JSON.stringifying", () => {
    store.add(makeCall());
    store.updateFromEvent('inv-1', 'tool:complete', { output: { key: 'value' }, duration: 50 });
    expect(store.calls[0]!.output).toBe('{"key":"value"}');
  });

  test("getByConversation() filters calls by conversationId", () => {
    store.add(makeCall({ id: 'inv-1', conversationId: 'conv-1' }));
    store.add(makeCall({ id: 'inv-2', conversationId: 'conv-2' }));
    store.add(makeCall({ id: 'inv-3', conversationId: 'conv-1' }));
    const filtered = store.getByConversation('conv-1');
    expect(filtered).toHaveLength(2);
    expect(filtered.map(c => c.id)).toEqual(['inv-1', 'inv-3']);
  });

  test("getById() returns correct call or undefined", () => {
    store.add(makeCall({ id: 'inv-1' }));
    store.add(makeCall({ id: 'inv-2' }));
    expect(store.getById('inv-2')!.id).toBe('inv-2');
    expect(store.getById('nonexistent')).toBeUndefined();
  });

  test("remove() deletes call from store", () => {
    store.add(makeCall({ id: 'inv-1' }));
    store.add(makeCall({ id: 'inv-2' }));
    store.remove('inv-1');
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]!.id).toBe('inv-2');
  });

  test("remove() is no-op for unknown id", () => {
    store.add(makeCall({ id: 'inv-1' }));
    store.remove('unknown');
    expect(store.calls).toHaveLength(1);
  });

  test("multiple sequential error events increment retryCount correctly", () => {
    store.add(makeCall());
    store.updateFromEvent('inv-1', 'tool:start', { timestamp: 1000 });
    store.updateFromEvent('inv-1', 'tool:error', { error: 'fail-1', duration: 50 });
    expect(store.calls[0]!.retryCount).toBe(1);
    store.updateFromEvent('inv-1', 'tool:error', { error: 'fail-2', duration: 60 });
    expect(store.calls[0]!.retryCount).toBe(2);
    store.updateFromEvent('inv-1', 'tool:error', { error: 'fail-3', duration: 70 });
    expect(store.calls[0]!.retryCount).toBe(3);
  });
});
