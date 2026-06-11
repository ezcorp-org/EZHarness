/**
 * Shared auto-save feedback state for the settings pages (locked
 * decision 5): single-control settings save on change and flash an
 * inline "Saved ✓" confirmation.
 *
 * Usage:
 *   const flash = createSaveFlash();
 *   await flash.run(() => upsertSetting(key, value));
 *   // flash.saving while in flight, flash.saved for `timeoutMs` after
 */
export interface SaveFlash {
	readonly saving: boolean;
	readonly saved: boolean;
	run(fn: () => Promise<unknown>): Promise<void>;
}

export function createSaveFlash(timeoutMs = 2000): SaveFlash {
	let saving = $state(false);
	let saved = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	return {
		get saving() {
			return saving;
		},
		get saved() {
			return saved;
		},
		async run(fn: () => Promise<unknown>): Promise<void> {
			saving = true;
			saved = false;
			if (timer) clearTimeout(timer);
			try {
				await fn();
				saved = true;
				timer = setTimeout(() => {
					saved = false;
				}, timeoutMs);
			} finally {
				saving = false;
			}
		},
	};
}
