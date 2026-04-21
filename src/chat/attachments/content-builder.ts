/**
 * Build a pi-ai UserMessage.content payload from the user's typed text plus
 * any persisted attachments, applying per-attachment delivery strategies and
 * enforcing model-capability compatibility.
 *
 * pi-ai natively carries only TextContent and ImageContent parts. Non-image
 * rich kinds (PDF today; more later) are bridged into TextContent with a
 * stable <file> wrapper so the assistant can reference them by filename.
 */

import type { AttachmentCapabilities } from "../../providers/model-capabilities";
import { classifyMime, isMimeAccepted } from "../../providers/model-capabilities";
import { readAttachmentBytes } from "./storage";
import { extractPdfText } from "./pdf-extract";

export interface StagedAttachment {
  filename: string;
  mimeType: string;
  storagePath: string;
}

export type TextContent = { type: "text"; text: string };
export type ImageContent = { type: "image"; data: string; mimeType: string };
export type PiContentPart = TextContent | ImageContent;

export class UnsupportedAttachmentError extends Error {
  readonly code = "UNSUPPORTED_ATTACHMENT" as const;
  readonly filename: string;
  readonly mimeType: string;
  constructor(filename: string, mimeType: string) {
    super(`Attachment ${filename} (${mimeType}) is not supported by the selected model`);
    this.filename = filename;
    this.mimeType = mimeType;
  }
}

function fileWrapper(filename: string, mimeType: string, body: string): string {
  const safeName = filename.replace(/"/g, "'");
  return `<file name="${safeName}" type="${mimeType}">\n${body}\n</file>`;
}

function toBase64(bytes: Uint8Array): string {
  // Bun's Buffer handles large arrays without apply-stack overflow.
  return Buffer.from(bytes).toString("base64");
}

export async function buildUserContent(
  text: string,
  attachments: StagedAttachment[],
  caps: AttachmentCapabilities,
): Promise<PiContentPart[] | string> {
  if (attachments.length === 0) return text;

  const parts: PiContentPart[] = [];
  if (text.trim().length > 0) parts.push({ type: "text", text });

  for (const att of attachments) {
    if (!isMimeAccepted(caps, att.mimeType)) {
      throw new UnsupportedAttachmentError(att.filename, att.mimeType);
    }
    const kind = classifyMime(att.mimeType);
    if (!kind) throw new UnsupportedAttachmentError(att.filename, att.mimeType);
    const strategy = caps.deliveryFor[kind];
    if (!strategy) throw new UnsupportedAttachmentError(att.filename, att.mimeType);

    if (strategy === "native-image") {
      const bytes = await readAttachmentBytes(att.storagePath);
      parts.push({ type: "image", data: toBase64(bytes), mimeType: att.mimeType });
    } else if (strategy === "text-inline") {
      const bytes = await readAttachmentBytes(att.storagePath);
      const body = new TextDecoder("utf-8").decode(bytes);
      parts.push({ type: "text", text: fileWrapper(att.filename, att.mimeType, body) });
    } else if (strategy === "pdf-text-extract") {
      const bytes = await readAttachmentBytes(att.storagePath);
      const { text: extracted } = await extractPdfText(bytes);
      parts.push({ type: "text", text: fileWrapper(att.filename, att.mimeType, extracted) });
    } else {
      // audio-native not wired yet; guard by capability table ensures we never
      // reach here in Phase 1.
      throw new UnsupportedAttachmentError(att.filename, att.mimeType);
    }
  }

  return parts;
}
