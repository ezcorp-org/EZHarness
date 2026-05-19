// ── EventBus ────────────────────────────────────────────────────────

type AnyListener = (...args: unknown[]) => unknown;

export class EventBus<Events extends Record<string, unknown>> {
  private listeners = new Map<string, Set<AnyListener>>();

  on<K extends keyof Events & string>(
    type: K,
    fn: (data: Events[K]) => void,
  ): () => void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn as AnyListener);
    return () => this.off(type, fn);
  }

  off<K extends keyof Events & string>(
    type: K,
    fn: (data: Events[K]) => void,
  ): void {
    this.listeners.get(type)?.delete(fn as AnyListener);
  }

  emit<K extends keyof Events & string>(type: K, data: Events[K]): void {
    for (const fn of this.listeners.get(type) ?? []) {
      try { (fn as (d: Events[K]) => void)(data); } catch { /* listener error must not break emit loop */ }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
