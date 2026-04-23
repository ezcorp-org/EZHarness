/**
 * Rebuild conversation-history user messages so attachments uploaded on
 * prior turns are replayed to the model in the current turn.
 *
 * Without this, a user who attached an image on turn N has no way to refer
 * to it on turn N+M — the stored message row only has the typed text, and
 * the `ez-attachment://<id>` handles from turn N's trailing ref block are
 * long gone from the model's context.
 */

import type { AttachmentCapabilities } from "../../providers/model-capabilities";
import { buildUserContent, type PiContentPart, type StagedAttachment } from "./content-builder";
import { listAttachmentsForMessages } from "../../db/queries/attachments";

export interface HistoryUserRow {
	id: string;
	role: string;
	content: string;
}

export async function loadPastAttachments(
	branchMessages: HistoryUserRow[],
): Promise<{ byMessage: Map<string, StagedAttachment[]>; all: StagedAttachment[] }> {
	const byMessage = new Map<string, StagedAttachment[]>();
	const all: StagedAttachment[] = [];
	const userMsgIds = branchMessages.filter((m) => m.role === "user").map((m) => m.id);
	if (userMsgIds.length === 0) return { byMessage, all };
	const rows = await listAttachmentsForMessages(userMsgIds);
	for (const r of rows) {
		const att: StagedAttachment = {
			id: r.id,
			filename: r.filename,
			mimeType: r.mimeType,
			storagePath: r.storagePath,
		};
		all.push(att);
		const list = byMessage.get(r.messageId) ?? [];
		list.push(att);
		byMessage.set(r.messageId, list);
	}
	return { byMessage, all };
}

/**
 * Produce the rebuilt user-message content. On `UnsupportedAttachmentError`
 * (e.g. the user switched to a text-only model after an image turn) we fall
 * back to the raw text — the model loses visibility of the image but the
 * turn doesn't crash.
 */
export async function rehydrateUserMessageContent(
	text: string,
	attachments: StagedAttachment[],
	caps: AttachmentCapabilities,
): Promise<string | PiContentPart[]> {
	if (attachments.length === 0) return text;
	try {
		return await buildUserContent(text, attachments, caps);
	} catch {
		return text;
	}
}
