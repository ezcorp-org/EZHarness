import { expect, test } from "bun:test";
import { verifyExtension } from "../extensions/sdk/verify";
import { buildVerifyFixture } from "./helpers/verify-fixtures";

for (const [name, options] of Object.entries({
  valid: {},
  malformed: { rawConfig: "export default 42;" },
  missingSmoke: { smokeTest: null },
  toolError: { pingErrors: true },
  wrongExpectation: { smokeTest: { tool: "ping", input: {}, expect: { textIncludes: "missing" } } },
  missingTool: { smokeTest: { tool: "undeclared", input: {}, expect: {} } },
})) {
  test(`legacy verification refuses ${name} without running config or tools`, async () => {
    const fixture = buildVerifyFixture(options);
    const marker = `${fixture.dir}/executed`;
    const original = await Bun.file(`${fixture.dir}/ezcorp.config.ts`).text();
    await Bun.write(`${fixture.dir}/ezcorp.config.ts`, `await Bun.write(${JSON.stringify(marker)}, "executed");\n${original}`);
    try {
      const result = await verifyExtension({ extDir: fixture.dir });
      expect(result.pass).toBe(false);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toMatchObject({ name: "load-manifest", ok: false });
      expect(result.steps[0]!.detail).toMatch(/workspace.*build.*inspect.*human approval/);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally { fixture.cleanup(); }
  });
}
test("legacy verification refuses missing source rather than claiming acceptance", async () => {
  expect((await verifyExtension({ extDir: "/missing-extension" })).pass).toBe(false);
});
