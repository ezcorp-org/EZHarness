import { describe, expect, test } from "vitest";
import { resolve } from "node:path";
import { loadConfigFromFile, resolveConfig } from "vite";

describe("Vite SSR warmup", () => {
	test("configures the hooks entry to warm with SSR server startup", async () => {
		const root = resolve(import.meta.dirname, "../..");
		const loaded = await loadConfigFromFile(
			{ command: "serve", mode: "development" },
			resolve(root, "vite.config.ts"),
			root,
		);
		expect(loaded).not.toBeNull();
		const config = await resolveConfig(loaded!.config, "serve", "development");

		expect(config.server.warmup.ssrFiles).toContain("./src/hooks.server.ts");
		expect(config.environments.ssr.dev.warmup).toContain("./src/hooks.server.ts");
		expect(config.environments.ssr.dev.preTransformRequests).toBe(true);
	});
});
