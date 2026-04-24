/**
 * Pure decision logic for the chat-window drop zone. Kept separate from the
 * page component so the rules are unit-testable without mounting the whole
 * route tree.
 *
 * The drop zone reuses ChatInput.stageFiles — the exact same path the
 * paperclip button uses — so these helpers only decide *whether* to claim
 * the drag/drop event, not how to stage.
 */

/**
 * True when the chat window should call `preventDefault()` on a `dragover`
 * event. We only claim the event when (1) we have a stage target and (2) the
 * drag actually carries files — otherwise text/selection drags still behave
 * normally.
 */
export function shouldHandleChatWindowDragOver(
	dataTransfer: DataTransfer | null,
	hasStager: boolean,
): boolean {
	if (!hasStager) return false;
	const types = dataTransfer?.types;
	if (!types) return false;
	// DataTransferItemList exposes `includes` via the DOMStringList-like API,
	// but some test environments hand back a plain array. Support both.
	if (typeof (types as unknown as string[]).includes === "function") {
		return (types as unknown as string[]).includes("Files");
	}
	for (let i = 0; i < types.length; i++) {
		if (types[i] === "Files") return true;
	}
	return false;
}

/**
 * Returns the FileList to stage from a `drop` event, or `null` when the drop
 * should be ignored (no stager wired, or no files present).
 */
export function filesFromChatWindowDrop(
	dataTransfer: DataTransfer | null,
	hasStager: boolean,
): FileList | null {
	if (!hasStager) return null;
	const files = dataTransfer?.files;
	if (!files || files.length === 0) return null;
	return files;
}
