/**
 * Shared auto-save feedback state for the settings pages (locked
 * decision 5): single-control settings save on change and flash an
 * inline "Saved ✓" confirmation.
 *
 * Usage:
 *   const flash = createSaveFlash();
 *   const ok = await flash.run(() => upsertSetting(key, value));
 *   if (!ok) restoreSnapshot(); // roll back the optimistic mutation
 *   // flash.saving while in flight, flash.saved for `timeoutMs` after,
 *   // flash.error after a failed save (until the next run starts)
 */
export interface SaveFlash {
	readonly saving: boolean;
	readonly saved: boolean;
	readonly error: boolean;
	/** Resolves true on success, false on failure (never rethrows). */
	run(fn: () => Promise<unknown>): Promise<boolean>;
}

export function createSaveFlash(timeoutMs = 2000): SaveFlash {
	let saving = $state(false);
	let saved = $state(false);
	let error = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	return {
		get saving() {
			return saving;
		},
		get saved() {
			return saved;
		},
		get error() {
			return error;
		},
		async run(fn: () => Promise<unknown>): Promise<boolean> {
			saving = true;
			saved = false;
			error = false;
			if (timer) clearTimeout(timer);
			try {
				await fn();
				saved = true;
				timer = setTimeout(() => {
					saved = false;
				}, timeoutMs);
				return true;
			} catch {
				// Surface via the error state — callers roll back their
				// optimistic mutation on `false`; the control itself is
				// the retry affordance.
				error = true;
				return false;
			} finally {
				saving = false;
			}
		},
	};
}
