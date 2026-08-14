/**
 * Phase 52.1 — server loader test for `/extensions` +page.server.ts.
 *
 * Verifies the loader fans out two `listExtensions` calls (one for
 * bundled, one for installed) and returns a `{bundledExtensions,
 * installedExtensions}` shape the page consumes via `data`.
 *
 * Run under vitest (the server-test suite) — `bun test` skips
 * `*.server.test.ts` because vitest gates the SvelteKit `$server`
 * alias resolution on its plugin.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/extensions", () => ({
	listExtensions: vi.fn(),
}));

const { listExtensions } = await import("$server/db/queries/extensions");
const { load } = await import(
	"../routes/(app)/extensions/+page.server.ts"
);

describe("/extensions +page.server.ts", () => {
	beforeEach(() => {
		vi.mocked(listExtensions).mockReset();
	});

	test("fans out bundled + installed lists in parallel", async () => {
		// Two sentinel arrays — verify each ends up in the right slot
		// without trusting array order.
		vi.mocked(listExtensions).mockImplementation(async (opts) => {
			if (typeof opts === "object" && opts && "bundled" in opts && opts.bundled === true) {
				return [{ id: "b1", isBundled: true } as any];
			}
			return [{ id: "i1", isBundled: false } as any];
		});

		const result = (await load({} as any)) as {
			bundledExtensions: { id: string; isBundled: boolean }[];
			installedExtensions: { id: string; isBundled: boolean }[];
		};
		// `isCritical` is attached by the shared mapper so the SSR first paint
		// and the post-mutation `/api/extensions` re-fetch render the same
		// card. These sentinels have no `name`, so neither is critical.
		expect(result.bundledExtensions).toEqual([
			{ id: "b1", isBundled: true, isCritical: false },
		]);
		expect(result.installedExtensions).toEqual([
			{ id: "i1", isBundled: false, isCritical: false },
		]);
		expect(vi.mocked(listExtensions)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(listExtensions)).toHaveBeenCalledWith({ bundled: true });
		expect(vi.mocked(listExtensions)).toHaveBeenCalledWith({ bundled: false });
	});

	test("a real critical name arrives flagged from the SSR loader too", async () => {
		// The sentinels above are nameless, so both sides come back
		// `isCritical: false` and the mapper could be deleted unnoticed. The
		// SSR paint and the client re-fetch must agree, or the confirm step
		// appears only after the first `loadExtensions()`.
		vi.mocked(listExtensions).mockImplementation(async (opts) => {
			const bundled = typeof opts === "object" && opts && "bundled" in opts && opts.bundled === true;
			return bundled
				? ([{ id: "b1", name: "ask-user", isBundled: true }] as any)
				: ([{ id: "i1", name: "some-user-extension", isBundled: false }] as any);
		});

		const result = (await load({} as any)) as {
			bundledExtensions: Array<Record<string, unknown>>;
			installedExtensions: Array<Record<string, unknown>>;
		};

		expect(result.bundledExtensions[0]).toMatchObject({ name: "ask-user", isCritical: true });
		expect(typeof result.bundledExtensions[0]!.criticalConsequence).toBe("string");
		expect(result.installedExtensions[0]).toMatchObject({ isCritical: false });
	});

	test("issue #205 — an MCP row's credentials never reach the SSR page data", async () => {
		// This loader serialises its result into the first-paint HTML for ANY
		// authenticated user, with no role gate. The client re-fetch through
		// GET /api/extensions has always been scrubbed; the SSR paint was not.
		// `redactExtensionSecrets` is imported from the PURE classifier module,
		// so this test runs the real redaction while every query is mocked.
		vi.mocked(listExtensions).mockImplementation(async (opts) => {
			const bundled = typeof opts === "object" && opts && "bundled" in opts && opts.bundled === true;
			if (bundled) return [] as any;
			return [
				{
					id: "mcp-1",
					name: "leaky-mcp",
					isBundled: false,
					manifest: {
						kind: "mcp",
						name: "leaky-mcp",
						tools: [],
						permissions: {},
						mcpServers: [
							{
								transport: "http",
								name: "leaky-mcp",
								url: "https://mcp.vendor.com/mcp?api_key=SSR-URL-LEAK",
								headers: { Authorization: "Bearer SSR-HDR-LEAK" },
							},
							{
								transport: "stdio",
								name: "leaky-stdio",
								command: "npx",
								args: ["-y", "srv", "--token=SSR-ARGV-LEAK"],
							},
						],
					},
				},
			] as any;
		});

		const result = (await load({} as any)) as { installedExtensions: unknown[] };
		const payload = JSON.stringify(result);
		expect(payload).not.toContain("SSR-URL-LEAK");
		expect(payload).not.toContain("SSR-HDR-LEAK");
		expect(payload).not.toContain("SSR-ARGV-LEAK");
		// The names survive so the connection panel still lists them.
		expect(payload).toContain("api_key=");
		expect(payload).toContain("--token=");
	});

	test("returns empty arrays when no extensions exist (no error path)", async () => {
		vi.mocked(listExtensions).mockResolvedValue([] as any);
		const result = (await load({} as any)) as {
			bundledExtensions: unknown[];
			installedExtensions: unknown[];
		};
		expect(result.bundledExtensions).toEqual([]);
		expect(result.installedExtensions).toEqual([]);
	});

	test("soft-fails to empty arrays when DB throws (SSR-resilient)", async () => {
		vi.mocked(listExtensions).mockRejectedValue(new Error("ECONNREFUSED"));
		const result = (await load({} as any)) as {
			bundledExtensions: unknown[];
			installedExtensions: unknown[];
		};
		// SSR is an enhancement; the client-side loadExtensions() will
		// re-fetch and surface the failure as a toast. Crucially this
		// does NOT throw — that would 500 the whole page.
		expect(result.bundledExtensions).toEqual([]);
		expect(result.installedExtensions).toEqual([]);
	});
});
