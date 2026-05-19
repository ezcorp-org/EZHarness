/**
 * Pure logic extracted from AttachmentCard.svelte so it can be unit-tested
 * without a Svelte DOM harness. The component imports these helpers directly.
 */

export type AttachmentKind = "image" | "text" | "pdf" | "audio" | "extension-handle";

export function prettyBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function iconForKind(kind: AttachmentKind): string {
	if (kind === "pdf") return "📄";
	if (kind === "audio") return "🎵";
	if (kind === "text") return "📝";
	if (kind === "image") return "🖼️";
	return "📎";
}

export function attachmentUrl(id: string): string {
	return `/api/attachments/${id}`;
}

export function attachmentDownloadUrl(id: string): string {
	return `${attachmentUrl(id)}?download=1`;
}
