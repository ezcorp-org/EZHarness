import { expect, test } from "bun:test";
import { join } from "node:path";

const dockerfile = await Bun.file(join(import.meta.dir, "..", "..", "Dockerfile")).text();

test("production image builds and ships the harness-client workspace used by the web server", () => {
  expect(dockerfile).toContain("bun run --cwd packages/@ezcorp/harness-client build");
  expect(dockerfile).toContain("COPY --from=builder /app/packages/@ezcorp/harness-client/src ./packages/@ezcorp/harness-client/src");
  expect(dockerfile).toContain("COPY --from=builder /app/packages/@ezcorp/harness-client/dist ./packages/@ezcorp/harness-client/dist");
});
