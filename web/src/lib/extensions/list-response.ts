/**
 * Accept both supported `/api/extensions` response shapes. Callers still
 * validate the fields they consume because this only normalizes the envelope.
 */
export function extensionListFromResponse(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (
		value &&
		typeof value === "object" &&
		Array.isArray((value as { extensions?: unknown }).extensions)
	) {
		return (value as { extensions: unknown[] }).extensions;
	}
	return [];
}
