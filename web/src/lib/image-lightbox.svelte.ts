class LightboxStore {
	open = $state(false);
	src = $state("");
	alt = $state("");
	originalUrl = $state<string | null>(null);

	show(src: string, alt: string, originalUrl: string | null = null) {
		this.src = src;
		this.alt = alt;
		this.originalUrl = originalUrl;
		this.open = true;
	}

	hide() {
		this.open = false;
		this.src = "";
		this.alt = "";
		this.originalUrl = null;
	}
}

export const lightbox = new LightboxStore();
