import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The one reader for the committed C02 and guest model conformance fixtures.
 *
 * Two suites compare the Bun validator with the Python one — the host process
 * lane and the isolated Podman guest lane — and both must patch the same base
 * with the same values. Reading and resolving the fixtures here is what keeps
 * those two lanes from drifting into different inputs and still both passing.
 */

export type FactoryConformanceKind = "request" | "result" | "guest-model-request" | "guest-model-response";

export interface FactoryConformanceSuccess {
  readonly name: string;
  readonly kind: FactoryConformanceKind;
  readonly value: unknown;
}

/** A rejection, resolved: the base already patched with the offending value. */
export interface FactoryConformanceRejection {
  readonly name: string;
  readonly kind: FactoryConformanceKind;
  readonly value: unknown;
}

type Generated =
  | { readonly kind: "text"; readonly unit: string; readonly times: number }
  | { readonly kind: "messages"; readonly count: number; readonly length: number };

interface RawRejection {
  readonly name: string;
  readonly kind: FactoryConformanceKind;
  /** Which success fixture to patch. The first of the same kind when absent. */
  readonly from?: string;
  readonly path: (string | number)[];
  readonly value?: unknown;
  /**
   * A value too large to commit literally. A byte bound can only be crossed by
   * crossing it, and a 140 KB run of one character in a committed fixture
   * hides the case it is testing.
   */
  readonly generate?: Generated;
}

interface RawFixture {
  readonly success: FactoryConformanceSuccess[];
  readonly rejected: RawRejection[];
}

function generated(shape: Generated): unknown {
  if (shape.kind === "text") return shape.unit.repeat(shape.times);
  return Array.from({ length: shape.count }, (_entry, index) => ({ role: "user", text: `${index}`.padEnd(shape.length, "z") }));
}

function patched(base: unknown, path: (string | number)[], value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  let target = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
  target[path.at(-1)!] = value;
  return copy;
}

export interface FactoryConformanceFixtures {
  readonly success: readonly FactoryConformanceSuccess[];
  readonly rejected: readonly FactoryConformanceRejection[];
}

export async function loadFactoryConformanceFixtures(directory: string): Promise<FactoryConformanceFixtures> {
  const raw = JSON.parse(await readFile(join(directory, "c02-conformance.json"), "utf8")) as RawFixture;
  const rejected = raw.rejected.map((item) => {
    const base = item.from
      ? raw.success.find((entry) => entry.name === item.from)
      : raw.success.find((entry) => entry.kind === item.kind);
    if (!base) throw new Error(`C02 conformance fixture ${item.name} names no base to patch.`);
    return { name: item.name, kind: item.kind, value: patched(base.value, item.path, item.generate ? generated(item.generate) : item.value) };
  });
  return { success: raw.success, rejected };
}
