/**
 * A project `icon` can hold either a real image reference (an uploaded
 * `data:` URI, a remote `http(s):` URL, or an app-relative `/…` path) OR a
 * non-URL token — e.g. a Lucide name like "FlaskConical" arriving via the API.
 * Rendering the latter as `<img src>` fires a relative request
 * (`/project/<id>/FlaskConical`) → 404 broken image on every (app) page.
 *
 * Gate every project-icon `<img>` on this predicate; non-URL / empty values
 * fall back to each site's existing letter-avatar (or no-icon) branch.
 */
export function isIconUrl(icon: string | null | undefined): boolean {
	return typeof icon === "string" && /^(https?:|data:|\/)/.test(icon);
}
