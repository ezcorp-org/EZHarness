/**
 * Parse the MCP server form's headers textarea: one `Name: value` per line.
 * Lines without a colon or without a name are skipped; the value keeps any
 * further colons. Shared by the install form and the detail page's edit form.
 */
export function parseMcpHeaders(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of raw.split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const k = line.slice(0, idx).trim();
		const v = line.slice(idx + 1).trim();
		if (k) out[k] = v;
	}
	return out;
}
