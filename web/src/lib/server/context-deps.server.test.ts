/**
 * `context-deps.ts` is the server graph that `context.ts` loads on its first initialization. This loads the real
 * graph (a static import, so its cost is paid while the file is collected and not inside a test's budget) and checks
 * that it exports exactly the names `context.ts` takes from it, each one defined.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { serverGraph } from "./context-deps";

/** Every name that `context.ts` destructures from `await loadServerGraph()`. */
function namesTakenByContext(): string[] {
  const source = readFileSync(resolve(process.cwd(), "src/lib/server/context.ts"), "utf8");
  const names = [...source.matchAll(/const \{([^}]*)\}\s*=\s*await loadServerGraph\(\)/g)].flatMap(([, list]) =>
    list.split(",").map((name) => name.trim()).filter(Boolean),
  );
  return [...new Set(names)].sort();
}

describe("context server graph", () => {
  it("exports exactly the names the context takes, each one defined", () => {
    const taken = namesTakenByContext();
    expect(taken.length).toBeGreaterThan(30);
    expect(Object.keys(serverGraph).sort()).toEqual(taken);
    expect(taken.filter((name) => serverGraph[name as keyof typeof serverGraph] === undefined)).toEqual([]);
  });
});
