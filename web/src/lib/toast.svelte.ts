export interface ToastData {
	id: string;
	type: 'success' | 'error' | 'warning' | 'info';
	message: string;
	action?: { label: string; onclick: () => void };
	dismissAt: number;
}

const MAX_VISIBLE = 3;

class ToastStore {
	toasts = $state<ToastData[]>([]);
	private timers = new Map<string, ReturnType<typeof setTimeout>>();

	add(toast: Omit<ToastData, 'id' | 'dismissAt'>, duration = 5000) {
		// `crypto.randomUUID()` is gated to secure contexts (HTTPS or
		// localhost). Tailscale and other plain-HTTP hosts hit the
		// non-secure path; fall back to a timestamp+random id since we
		// only need uniqueness within the active toast set.
		const id =
			typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
				? crypto.randomUUID()
				: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		const dismissAt = Date.now() + duration;
		const entry: ToastData = { ...toast, id, dismissAt };

		this.toasts = [...this.toasts, entry];

		// Evict oldest if over max
		if (this.toasts.length > MAX_VISIBLE) {
			const oldest = this.toasts[0]!;
			this.remove(oldest.id);
		}

		// Auto-dismiss timer
		const timer = setTimeout(() => this.remove(id), duration);
		this.timers.set(id, timer);

		return id;
	}

	remove(id: string) {
		this.toasts = this.toasts.filter((t) => t.id !== id);
		const timer = this.timers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(id);
		}
	}

	pauseDismiss(id: string) {
		const timer = this.timers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(id);
		}
	}

	resumeDismiss(id: string) {
		const toast = this.toasts.find((t) => t.id === id);
		if (!toast) return;
		const remaining = Math.max(toast.dismissAt - Date.now(), 500);
		const timer = setTimeout(() => this.remove(id), remaining);
		this.timers.set(id, timer);
	}
}

export const toastStore = new ToastStore();

export function addToast(toast: Omit<ToastData, 'id' | 'dismissAt'>, duration?: number) {
	return toastStore.add(toast, duration);
}
