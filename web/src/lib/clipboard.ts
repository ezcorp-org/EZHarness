/**
 * Copy text to clipboard with fallback for insecure contexts.
 * Returns true on success, false on failure.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
	// Try modern clipboard API first
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Fall through to fallback
		}
	}

	// Fallback: execCommand (works in insecure contexts and iframes)
	try {
		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.style.position = 'fixed';
		textarea.style.left = '-9999px';
		textarea.style.top = '-9999px';
		document.body.appendChild(textarea);
		textarea.select();
		const ok = document.execCommand('copy');
		document.body.removeChild(textarea);
		return ok;
	} catch {
		return false;
	}
}
