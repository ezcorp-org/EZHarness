// Shared test helper: capture frames written by the production HostChannel.
//
// The production singleton (createProductionChannel() in runtime/channel.ts)
// writes JSON-RPC frames through `Bun.stdout.writer()` (a FileSink) — NOT
// `process.stdout.write`. It does so deliberately to survive the Phase 3
// sandbox-preload fs poisoning. Any test that drives a real frame through
// `getChannel()` must therefore spy on `Bun.stdout.writer` and read the fake
// sink's captured writes; spying on `process.stdout.write` never fires and the
// test's poll loop times out.
import { spyOn } from "bun:test";

export function spyOnStdoutWriter(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const sink = {
    write(s: string | ArrayBufferView | ArrayBuffer): number {
      writes.push(typeof s === "string" ? s : new TextDecoder().decode(s as unknown as Uint8Array));
      return 0;
    },
    flush(): number | Promise<number> {
      return 0;
    },
    end(): number | Promise<number> {
      return 0;
    },
  } as unknown as ReturnType<typeof Bun.stdout.writer>;
  const spy = spyOn(Bun.stdout, "writer").mockImplementation(() => sink);
  return { writes, restore: () => spy.mockRestore() };
}
