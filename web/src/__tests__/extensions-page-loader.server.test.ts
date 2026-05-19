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
		expect(result.bundledExtensions).toEqual([{ id: "b1", isBundled: true }]);
		expect(result.installedExtensions).toEqual([{ id: "i1", isBundled: false }]);
		expect(vi.mocked(listExtensions)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(listExtensions)).toHaveBeenCalledWith({ bundled: true });
		expect(vi.mocked(listExtensions)).toHaveBeenCalledWith({ bundled: false });
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
