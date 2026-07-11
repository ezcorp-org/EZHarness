/**
 * Integration: the handles the builder emits into the LLM-visible text must
 * be the exact strings the resolver consumes when the LLM echoes them back
 * in tool args. If either side changes the wire format, this test fails.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildUserContent,
	type StagedAttachment,
	ATTACHMENT_HANDLE_SCHEME,
} from "../chat/attachments/content-builder";
import { buildAttachmentHandleResolver, toResolvableAttachments } from "../chat/attachments/handle-resolver";
import { writeAttachment } from "../chat/attachments/storage";
import { getCapabilities } from "../providers/model-capabilities";

const PNG_A = new TextEncoder().encode("PNG-A-BYTES");
const PNG_B = new TextEncoder().encode("PNG-B-BYTES");

let root: string;
let pngAPath: string;
let pngBPath: string;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "ezcorp-rt-"));
	pngAPath = (await writeAttachment({
		projectRoot: root, conversationId: "c", messageId: "m",
		filename: "cow.png", mimeType: "image/png", bytes: PNG_A,
	})).storagePath;
	pngBPath = (await writeAttachment({
		projectRoot: root, conversationId: "c", messageId: "m",
		filename: "man.png", mimeType: "image/png", bytes: PNG_B,
	})).storagePath;
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("content-builder ⇄ handle-resolver round trip", () => {
	const vision = getCapabilities("anthropic", "claude-sonnet-4-5");

	test("emitted handles resolve to the exact bytes the attachments hold", async () => {
		const atts: StagedAttachment[] = [
			{ id: "rt-a", filename: "cow.png", mimeType: "image/png", storagePath: pngAPath },
			{ id: "rt-b", filename: "man.png", mimeType: "image/png", storagePath: pngBPath },
		];
		const parts = (await buildUserContent("edit these", atts, vision)) as any[];
		const refBlock = parts[parts.length - 1].text as string;

		// Extract handles from the ref block. Must match the scheme the
		// builder emits AND the pattern the resolver parses — this assertion
		// catches drift between the two.
		const handleRegex = new RegExp(`${ATTACHMENT_HANDLE_SCHEME}[A-Za-z0-9_-]+`, "g");
		const handles = refBlock.match(handleRegex) ?? [];
		expect(handles).toEqual([
			`${ATTACHMENT_HANDLE_SCHEME}rt-a`,
			`${ATTACHMENT_HANDLE_SCHEME}rt-b`,
		]);

		const resolver = buildAttachmentHandleResolver(toResolvableAttachments(atts));
		const resolved = await resolver({ images: handles });
		const out = resolved.images as string[];
		expect(out[0]).toBe(`data:image/png;base64,${Buffer.from(PNG_A).toString("base64")}`);
		expect(out[1]).toBe(`data:image/png;base64,${Buffer.from(PNG_B).toString("base64")}`);
	});

	test("handle embedded inside a prompt string is resolved in-place", async () => {
		const atts: StagedAttachment[] = [
			{ id: "rt-a", filename: "cow.png", mimeType: "image/png", storagePath: pngAPath },
		];
		const parts = (await buildUserContent("", atts, vision)) as any[];
		const refBlock = parts[parts.length - 1].text as string;
		const handle = (refBlock.match(new RegExp(`${ATTACHMENT_HANDLE_SCHEME}[A-Za-z0-9_-]+`)) ?? [])[0]!;

		const resolver = buildAttachmentHandleResolver(toResolvableAttachments(atts));
		const resolved = await resolver({ prompt: `Please use ${handle} as the base.` });
		expect(resolved.prompt).toBe(
			`Please use data:image/png;base64,${Buffer.from(PNG_A).toString("base64")} as the base.`,
		);
	});
});
