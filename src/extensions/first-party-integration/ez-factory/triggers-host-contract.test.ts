import { test, expect } from "bun:test";
import { HOST_TRIGGER_KEY_RE, FIRE_REFUSAL_TABLE } from "../../../../extensions/ez-factory/lib/triggers";

  test("MIRROR CHECK: the host's own key regex, byte for byte", async () => {
    // The one thing a mirrored constant can get wrong is BEING a mirror.
    // Read the host's source rather than importing it — importing
    // `src/extensions/**` from a sandboxed module is what this mirror
    // exists to avoid.
    const source = await Bun.file(
      new URL("../../triggers-store.ts", import.meta.url),
    ).text();
    const match = source.match(/export const TRIGGER_KEY_RE = (\/.*\/);/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(String(HOST_TRIGGER_KEY_RE));
  });

  test("COVERAGE OF THE HOST'S VOCABULARY: every delegated deny code is in the table", async () => {
    // The table is only a legibility control if it covers what the host
    // can actually say. Read the deny-reason union out of the handler's
    // source; a new code lands here as a named failure rather than as a
    // job that silently reads "unrecognised".
    const source = await Bun.file(
      new URL("../../workflows-handler.ts", import.meta.url),
    ).text();
    const union = source.slice(
      source.indexOf("export type WorkflowTriggerDenyReason"),
      source.indexOf("export interface WorkflowsHandlerContext"),
    );
    const codes = [...union.matchAll(/\|\s*"(DELEGATION_[A-Z_]+)"/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(10);
    const missing = codes.filter((c) => FIRE_REFUSAL_TABLE[c] === undefined);
    expect(missing).toEqual([]);
  });
