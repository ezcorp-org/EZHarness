/// <reference types="@sveltejs/kit" />
import { version } from "$service-worker";

const CACHE_NAME = `ezcorp-${version}`;

self.addEventListener("install", (event: ExtendableEvent) => {
	// Activate immediately, don't wait for existing clients to close
	(self as unknown as ServiceWorkerGlobalScope).skipWaiting();
});

self.addEventListener("activate", (event: ExtendableEvent) => {
	// Clean old caches from previous versions
	event.waitUntil(
		caches.keys().then((keys) =>
			Promise.all(
				keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
			)
		)
	);
});
