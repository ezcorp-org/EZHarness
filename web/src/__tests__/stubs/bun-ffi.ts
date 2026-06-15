/**
 * Test-only stub for the `bun:ffi` builtin.
 *
 * The server-context import chain (route handler → `src/extensions/subprocess`
 * → `sandbox/capability-probe` → `sandbox/landlock-ffi`) statically imports
 * `bun:ffi`. Under vitest's jsdom environment that module is evaluated on
 * Node, where the Bun builtin does not exist — Vite first tries to BUNDLE it
 * (hard error) and, once externalized, Node can't resolve it. This stub is
 * aliased in `vitest.config.ts` so the chain LOADS.
 *
 * It only needs to satisfy module-load-time references: `landlock-ffi.ts`
 * reads `FFIType` (member access for symbol arg/return types) and the type
 * `ReturnType<typeof dlopen<…>>`. The functions are NEVER called in these
 * tests — the real Landlock jail is applied only inside the sandboxed
 * pre-exec shim at runtime, and the ABI probe (`landlockAbiVersion`) is not
 * exercised by any route-handler test. If anything DOES call them, we throw
 * loudly rather than silently no-op, so a future test that needs real FFI
 * fails fast instead of getting bogus behaviour.
 */

const unavailable = (name: string) => (): never => {
	throw new Error(
		`bun:ffi stub: ${name}() is not available under vitest (jsdom). ` +
			"This code path must not run in a non-Bun test environment.",
	);
};

export const dlopen = unavailable("dlopen") as unknown as (
	...args: unknown[]
) => never;
export const ptr = unavailable("ptr") as unknown as (...args: unknown[]) => never;
export const toArrayBuffer = unavailable("toArrayBuffer") as unknown as (
	...args: unknown[]
) => never;

/**
 * Minimal `FFIType` enum surface. `landlock-ffi.ts` references the members
 * used in its symbol table (i64, i32, ptr, cstring) at module-eval time, so
 * they must exist as plain values.
 */
export const FFIType = {
	i8: 1,
	i16: 2,
	i32: 3,
	i64: 4,
	u8: 5,
	u16: 6,
	u32: 7,
	u64: 8,
	f32: 9,
	f64: 10,
	ptr: 11,
	cstring: 12,
	bool: 13,
	void: 14,
} as const;
